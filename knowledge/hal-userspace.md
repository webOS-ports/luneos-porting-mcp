# Userspace HAL Stack and Per-Subsystem Bring-up

How LuneOS reaches Android vendor HALs (libgbinder glue, libhybris graphics, derivation scripts) and how each subsystem was brought up.

LuneOS talks to Android vendor HALs through the Mer/Sailfish-lineage glue stack (libgbinder-based), libhybris for graphics, and derivation scripts that read the vendor's own configuration instead of shipping per-device files. This file is organised by subsystem. Symptom-first triage (and the container-side traps such as `wait_for_prop`, the quoted-property gate and the ashmem node) lives in debugging.md.

## The stack

| Subsystem | Component | Status |
|---|---|---|
| Graphics | libhybris + `qt6-qpa-hwcomposer-plugin` | working through HIDL HWC2; AIDL composer3 support merged upstream but unproven in any shipping port |
| Modem | `ofono-binder-plugin` (+ `libgbinder`, `libgbinder-radio`, `ofono-conf`) | Jolla's plugin, tracks IRadio HIDL *and* AIDL |
| Audio | `pulseaudio-modules-droid` + `-droid-hidl` + `audiosystem-passthrough` | working (32 sinks on sargo) |
| Bluetooth | `bluebinder` | working via HIDL `IBluetoothHci`; AIDL support unverified |
| Sensors | `sensorfw` + `qtsensors-sensorfw-plugin` | working on HIDL; sensorfwd has an AIDL backend, not yet working on any port (surya: retest after the gbinder ApiLevel fix) |
| GPS | geoclue bbappend → add `geoclue-providers-hybris` | to add |
| Camera / HW video | `droidmedia` + `gst-droid` | replaces `qtubuntu-camera` (UT-era, dead); also gives HW decode to the webruntime |
| Vibrator/LED/deviceinfo | `nyx-modules-hybris` | device info (and GPS); haptics comes from `nyx-modules` on halium (nyx-modules.md § When to flip a module back to the OW implementation) |
| MTP | `mtp-server` | present |
| Android apps | waydroid recipes | present; rides the same GSI/GKI base |
| Android-isms | initrd hacks today; evaluate Halium's `mechanicd` | open |
| APEX | UBports `mount-apexes.py` | required from Android 10 |
| Dynamic partitions | `parse-android-dynparts` + ported `mount-android.sh` | required from Android 10, incl. retrofit layouts |

## HIDL vs AIDL — read the vendor manifest

The vendor manifest (`/vendor/etc/vintf/manifest/`, `/vendor/bin/hw`, `/vendor/lib64/hw`)
is the source of truth; read it from the factory `vendor.img` before assuming anything.
Verified surfaces so far:

| device (vendor) | composer | Bluetooth | sensors | radio | details |
|---|---|---|---|---|---|
| bluejay (A16 bp4a) | HIDL `@2.4::IComposer` (same path as sargo) | AIDL-only `IBluetoothHci` | AIDL multihal v3 | IRadio HIDL 1.6 | device-bluejay.md |
| panther (A16 bp4a) | **AIDL composer3 V4 only** — needs libhybris' composer3 support (PR #578, #609, merged, exposed through the unchanged `hwc2_compat_*` API; no shipping port exercises it yet) | AIDL `IBluetoothHci` | AIDL multihal V3 | AIDL `IRadio*` per slot | device-panther.md |

bluebinder is HIDL; its AIDL support is unverified, so Bluetooth is the first expected
casualty on AIDL-only vendors (not boot-blocking). Gralloc on these vendors is AIDL
allocator v2 + a stable-C mapper; the A16 GSI's libui speaks gralloc5 natively and
**libhybris delegates to libui since PR #509 (Jan 2023)** — the payoff of
"android-headers track the GSI, not the vendor".

**Rule:** every port runs the 16.0 GSI; the vendor's API level picks the VNDK snapshot
inside it (gsi-building.md § VNDK snapshot matrix), and the vendor manifest picks
which HAL transport each subsystem needs — never infer either from the Android version the
device runs. From A15, `ro.board.api_level` is a YYYYMM date; the SDK number is
`ro.vendor.build.version.sdk` (see "Before blaming AIDL" below).

