# Audio and Media

Sound through pulseaudio-modules-droid and the vendor audio HAL, its quirks and how to debug them, and the webOS media server path for HTML5 audio and video.

Camera and hardware video go through `droidmedia` + `gst-droid` (hal-userspace.md § The stack); SoC-specific audio (MediaTek MT6789) is in soc-mediatek.md.

## Audio

Known per-device quirk arguments for `pulseaudio-modules-droid` (documented by UBports —
https://docs.ubports.com/en/latest/porting/configure_test_fix/Sound.html — passed as
extra module/card arguments; UT wires them via its DeviceInfo key
`PulseaudioModulesDroid_ExtraCardArgs`, LuneOS passes them wherever the module is loaded):

| Symptom | Argument |
|---|---|
| Audio pitched / tempo-shifted | `rate=48000` (or `rate=44100`) |
| Volume keys / slider do nothing | `hw_volume=false` |
| PulseAudio crashes in a voice call, or the call is silent | `use_legacy_stream_set_parameters=true` |

Two compat shims for awkward vendor audio HALs:

- **HAL cannot be dlopen'd directly** (some vendors): symlink
  `audio.primary.default.so` → `audio.hidl_compat.default.so` — a library implementing
  the legacy audio HAL interface over binder — and keep the vendor's own audio-hal
  service *running* in the container (un-disable it in `init.disabled.rc`). (UBports)
- **32-bit-only audio HAL**: Halium ships a `hidl_compat` audio wrapper in
  `android_vendor_halium_hardware` (halium-10.0 branch), built with
  `make audio.hidl_compat.default` and mounted via systemd units — relevant to
  32-bit ports like mindphone. (SFOS hadk-hot)

**Old vendor, new GSI: the in-process HAL needs the vendor's VNDK.** Halium
disables the vendor's audio HAL *service* (`init.disabled.rc` points
`vendor.audio-hal` at a non-existent `..._DISABLED` binary) because
`module-droid` loads the HAL into pulseaudio itself. With an Android 16 GSI
over an older vendor that load fails on symbols `/system` no longer exports —
MP01 (VNDK 31): `cannot locate symbol "android::base::Basename(std::string
const&)" referenced by /vendor/lib64/libnvram.so`; tissot/mido (VNDK 28):
`set_sched_policy`. libhybris patch 0006 adds `HYBRIS_PREFER_VNDK=1`, which
resolves from the VNDK APEX named by `/vendor/etc/selinux/plat_sepolicy_vers.txt`.
It must stay per device: on sargo (VNDK 32) it makes hybris take `libbinder`
from the APEX, which lacks `get_trace_enabled_tags()` that the GSI's
`libbinder_ndk` needs. VNDK 31's `libbinder` lacks it too, yet pulseaudio ran
fine on the MP01 — so test, do not predict. Set it with a machine drop-in
(own-rootfs machines) or `deviceinfo_hybris_prefer_vndk` (shared rootfs).

**MediaTek MT6789 audio** (the `mtk-btcvsd` card dependency, 48 kHz): soc-mediatek.md § Audio.

`module-droid-hidl` execs `/usr/libexec/audiosystem-passthrough/audiosystem-passthrough`,
so the *runtime* dependency on the package that ships it must exist, not only a build-time
`DEPENDS`.

**Headphone jack.** pulseaudio-modules-droid follows the jack in one of two ways: `droid-extcon`
(an `h2w` switch under `/sys/class/switch`) or, when there is none, `droid-extevdev`, which opens
the first `/dev/input/event*` with `SW_HEADPHONE_INSERT` (the codec's "Headset Jack" input) once,
when the card is created, and marks the headphone/headset ports available. That input belongs to
group `input`, from host udev and the container's ueventd alike, so `pulse` must be in it. It was
not on any Halium machine until meta-luneos added it in `pulseaudio_%.bbappend` (Oct 2026): the
droid module recipes' `GROUPMEMS_PARAM` was never applied (yocto.md § Build failures,
item 6). The tell is `droid-extevdev.c: Unable to open device /dev/input/eventN, ignored:
Permission denied` for every node. Check on a device with `id pulse`, then `evtest
/dev/input/eventN` while plugging in, then `pactl --server unix:/var/run/pulse/native list cards`
for the ports' availability.

SFOS splits its pulseaudio plugin by Android base — `pulseaudio-modules-droid-jb2q` for
≤10 vs `pulseaudio-modules-droid` for ≥11 — worth knowing when borrowing their configs.
Debug the daemon directly with `pulseaudio -v`.

### Vendor libraries that assume Android's zeroed `malloc`

Bionic's allocator hands back zeroed memory for a fresh block. The glibc `malloc`
that libhybris binds to does not: it recycles chunks that start with free-list
pointers. A vendor library that does `buf = malloc(n); strcat(buf, ...)` works on
Android and silently builds a corrupt string under libhybris.