## Graphics

### libhybris fixes discovered on real bring-ups

| Fix | Why | Where |
|---|---|---|
| Android 16 TLS adaptation | TLS abort in every `getprop`/`setprop` on the 16 GSI | TheKit's adaptation, carried on `Herrie82/libhybris` branch `herrie/android16-tls` |
| `/vendor/lib{,64}/egl` added to the linker's default LD paths | GPU driver otherwise not found | same branch |
| `MADV_WIPEONFORK` made non-fatal | `/init` aborts on kernels < 4.14 (sargo's 4.9) | `hybris-patches` `herrie/h16-fixes` |
| Patch 0004 (mindphone): functional `__system_property_find`, `wait`, `read_callback` hooks | they were stubbed (NULL / false / unhooked), breaking property waits | layer + device |
| Patch 0003 (mindphone): q linker missing legacy `StaticTlsLayout::finish_layout` | headers<16 builds | layer + device |

The A12+ ashmem trap (`/dev/ashmem<boot_id>` must exist on the host, or the HIDL composer's
command queue is never created) is in debugging.md § 2.4; it applies to bluejay/panther and
every other A12+ GSI.

### Mali under libhybris

- **Proven in production: Valhall G57/G68** (Volla X23/Quintus/Tablet, FuriPhone FLX1,
  Jolla C2) with A12/A13 blobs.
- **Unproven: big-Valhall G77/G78/G710** (Exynos 2100/2200, Tensor). Nobody has run
  libhybris on a Tensor device — LuneOS would be first.
- **Patch set to carry from day one.** State of `Herrie82/libhybris`
  `herrie/android16-tls` @ `032a289a`:
  - PR #543 / #575 — TLS workaround for A12+ Mali blobs. **NOT in the fork.**
    Still open upstream; Ubuntu Touch, Sailfish, Droidian and FuriLabs ship it.
    Carried in-layer as meta-android `libhybris/0007-hooks-hook-MEOW_get_tls_meow_offset-*.patch`.
  - PR #601 — queueBuffer skip → tearing fix. **Already merged** (`9928c40`).
  - PR #594 + qt5-qpa-hwcomposer-plugin PR #104 — present-fence / buffer-slot.
    libhybris side **already merged** (`f6202e9`); the qt5-qpa side still needs checking.
  - FuriLabs 4a42d42 — WaylandNativeWindow buffer-thrash crash. Not audited.

- **`--enable-mali-quirks` was OFF for every halium machine**, which is the trap:
  the Mali quirk code is all inside `#ifdef MALI_QUIRKS`, and `configure.ac`
  defaults it to `no`. So even the mali-hist-dump commits that *are* in the fork
  (`8792ddc`, `e1d645d`, `417861a`, `31fb3fb`) were compiled out, and PR #543's
  hook would be too. Now in `EXTRA_OECONF` in `meta-android/…/libhybris_git.bb`.
  Inert on non-Mali devices — the hooks only fire when a Mali blob asks.

- **Symptom to recognise** (MP01, Mali-G57, A12 blobs, driver
  `/vendor/lib64/egl/libGLES_meow.so`): compositor SIGSEGVs ~1s after
  `exec surface-manager -platform hwcomposer`, stack
  `libhybris eglInitialize` → `android::egl_display_t::initialize` → **libc**,
  and `si_addr` is **ASCII text** (here `0x74695773656d6140`, `"@amesWit"`).
  A string fragment used as a pointer means the thread pointer was clobbered,
  not a null deref. `libGLES_meow.so` hunts for its pthread TLS slot by scanning
  from the thread pointer; that works on bionic, cannot work on glibc, so it
  falls back to `TLS_SLOT_OPENGL` — which it also uses for something else.
- **Plan B (blob-free):** postmarketOS boots bluejay with panel+touch on a near-mainline
  6.18 kernel via simpledrm (gs101-mainline); Mesa panfrost supports Valhall-JM and gained
  G68 in Aug 2026 but has no G78 model entry yet — "small mesa patch + GPU DT plumbing"
  away, unaccelerated today.

## Derive, don't ship: the start-android-hals mechanism

`start-android-hals.sh` implements the derivations in architecture.md § The adaptation
tier model (HAL services, `wait_for_prop` gates, `chown`/`chmod` replay, waiting for
`IComposer`). The diagnostics behind the first two derivations — init blocked by a `wait_for_prop` gate, and the
quoted-property trap that wedged every HIDL `getService` — are in debugging.md § 2.1 Init "stuck" vs "curtailed" and § 2.2 The quoted-property trap.

**Skip lists come from the device's own adaptation.** `start-android-hals.sh` once sourced
every adaptation's deviceinfo on the rootfs, so the one that sorted last (n2awifi) supplied
everybody's `deviceinfo_android_skip_services`. It now sources the one `luneos-adaptation`
(luneos-device-config) names, after the container's properties are readable.

**The health HAL:** stub it only where no vendor daemon needs `IHealth`. sargo and
mindphone stub it (on sargo `healthd` armed a 60 s alarm that woke the SoC every minute);
sunfish cannot, because its `gnss_service` polls for `IHealth` once a second when it is
missing (device-sunfish.md § Subsystem notes).

### udev rules from the container's own ueventd files — the next derivation to adopt

GPU-node (`pvr_sync`/`ion` 0666) and BT-node (`stpbt` ownership) fixes were both
hand-transcribed from values already sitting in the vendor's `ueventd.rc`. UBports
and Droidian generate the whole rule set from those files instead — pure Tier 0
(https://docs.halium.org/en/latest/porting/debug-build/udev.html,
https://docs.droidian.org/porting-guide/debugging-tips/):

```sh
DEVICE=<codename>
cat /var/lib/lxc/android/rootfs/ueventd*.rc \
    /var/lib/lxc/android/rootfs/vendor/ueventd*.rc | \
  grep ^/dev | sed -e 's/^\/dev\///' | \
  awk '{printf "ACTION==\"add\", KERNEL==\"%s\", OWNER==\"%s\", GROUP==\"%s\", MODE==\"%s\"\n",$1,$3,$4,$2}' | \
  sed -e 's/\r//' > /etc/udev/rules.d/70-$DEVICE.rules
```

Every ueventd node line becomes a udev rule, so node ownership/permissions match what the
vendor HALs expect without a per-device list. Candidate for `luneos-device-config`
generation, replacing one-off per-machine files such as mindphone's `70-mindphone.rules`.

## Binder and gbinder

Everything LuneOS layers over libgbinder — ofono-binder-plugin, bluebinder, sensorfw's
binder path, nfcd — presumes the vendor HAL registered on the binder bus; check that first
with `binder-list` (debugging.md § Stage 4). If the interface is absent, middleware
configuration is irrelevant. If it is present but libgbinder cannot reach it, check
`ApiLevel` below.

### Android 15 vendors are AIDL: the HIDL daemons stop finding anything

An Android 15 vendor registers its HALs with **`servicemanager` (AIDL)**, not
`hwservicemanager` (HIDL). LuneOS daemons that only speak HIDL then fail against
a vendor that is working perfectly. **Before concluding that, confirm libgbinder
speaks the vendor's servicemanager protocol** (next subsection): a wrong
`ApiLevel` produces the same symptoms against AIDL HALs that do exist.

The tell: `servicemanager` logs the AIDL HAL as found while the LuneOS daemon reports
its HIDL backend failing (`biomd: Failed to initialize HIDL fingerprint backend`). A
HIDL-only daemon cannot use a HAL the vendor only publishes on AIDL, whatever the
protocol preset. Found on athena with the LineageOS 22 vendor; the HAL lists and logs
are in device-athena.md § Vendor and GSI.

### Before blaming AIDL: is libgbinder even speaking the right protocol?

**Check this first, on every device, before writing or hunting a backend.** It is
one line of configuration and it invalidates any missing-backend diagnosis when
wrong.

`libgbinder` chooses its servicemanager protocol from `ApiLevel` in
`/etc/gbinder.conf` (or any `/etc/gbinder.d/*.conf`, which override it). It picks
the highest preset **<=** that number, and presets exist only for
**28, 29, 30, 31, 33, 35 and 36** (`gbinder_config.c`). So `ApiLevel = 32`
silently selects the **API 31** preset, and the value must match the **vendor**
the device boots against, not the device's age or the GSI.

`ApiLevel` is an **SDK number**. Which property gives it depends on the vendor:

| vendor | `ro.board.api_level` | use |
|---|---|---|
| up to Android 14 | an SDK number (e.g. 32) | `ro.board.api_level` |
| Android 15+ | a **YYYYMM date** (202404 = A15, 202504 = A16) | `ro.vendor.build.version.sdk` (35 on A15) |
| no board level | — | `ro.vndk.version`, then `ro.build.version.sdk` |

A date written straight into `ApiLevel` is larger than every preset, so it always
selects preset 36 (servicemanager `aidl6`) — an Android 16 protocol against an
A15 vendor that speaks preset 35's `aidl5`. Measured on fajita and surya (both
`ro.board.api_level=202404`, `ro.vendor.build.version.sdk=35`, no
`ro.vndk.version`); see device-fajita.md § Android 15 vendors report a *dated*
API level.

Read the values from the vendor image itself:

```sh
debugfs -R "cat /build.prop" vendor.img | grep -E "ro.vendor.build.version.sdk|ro.board.api_level|ro.vndk.version"
```

**The failure looks exactly like a missing backend.** On sunfish the NFC HAL was
running (`vendor.st_nfc_hal_service`, pid 283), `nfcd` was healthy and had AIDL
support (`nfcd-binder-plugin` 1.2.1, `libgbinder` 1.1.52 = upstream HEAD,
including "Support for AIDL registration notifications"), and the *only* symptom
was:

```
nfcd: [gbinder] WARNING! registerForNotifications(
      android.hardware.nfc.INfc/default) tx error -2147483647
```

with the device on `ApiLevel = 32` (API 31 preset) against an **SDK 36** vendor.
A call whose protocol changed across those levels is precisely what breaks first
while everything else looks fine.

#### The build-time setting cannot serve most devices, and once lied

`GBINDER_API_LEVEL` in `libgbinder.bb` is per-machine and works **only for
machines that build their own rootfs image**. Verified by reading the value back
out of the deployed images rather than trusting metadata:

| machine | own rootfs image? | what shipped |
|---|---|---|
| halium-arm64, halium-arm, mindphone | yes | 32 / 30 / 30 |
| athena | yes (`tar.gz`, no `ext4`) | **35** |
| sargo, sunfish, bramble, bluejay, tangorpro, mp01, tissot-halium, mido-halium | no - they install the shared halium-arm64 image | **32**, always |

And the trap that matters: **every device kit checked (athena, sargo, bluejay,
sunfish) shipped the shared halium-arm64 `rootfs.ext4`**, so athena ran the API
31 preset against an A15 vendor for its entire life *even though its recipe
correctly said 35*. The metadata was right; kit assembly discarded it. Where a
machine builds its own image, package from that image.

#### How it is handled now

`luneos-device-config` resolves the level at boot by the table above (dated
values mapped to `ro.vendor.build.version.sdk`, else 202404→35 and 202504→36,
with a warning for an unknown date) and writes

```
/etc/gbinder.d/10-luneos-device.conf
[General]
ApiLevel = <resolved SDK level>
```

`gbinder_config.c` states outright that *"Files in the config directory overwrite
/etc/gbinder.conf"*, so this serves devices with no image of their own and
self-corrects a stale baked-in value. Verify on-device with:

```sh
journalctl -b | grep -i "gbinder ApiLevel"
```

### Telling a routing bug from a missing backend

`hwservicemanager` being *alive* does not mean HIDL is fine, and its being
unused does not mean it is dead. On athena it ran as pid 34 and successfully
served `android.hardware.camera.provider@2.4::ICameraProvider/legacy/0` in the
same boot where `nfcd` failed - so the transport was healthy and the fault was
elsewhere.

A cheap first discriminator is **the shape of the interface name in the log**:

| style | shape | served by |
|---|---|---|
| HIDL | `android.hardware.foo@1.2::IFoo/default` | `hwservicemanager`, `/dev/hwbinder` |
| AIDL | `android.hardware.foo.IFoo/default` | `servicemanager`, `/dev/binder` |

athena's `nfcd` logged `registerForNotifications(android.hardware.nfc.INfc/default)`,
the same call that failed in sunfish's stale-`ApiLevel` case above, and athena
was on the stale preset too. So fix `ApiLevel` and retest before anything else. Reading the line
as an AIDL name routed to a HIDL `IServiceManager` on `/dev/hwbinder` is
**unverified**; if it survives the correct `ApiLevel`, check which binder node
the call went to — a routing fix is far smaller than a new backend.

`-2147483647` (`INT32_MIN+1`) is not a standard binder exception code
(`EX_TRANSACTION_FAILED` is `-129`), which suggests a local library status
rather than a remote reply - i.e. the call failed before reaching a remote.

## Vendor kernel modules

Let the vendor's own init load them; how its loader finds `vendor_dlkm` in the
container, and the trap that makes it load nothing: kernel-modules.md § The
vendor_dlkm set.

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

## Modem: ofono plugin ladder and config keys

Plugin by Android base (SFOS lineage — https://github.com/mer-hybris/hadk-faq):
`ofono-ril-plugin` (≤7) → `ofono-ril-binder-plugin` (8–10) → **`ofono-binder-plugin`**
(≥10, the one LuneOS ships). Its config lives in `/etc/ofono/binder.d/*.conf`
(`radioInterface` key); a dual-SIM second slot is declared as:

```ini
[ril_1]
transport=binder:name=slot2
name=slot2
```

Per our Tier-0 rule LuneOS *derives* the slot topology from the HAL
(enumerating `IRadio/slotN` on hwservicemanager) rather than hand-writing this file —
but these are the key names the generator must emit.

Modem bring-up failures on the Android side (wrong fstab → NV partitions unmounted, MTK
by-partlabel paths, Qualcomm `bootdevice/by-name` structure) are in debugging.md § Modem.

## Bluetooth

LuneOS reaches the controller through **bluebinder**, which proxies the vendor BT HAL into a
vhci `hci0` for BlueZ.

- **Node ownership and the BT address** come from the vendor: the vendor's ueventd decides
  who owns the BT node, and `bluebinder_post.sh` reads the address from a vendor file. The
  MediaTek case (`/dev/stpbt`, the nvdata `BT_Addr` file): soc-mediatek.md § Connectivity
  combo.
- **BT HAL name is per vendor.** Do not hardcode `bluetooth-1-0`; the MP01 has
  `bluetooth-1-1`. `mtk-bt-bringup.sh` reads it from the vendor rc
  (`service <name> .../android.hardware.bluetooth@*`).
- **Restart order:** stop BlueZ and bluebinder → restart the HAL → start
  bluebinder → start BlueZ. bluebinder holds the HAL binding and does not re-bind by
  itself; restarting the HAL under a connected bluebinder makes it loop on "Remote has
  died", systemd kills it, and the leftover vhci is an `hci0` that will not initialise
  until the whole stack is restarted in order.
- **Controllers that misreport their features** abort hci init (`hci0` DOWN,
  `Can't init device hci0: Invalid request code (56)`). The MT6789 sets page 2 byte 0
  bit 2 (Synchronization Train) but answers Read Synchronization Train Parameters with
  `Unknown HCI Command`: `deviceinfo_bluebinder_ext_features_page_2_mask="0x0400000000000000"`.
  The MT6739 (mindphone) under-reports LE commands: `BLUEBINDER_LOCAL_COMMANDS_SET`.
  The `btmon` method that finds these is in debugging.md § Bluetooth.
- **`BLUEBINDER_LOCAL_FEATURES_MASK 0x0` in bluebinder's log is its own unset setting
  echoed back**, not a reply from the controller.
- **bluebinder's "Own hci index" is an rfkill index, not the hci number.** bluebinder
  records the `idx` of the new `RFKILL_TYPE_BLUETOOTH` switch its vhci creates
  (`bluebinder.c`, `own_hci_index = event.idx`), and rfkill indices grow with every vhci
  registration, so "Own hci index: 1" (or 2, 3 …) says nothing about which `hciN` BlueZ
  uses. Compare `hciconfig -a` with `rfkill list` instead. With `CONFIG_BT_HCIVHCI=y` as
  the only BT transport, `hci0` *is* bluebinder's proxy.
- **rfkill soft-block that comes back:** `systemd-rfkill` restores saved state from
  `/var/lib/systemd/rfkill/` on every boot, so a state saved while blocked re-blocks after
  any manual `rfkill unblock` (`Failed to set mode: Blocked through rfkill (0x12)`).
- **Samsung EFS address:** see soc-qualcomm.md § Samsung EFS and the Bluetooth address.
- **A vendor with no BT service at all.** A LineageOS vendor whose manifest declares
  `android.hardware.bluetooth@1.0` passthrough loaded the HAL in its Bluetooth app; ship the AOSP
  default `android.hardware.bluetooth@1.0-service` and declare it hwbinder (gsi-building.md
  § Before deriving).
- **Qualcomm Rome over UART and `wcnss_filter`.** `libbt-vendor` either opens the UART
  (`/dev/ttyHS0`) itself or asks for the filter with `wc_transport.start_hci=true`. start-android-hals
  force-starts the vendor's disabled `start_hci_filter` regardless; with both on the UART the
  filter eats the controller's answers (`WCNSS_FILTER: handle_soc_events: Unexpected data format`),
  `bt_vendor` waits for ever on `read_vs_hci_event` after `EDL_PATCH_VER_REQ_CMD`, initialize fails
  and bluebinder times out. Then each `close()` aborts the service in
  `BluetoothHci::close()` → `std::__throw_bad_function_call` (close before a successful
  initialize), and hwservicemanager restarts it in a loop. Fix: `start_hci_filter` in
  `deviceinfo_android_skip_services` (an rc override does not stop the script; yocto.md
  § Shipping fixes through /odm). Found on bullhead.

## Sensors

sensorfw talks to the HIDL sensors HAL; sensorfwd also has an AIDL backend, not yet seen
working on any port. On surya's A15 vendor only the AIDL multihal service exists, and the
failure there matched the dated-`ApiLevel` problem above — retest after the gbinder fix
before stubbing anything (device-surya.md).

**Passthrough-only sensors HAL.** With the HIDL backend sensorfwd asks hwservicemanager for
`android.hardware.sensors@2.1`, `2.0` and `1.0` `ISensors/default` ("Could not find …" for each in the
journal) and exits when none is registered. A LineageOS vendor that declares `@1.0` passthrough has
only the impl (`/vendor/lib*/hw/android.hardware.sensors@1.0-impl.so`); ship the AOSP default
`android.hardware.sensors@1.0-service`, declare it hwbinder, and give it the groups for
`/dev/uinput` (`uhid` in the GSI's ueventd, `bluetooth` from host udev) if the HAL opens it.
**Sensor hubs that are flashed at boot** (Nexus 5X nanohub: the vendor's `flash-nanohub-fw` runs
`nanoapp_cmd download`, 50 s in one boot when it had firmware to load): the HAL gives up if it starts while the hub is busy.
Start the service from `on property:init.svc.flash-nanohub-fw=stopped`, in a class start-android-hals
does not force-start, and leave out the rc's `interface` line so a lookup cannot start it early. Also
check the flasher's rc itself: the Nexus 5X's has no `user`, which Android 16 init rejects, so the hub
was never flashed and the kernel logged `nanohub_kthread: err_cnt` every second.

## Text relocations: the Android 16 linker refuses them

Vendor libraries with `TEXTREL` (`readelf -d lib.so | grep TEXTREL`) do not load in a process whose target
SDK is 23 or later. On the A3 only three had them, all camera: libmmcamera_faceproc.so (dlopen()ed by
mm-qcamera-daemon, so its faceproc module silently went missing and the preview stream could not be linked:
"mct_stream_start_link ... Null", "QCameraStream: Failed to config stream" — a white viewfinder) and two
ArcSoft libraries. libpermissioncache_shim.so lowers the process's target SDK to 22 from a constructor;
preload it into the affected services with an rc `override` + `setenv LD_PRELOAD` (direct exec, no shell
wrapper). `android-system-image-legacy-a9-shim.inc` ships just that shim. Scan a new vendor once:
`for f in vendor/lib/*.so vendor/lib/hw/*.so; do readelf -d $f | grep -q TEXTREL && echo $f; done`.

## SoC-specific userspace

What only one SoC family needs lives in its own topic: the MediaTek connectivity combo, the A12 vendor keys, `stp_dump` and MT6789 audio in soc-mediatek.md; legacy Qualcomm vendors (display gaps, HAL1 camera, WCNSS, Samsung EFS, a LineageOS 21 vendor without VNDK) and the Adreno 4xx low-4GB reservation in soc-qualcomm.md.

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

## Wayland socket / XDG_RUNTIME_DIR split

Root cause of "QML apps won't launch" and webapp-mgr/maliit wayland failures: the
compositor keeps its wayland socket in `XDG_RUNTIME_DIR=/tmp/luna-session`
(surface-manager.env), but apps inherit `XDG_RUNTIME_DIR=/tmp/xdg` from
DefaultEnvironment (webos-global.conf) — and `/tmp/xdg` is pulseaudio's dir, claimed
0700, so the two cannot simply be merged (wayland clients get EACCES). `qml-runner` dies
with "Failed to create wl_display" → every QML app defunct. The bridge is a
`/tmp/xdg/wayland-0 → /tmp/luna-session/wayland-0` symlink, which kept getting wiped
(compositor restarts, `/tmp/xdg` recreated by pulse, boot timing).

**Durable fix: `wayland-xdg-link.service`** — a tiny always-on watcher (`Type=simple`,
`Restart=always`) that re-links every 2 s. Deliberately **not** a systemd `.path` unit:
`PathExists` stays true, so a oneshot re-triggers in a loop and hits the start limit.
Verified: symlink removed → restored in <3 s; compositor restart → Phone launches. The
watcher is not in meta-luneos, so the per-service `XDG_RUNTIME_DIR` env files for
webapp-mgr/maliit are still what the layer ships; they become redundant once it is.

## Browser (Atlas) UI scaling

No LuneOS-side configuration fixes a tiny Atlas browser chrome. `webapp-mgr.sh` passes
`--force-device-scale-factor` (from `com.webos.surfacemanager.devicePixelRatio` via configd)
and `run_browser_shell` passes none; adding it does not help, because browser_shell exposes
the factor as a real DPR and resizes its window into CSS units, so the surface disagrees
with luna-surfacemanager and is **cropped**. `--force-device-zoom-level` is silently
ignored. Both fixes belong in Atlas: `document.documentElement.style.zoom` for layout, and
collapsing the fixed-width toolbar while the address bar is focused (measurements on sargo:
device-sargo.md). The zoom value should be **per-device and declared, not derived** —
Calendar, the Enyo apps and Atlas each rejected a "natural" density/160 ratio. Ubuntu
Touch's DeviceInfo registry (`/etc/deviceinfo/devices/<device>.yaml`, a per-device
`GridUnit`; https://docs.ubports.com/en/latest/porting/configure_test_fix/device_info/index.html)
and Droidian's overridable generated notch JSON
(`/usr/lib/droidian/device/phosh-notch/halium.json`) are the same declared-data, Tier 0→2
shape. An env var exported in `run_browser_shell` never reached the process while a flag
in the same edit did — verify before relying on env vars there.