Found on sm-t220 (see device-sm-t220.md): the MediaTek/Samsung `libaudio_param_parser-vnd.so`
(`appGetXmlDirFromProperty`) builds `/vendor/etc/audio_param_huaqin/NA` this way.
The HAL then cannot open its `AudioParamOptions.xml`, logs
`MTK_AUDIO_NUMBER_OF_MIC undefined in AudioParamOptions`, and every feature option
reads as undefined — including the one that selects the speaker amplifiers, so the
amps stay off and the speakers are silent while the headphone path works (the
`MTK_AUDIO_SPEAKER_PATH` mapping is in device-sm-t220.md § Subsystem notes).

How to recognise it: the HAL's own log line above; `Ext_Speaker_Amp_Switch` and the
vendor amp's profile control staying `Off` during real playback; and, decisively,
`strace -f -e trace=openat,newfstatat` on the audio process showing a path with a
few stray bytes in front. Read the code path before the mixer: if the HAL's
selection logic is wrong, no amount of manual mixer setting reproduces what stock
does.

What does not work: setting the property the library writes (it rebuilds the
string itself), `MALLOC_PERTURB_=255` (glibc's thread cache returns blocks without
applying it), and adding `GLIBC_TUNABLES=glibc.malloc.tcache_count=0` on top (the
vendor audio module then failed to load at all). What works is a one-allocation
binary patch, `malloc(512)` → `calloc(512, 1)`, applied at boot to a *copy* of the
device's own library which is then bind-mounted over the vendor path; the SM-T220
layer script checks every instruction word before changing it so another firmware
build is left alone and nothing from the vendor partition is redistributed. Expect
the same class of bug in other vendor libraries: any `malloc` whose result is read
before it is written.

A Samsung 32-bit `awinic.audio.effect.so` that the 64-bit HAL cannot `dlopen` is Awinic's
software speaker-protection DSP, not the amp switch.

## Debugging audio

- Wrong rather than absent (pitched, tempo-shifted, dead volume keys, silent calls): the quirk arguments in § Audio.
- **A deferred ASoC card:** `cat /sys/kernel/debug/devices_deferred` names the card, `/sys/kernel/debug/asoc/components` lists what registered. Pull `/proc/device-tree` with `adb pull`, read the machine node's phandle properties with `od -An -tx1` on the host, and find the node whose `phandle` matches — that names the missing component, and its compatible names the module.
- **PulseAudio dies ~1 s after "Daemon startup complete", status 9/KILL**, no log, no core: trace the kernel's signal generation (tooling appendix). `code=128` (SI_KERNEL) from the sink thread itself was `RLIMIT_RTTIME` expiring on a `SCHED_RR` thread (found on sm-t220).
- **Testing audio with nobody listening:** read the headset jack switch state (`EVIOCGSW` from `python3`; `evtest` is not on the image) and refuse speaker tests unless it reads empty; compare full `amixer contents` dumps during real HAL playback and a manual setup *on the host* (BusyBox `diff` printed nothing for files that differed); `dmesg` lines such as `mtk_pcm_I2S0dl1_prepare` show which PCM the HAL really opened. A microphone loopback gave digital zero — do not rely on it. When a person listens, label each timed variant with a wall-clock time.
- Web-app audio silent with nothing reaching PulseAudio: § webOS media server below.

## webOS media server (umediaserver) on Halium: three independent ways to play nothing

HTML5 audio and video in a web app go WAM → `ums.client` → `umediaserver` →
`g-media-pipeline` → GStreamer → PulseAudio, and a failure at any hop leaves the
page with `MEDIA_ERROR_FORMAT` and PulseAudio with no stream at all. Test the
layers separately: `gst-launch-1.0 filesrc ! wavparse ! ... ! pulsesink
device=pcm_output` proves GStreamer and PulseAudio; then look at `umediaserver`.

1. **`waitid(...pidfd...) failed: Invalid argument`, pooled processes "exited with
   status -1".** The kernel lacks `waitid(P_PIDFD)` (kernel-build.md § `pidfd_open()` without `waitid(P_PIDFD)`).
2. **`execve("/usr/sbin/reference-media-pipeline") = -1 ENOENT`** under
   `strace -f -p $(pidof umediaserver)`. The static
   `/etc/umediaserver/umediaserver_resource_config.txt` names that binary; the tree
   ships `g-media-pipeline`. `dynamic_pipeline_dir` (`/var/lib/ums/conf`) is empty.
   Seen on SM-T220, hammerhead and q25, so it is not per-device.
3. **`POLCAND_FIND_ERR no suitable candidate found`.** A plain WAV asks the resource
   manager for `1 ADEC` and `8 VDEC`; the table has 2 of each. VDEC 16 / ADEC 8 let
   two players (Testr opens two at once) run. The numbers are a judgement.

The player is created when the page loads: after a failed load pressing play later
produces no log line at all, so relaunch the app with the trace already attached.
