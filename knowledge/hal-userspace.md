# Userspace HAL Stack and Per-Subsystem Bring-up

LuneOS talks to Android vendor HALs through the Mer/Sailfish-lineage glue stack
(libgbinder-based), libhybris for graphics, and a set of derivation scripts that read the
vendor's own configuration instead of shipping per-device files. This file maps the stack,
records the verified HIDL-vs-AIDL surface of real devices (sargo, bluejay, panther,
mindphone), the libhybris fixes that were needed, the Mali situation, and the
per-subsystem bring-up recipes — especially the MediaTek connectivity work — plus known
display/UI quirks.

## The stack

| Subsystem | Component | Status |
|---|---|---|
| Graphics | libhybris + `qt6-qpa-hwcomposer-plugin` | working through HIDL HWC2; AIDL composer3 support merged upstream but unproven in any shipping port |
| Modem | `ofono-binder-plugin` (+ `libgbinder`, `libgbinder-radio`, `ofono-conf`) | Jolla's plugin, tracks IRadio HIDL *and* AIDL |
| Audio | `pulseaudio-modules-droid` + `-droid-hidl` + `audiosystem-passthrough` | working (32 sinks on sargo) |
| Bluetooth | `bluebinder` | working via HIDL `IBluetoothHci`; AIDL support unverified |
| Sensors | `sensorfw` + `qtsensors-sensorfw-plugin` | working on HIDL; AIDL multihal unverified |
| GPS | geoclue bbappend → add `geoclue-providers-hybris` | to add |
| Camera / HW video | `droidmedia` + `gst-droid` | replaces `qtubuntu-camera` (UT-era, dead); also gives HW decode to the webruntime |
| Vibrator/LED/deviceinfo | `nyx-modules-hybris` | see nyx-modules notes; haptics needs legacy API (headers <11) |
| MTP | `mtp-server` | present |
| Android apps | waydroid recipes | present; rides the same GSI/GKI base |
| Android-isms | initrd hacks today; evaluate Halium's `mechanicd` | open |
| APEX | UBports `mount-apexes.py` | required from Android 10 |
| Dynamic partitions | `parse-android-dynparts` + ported `mount-android.sh` | required from Android 10, incl. retrofit layouts |

## HIDL vs AIDL — verified per device

The vendor manifest (`/vendor/etc/vintf/manifest/`, `/vendor/bin/hw`, `/vendor/lib64/hw`)
is the source of truth; read it from the factory `vendor.img` before assuming anything.

**bluejay (Pixel 6a, Android 16 bp4a vendor) — verified from vendor.img:**

- **Composer: HIDL `@2.4::IComposer`** — Google never IDL-migrated gs101's graphics HALs.
  The legacy passthrough `hwcomposer.gs101.so` and `gralloc.default.so` shim still ship in
  `/vendor/lib64/hw`. Display path is therefore *interface-identical* to the working sargo
  setup (same GSI, same rootfs, same HIDL 2.4).
- Gralloc: AIDL allocator v2 + `mapper.pixel.so` (stable-C mapper5) behind the scenes; the
  A16 GSI's libui speaks gralloc5 natively and **libhybris delegates to libui since
  PR #509 (Jan 2023)** — this is the payoff of "android-headers track the GSI, not the
  vendor". Legacy shim exists as fallback.
- EGL: monolithic `/vendor/lib64/egl/libGLES_mali.so` (+ `vulkan.mali.so`).
- Audio HIDL 7.1 (pulseaudio-droid ✓), IRadio HIDL 1.6 dual-slot (ofono-binder-plugin ✓),
  GNSS HIDL 2.1 brcm (geoclue-hybris ✓), camera provider HIDL 2.7 + media.c2 AIDL +
  OMX 1.0 (droidmedia later ✓).
- **Bluetooth: AIDL-only `IBluetoothHci`** — bluebinder is HIDL; AIDL support unverified.
  BT may be the first casualty; not boot-blocking.
- **Sensors: AIDL multihal v3** — sensorfw's hybris adaptor is HIDL-era; needs checking.
  Not boot-blocking.

**panther (Pixel 7, same bp4a build) — one genuine regression vs bluejay:**

- **Composer: HWC3 / AIDL `android.hardware.graphics.composer3` V4**
  (`hwc3-default.xml`, `android.hardware.composer.hwc3-service.pixel`) — there is **no**
  HIDL composer service on gs201. panther cannot use the sargo/bluejay-proven HIDL
  display path; it needs libhybris' AIDL composer3 support (PR #578 Jan 2026, #609
  Mar 2026 — merged, exposed through the unchanged `hwc2_compat_*` C API so the QPA plugin
  needs zero changes, but **no shipping port exercises it yet**). This is the biggest
  single risk on panther.
- Gralloc, GPU (Mali-G710), audio HIDL 7.1, GNSS HIDL 2.1, camera HIDL 2.7: as bluejay.
- Radio: AIDL `IRadio*` per slot (+ HIDL `@1.2::ISap`) — check ofono-binder-plugin's AIDL
  support. Sensors AIDL multihal V3, BT AIDL `IBluetoothHci` — same caveats as bluejay.

**Rule:** on Halium the vendor API level (`ro.board.api_level` / `ro.vndk.version`) picks
the GSI, and the vendor manifest picks which HAL transport each subsystem needs — never
infer either from the Android version the device runs.

## Mali under libhybris

- **Proven in production: Valhall G57/G68** (Volla X23/Quintus/Tablet, FuriPhone FLX1,
  Jolla C2) with A12/A13 blobs.
- **Unproven: big-Valhall G77/G78/G710** (Exynos 2100/2200, Tensor). Nobody has run
  libhybris on a Tensor device — LuneOS would be first.
- **Patch set to carry from day one.** Audited against `Herrie82/libhybris`
  `herrie/android16-tls` @ `032a289a` on 15 Sep 2026 (MP01 bring-up):
  - PR #543 / #575 — TLS workaround for A12+ Mali blobs. **NOT in the fork.**
    Still open upstream; Ubuntu Touch, Sailfish, Droidian and FuriLabs ship it.
    Carried in-layer as meta-android `libhybris/0007-hooks-hook-MEOW_get_tls_meow_offset-*.patch`.
  - PR #601 — queueBuffer skip → tearing fix. **Already merged** (`9928c40`).
  - PR #594 + qt5-qpa-hwcomposer-plugin PR #104 — present-fence / buffer-slot.
    libhybris side **already merged** (`f6202e9`); the qt5-qpa side still needs checking.
  - FuriLabs 4a42d42 — WaylandNativeWindow buffer-thrash crash. Not audited yet.

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

## libhybris fixes discovered on real bring-ups

| Fix | Why | Where |
|---|---|---|
| Android 16 TLS adaptation | TLS abort in every `getprop`/`setprop` on the 16 GSI | TheKit's adaptation, carried on `Herrie82/libhybris` branch `herrie/android16-tls` |
| `/vendor/lib{,64}/egl` added to the linker's default LD paths | GPU driver otherwise not found | same branch |
| `MADV_WIPEONFORK` made non-fatal | `/init` aborts on kernels < 4.14 (sargo's 4.9) | `hybris-patches` `herrie/h16-fixes` |
| Patch 0004 (mindphone): functional `__system_property_find`, `wait`, `read_callback` hooks | they were stubbed (NULL / false / unhooked), breaking property waits | layer + device |
| Patch 0003 (mindphone): q linker missing legacy `StaticTlsLayout::finish_layout` | headers<16 builds | layer + device |

**The ashmem trap (Android 12+):** from A12, libcutils opens `/dev/ashmem<boot_id>`, not
`/dev/ashmem`. The container's init creates that node inside the container, but hybris
runs on the host — every `ashmem_create_region()` failed, so libfmq could not allocate,
so the HIDL composer's command queue was never created and the compositor sent no display
commands. The system booted to **0 failed units with working audio** and sat on the
bootloader splash; the only evidence was in the container's logcat, not journalctl. Fix:
create `/dev/ashmem<boot_id>` on the host in `mount-android.sh`. Applies to any A12+ GSI
(bluejay/panther included).

## Derive, don't ship: the start-android-hals mechanism

Four sargo problems were each solved by reading the vendor's own configuration at runtime
instead of shipping a per-device file:

| Problem | Naive fix | What LuneOS does instead |
|---|---|---|
| 33 vendor HALs never start | per-device service list | parse `service`/`class` out of the container's own rc files |
| init blocked forever | hardcode `vendor.qcom.time.set` | parse every `wait_for_prop` gate from the rc files, grace-period, force stragglers |
| 50 EACCES on vendor sysfs | per-device chown list | replay `chown`/`chmod` from the init triggers that were never reached |
| compositor races the HAL | per-device sleep | wait for `IComposer` to actually register on hwbinder |

**The stuck-init story (generic diagnostic):** Halium's patched init is not merely
curtailed — on sargo it was *stuck*. `init.<board>.rc` gates `post-fs-data` on
`wait_for_prop vendor.qcom.time.set true`; Android's `time_daemon` (which sets it) is not
run under Halium, so init's state machine blocks and `early-boot`/`boot`/`class_start`
and every `chown`/`chmod` after it never happen. Setting that one property brought up the
modem subsystem, fixed the vibrator restart loop, zeroed the sensors QMI errors, and cut
EACCES failures from 50 to 1. **Any port that finds "init stops after post-fs-data"
should look for a `wait_for_prop` before concluding it is by design.**

**The quoted-property trap (mindphone, mt6739):** `start-android-hals.sh` harvested
`wait_for_prop` gates with awk, keeping the double quotes that init's own parser strips.
mt6739 writes `wait_for_prop hwservicemanager.ready "true"`, so the gate never looked
satisfied and after the grace period the script "forced" the literal value `"true"`
(quotes included) — wedging every libhidl `WaitForProperty` (all HIDL `getService`) on
host and container. This was the single root cause of the boot-splash hang, hiding under
several real-but-secondary bugs. Fixed with a gsub in the awk. sargo never triggered it:
its vendor gates carry no quotes.

**udev rules from the container's own ueventd files — the next derivation to adopt.**
The mindphone GPU-node (`pvr_sync`/`ion` 0666) and BT-node (`stpbt` ownership) fixes were
both hand-transcribed from values already sitting in the vendor's `ueventd.rc`. UBports
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
generation, replacing the one-off `72-mindphone-gpu.rules`-style files.

## Binder plumbing: verify HAL registration before debugging middleware

Everything LuneOS layers over libgbinder — ofono-binder-plugin, bluebinder, sensorfw's
binder path — presumes the vendor HAL actually registered on the binder bus. Check that
first (SFOS hadk-hot, https://sailfishos.wiki/books/hardware/page/hadk-hot):

```sh
binder-list -d /dev/hwbinder | grep IRadio      # modem HAL up?
binder-list -d /dev/hwbinder | grep ISensors    # sensors HAL up?
```

If the interface is absent, ofono/sensorfw configuration is irrelevant — the vendor HAL
is not up; go back to the container (init gates, vndservicemanager). If `binder-list`
shows **nothing at all**, the gbinder **API level** may be wrong for this Android base —
set it in `/etc/gbinder.conf` (valid levels per `gbinder_config.c` in
mer-hybris/libgbinder). Full triage sequence in the debugging notes.

## MediaTek connectivity (mindphone → generic recipe)

The MTK WMT combo driver (wifi/BT/GPS/FM core) is not in the GPL kernel drop — only
built-in adapter shims. The real drivers are stock vendor modules
(`/vendor/lib/modules`: `wmt_drv`, `wmt_chrdev_wifi`, `wlan_drv_gen2`, `bt_drv`,
`gps_drv`) whose CRCs disagree with a reconfigured kernel (`module_layout`), so:
`CONFIG_MODULE_FORCE_LOAD=y` in the kernel fragment, and force-loading proved safe in
practice on this device.

Refactored (2026-08-27) into the **generic recipe
`meta-android/recipes-core/mtk-connectivity`** — the WMT/connac combo is common to the
whole MediaTek family. Three condition-gated systemd units + two helpers, gated on
`ConditionPathExists |wmt_drv.ko |conninfra.ko`, shipped into every halium rootfs via
`android-system RDEPENDS += mtk-connectivity`, inert on non-MTK:

- `mtk-connectivity-modules.service` → `mtk-load-modules.sh`: force-modprobe the
  connectivity subset of `/android/vendor/lib/modules/modules.load`
  (grep `wmt|wlan|conn|bt_drv|gps|fmradio`) — modules.load-driven so it adapts per chip
  generation, no hardcoded list.
- `mtk-connectivity-wifi.service`: retry `echo 1 > /dev/wmtWifi` until `wlan0` exists
  (the container's wmt daemons must patch the CONSYS firmware first; firmware path set to
  `/android/vendor/firmware`).
- `mtk-connectivity-bt.service`: `mtk-bt-address.sh` seeds the BlueZ
  `/var/lib/bluetooth/board-address` from the first 6 bytes of
  `/mnt/vendor/nvdata/APCFG/APRDEB/BT_Addr`, chowns `/dev/stpbt` to
  `bluetooth:bluetooth` inside the container (vendor ueventd.rc says so; container
  ueventd made it system:system), and starts the BT HAL
  (`android.hardware.bluetooth@1.0-service`, driven via bluebinder).

Container node access matters generally: `wmt_loader` could not open `/dev/wmtdetect`
until the MTK connectivity nodes were exposed to the container.

**GKI-era MediaTek (MT6789, MP01, Sep 2026) — what changed:**

- **The modules live in `vendor_dlkm`, not `vendor`.** All three units' conditions
  only checked `/android/vendor/lib/modules`, so on the MP01 every unit was skipped
  with "no trigger condition checks were met". They now also check
  `/android/vendor_dlkm/lib/modules` (`meta-smartphone` `8fd74686`).
- **Load order matters: WiFi and BT modules loaded together in the wrong order
  corrupt the DMASHDL queues the two share** (`RST_FW_DL_FAIL` every ~6 s, forever).
  Follow the vendor's two-stage `init.*.rc` order (`wmt_drv` + `connfem` on boot,
  the rest on `vendor.connsys.driver.ready=yes`), never a generic dependency loader.
- **WiFi power-on races `wmt_launcher`.** `wlan_drv` powers the chip as soon as
  it loads; if `wmt_launcher` has not yet set up the host interface, power-on fails
  with `wmt_core_stp_init: no hif info!` (`-8`) and asserts a whole-chip reset.
  When the reset recovers, BT/WiFi/GPS all come up afterwards and WiFi works;
  when it does not, no `wlan0`. Proper fix (open): power WiFi only after
  `wmt_launcher`'s `WMT_open`.
- **BT HAL name is per vendor.** Do not hardcode `bluetooth-1-0`; the MP01 has
  `bluetooth-1-1`. `mtk-bt-bringup.sh` reads it from the vendor rc
  (`service <name> .../android.hardware.bluetooth@*`).
- **Restart order for BT:** stop BlueZ and bluebinder → restart the HAL → start
  bluebinder → start BlueZ. Restarting the HAL under a connected bluebinder makes
  it loop on "Remote has died", systemd kills it, and the leftover vhci is an
  `hci0` that will not initialise until the whole stack is restarted in order.
- **The MT6789 over-reports Synchronization Train support.** It sets page 2
  byte 0 bit 2 but answers Read Synchronization Train Parameters with
  `Unknown HCI Command`; the kernel aborts hci init, `hci0` stays DOWN
  (`Can't init device hci0: Invalid request code (56)`), BlueZ has no adapter.
  Fix: `deviceinfo_bluebinder_ext_features_page_2_mask="0x0400000000000000"`.
  The MT6739 (mindphone) has the opposite problem — under-reported LE commands,
  fixed with `BLUEBINDER_LOCAL_COMMANDS_SET`. See debugging.md for the `btmon`
  method that finds these.
- **`BLUEBINDER_LOCAL_FEATURES_MASK 0x0` in bluebinder's log is its own unset
  setting echoed back**, not a reply from the controller. Easy to misread as
  "controller dead".

## Vendor kernel modules: let the vendor's init load them

On GKI devices the vendor ships its own loader. MediaTek: `init.mtkgki.rc` starts
`insmod_sh` at `early-init`, and `init.insmod.<hw>.cfg` says `modprobe|*`, i.e.
`modprobe -a -d /vendor/lib/modules $(cat /vendor/lib/modules/modules.load)` —
the full, ordered vendor list, exactly as on stock Android. Halium/UBports
(`mount-android-partitions` + `mount --rbind /android` into the container rootfs)
and Droidian (`vendor_dlkm` at the host's `/vendor_dlkm` + an
`lxc.mount.entry = /vendor_dlkm vendor_dlkm bind`) both just make that path work
and keep **no module list of their own**. Their initramfs loads only the
first-stage list from `vendor_boot` (`/lib/modules/modules.load`, with
`/override/modules.load` as a per-device override).

The trap on LuneOS: `/vendor/lib/modules` is a symlink to
`/vendor_dlkm/lib/modules`. If the host-side `/vendor_dlkm` is an *empty*
directory (the partition was only mounted under `/android/vendor_dlkm`), the lxc
bind puts that empty directory over the real mount inside the container, and
`insmod_sh` silently loads nothing while still setting
`vendor.all.modules.ready=1`. A hand-written allowlist in `mount-android.sh` then
looked necessary, and every subsystem missing from it was dead: on the MP01 that
was audio (`mtk-btcvsd`), and the entire camera stack (`imgsensor_isp6s`,
`camera_isp`, `camera_mem`, the lens and flash drivers, `mtk-vcu`/`mtk_jpeg`/
vcodec).

Fixed in `mount-android.sh`: try `dynpart-<p>_a`/`_b` as well (the device-mapper
name comes from the super metadata, not the booted slot — the MP01 boots b and
gets `_a`), bind `/android/vendor_dlkm` and `/android/odm` onto the host paths if
needed, and default `VENDOR_DLKM_MODULES=none`. With the vendor loader working,
332 modules load and audio, camera, WiFi and cellular all came up in one boot.
Check inside the container: `ls /vendor/lib/modules/modules.load`.

Known hazards of the full list, still worth watching on a new device: the
connsys family (above) and `ccci_md_all`, which once wedged PID 1 on the MP01
(it did not with the vendor's own order).

**Modem (mindphone — a generic multi-fstab MTK bug):** `mount-android.sh` picked
`fstab.enableswap` because it glob-sorts before `fstab.mt6739`, so the modem NV
partitions (`nvcfg`/`nvdata`/`protect1`/`protect2` — MTK calibration + IMEI) never
mounted, `md1.status` stayed "exception" and the RIL daemon stopped. Fix: prefer
`fstab.$(getprop ro.hardware)`, skip `*.enableswap` — belongs upstream. After the fix:
`md1.status=ready`, `vendor.ril-daemon-mtk` running, IRadio@1.0 em1/em2 registered,
ofono sees `/ril_0` + `/ril_1` both Powered (dual-SIM). Note MTK exposes partitions
under `/dev/disk/by-partlabel` only (no by-name) — `find_partition_path` covers that.

**GPU nodes (PowerVR, generic not MTK-specific):** `/dev/pvr_sync` and `/dev/ion` need
0666 (the vendor's own ueventd.rc values) for WAM — without it every `eglCreateContext`
returns `EGL_BAD_ALLOC` and apps never render. Shipped as
`/etc/udev/rules.d/72-mindphone-gpu.rules`.

**Keypad:** udev tags `mtk-kpd` as `ID_INPUT_KEY` only; Qt evdevkeyboard discovery needs
`ID_INPUT_KEYBOARD` → a udev rule promotes it (`71-mindphone-keypad.rules`).

## Audio: pulseaudio-modules-droid quirks and compat shims

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

**MediaTek MT6789 audio:** the sound card only registers once `mtk-btcvsd`
(component `mtk-btcvsd-snd`) is loaded — without it `mt6789-mt6366` defers
forever (`snd_soc_register_card fail -517`). Find the missing component with
`/sys/kernel/debug/devices_deferred` and `/sys/kernel/debug/asoc/components`,
resolving the machine node's phandles against a pulled `/proc/device-tree`. The
DT's `rt5512` speaker amp is a second-source part not populated on the MP01
(`chip id check fail, ret = -6`); the fitted amp is `oca72xxx_pa`. The DL
paths run at 48 kHz (`mtk_afe_fe_hw_params() ... rate 48000`); at pulseaudio's
default 44.1 kHz the HAL resamples and playback sounds slightly off →
`deviceinfo_audio_sample_rate="48000"`. `libsndcardparser.so not found` from
the vendor `libtinycompress.so` is harmless noise. Pulseaudio's unit restarts
five times within a second on a crash and then gives up, taking `audiod` with it.

SFOS splits its pulseaudio plugin by Android base — `pulseaudio-modules-droid-jb2q` for
≤10 vs `pulseaudio-modules-droid` for ≥11 — worth knowing when borrowing their configs.
Debug the daemon directly with `pulseaudio -v`.

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
Verified: symlink removed → restored in <3 s; compositor restart → Phone launches. Once
this ships in the layer, the per-service `XDG_RUNTIME_DIR` env files for
webapp-mgr/maliit become redundant.

## Browser (Atlas) UI scaling — no system-side fix exists

Measured over Chromium's remote debugging port on sargo (1080x2220, 441 PPI):

- `webapp-mgr.sh` passes `--force-device-scale-factor` (from
  `com.webos.surfacemanager.devicePixelRatio` via configd, 2.4 on sargo);
  `run_browser_shell` passes no scale flag — that is the entire difference between
  scaled system UI and a tiny browser chrome.
- Simply adding the flag to browser_shell does not work: WebAppMgr treats the factor as a
  pure rasterisation scale (page keeps a 450 px logical screen, JS sees
  `devicePixelRatio: 1`), while browser_shell exposes it as a real DPR and resizes its
  window into CSS units — the Wayland surface then disagrees with what luna-surfacemanager
  expects and the surplus is **cropped** (toolbar buttons fall off the edge; verified at
  1.5 and 2.75). `--force-device-zoom-level` is silently ignored (Chromium zoom is a
  per-origin preference, not a startup switch).
- **Conclusion: no LuneOS-side configuration fixes this — both fixes belong in Atlas.**
  Fix 1: `document.documentElement.style.zoom` scales layout without touching the surface
  (verified 1.5–2.4; 2.4 preferred by eye). Fix 2: collapse the fixed-width toolbar
  buttons while the address bar is focused *and* release the field's pinned width
  (address bar 115 → 323 device px at zoom 2.4).
- The zoom value should be **per-device and declared, not derived** — three independent
  surfaces (Calendar, the Enyo apps, Atlas) each rejected a "natural" density/160 ratio.
  Ubuntu Touch reached the same conclusion: its **DeviceInfo registry**
  (`/etc/deviceinfo/devices/<device>.yaml`, lowercase filename, auto-selected via Android
  props with `/etc/deviceinfo/default.yaml` as fallback) declares a per-device `GridUnit`
  scaling unit (~23 px/GU at ~440 PPI, 18 on the Nexus 7) alongside `Name`, `DeviceType`,
  `SupportedOrientations`, `PrimaryOrientation` and per-component keys, consumed uniformly
  by Mir/Lomiri/repowerd/pulseaudio-module-droid-discover. (UBports docs,
  https://docs.ubports.com/en/latest/porting/configure_test_fix/device_info/index.html)
  Droidian handles display cutouts the same declared-data way: an auto-generated JSON
  overridable at `/usr/lib/droidian/device/phosh-notch/halium.json` — generated first,
  overridden last, exactly our Tier 0→2 shape; remember it when LuneOS grows notch
  support. (Droidian)
- Side-note from the same session: an env var exported in `run_browser_shell` never
  reached the process while a flag added in the same edit did — something filters that
  environment; verify before relying on env vars in that script.

## Quick triage list (symptom → known cause)

| Symptom | First suspect |
|---|---|
| 0 failed units, audio up, stuck on boot splash | `/dev/ashmem<boot_id>` missing on host (A12+ GSI); evidence only in container logcat |
| All HIDL getService hang, boot splash | quoted `wait_for_prop` value forced verbatim (start-android-hals awk) |
| init stops after post-fs-data; HALs unstarted; EACCES storms | a `wait_for_prop` gate init never clears (e.g. `vendor.qcom.time.set`) |
| Apps render nothing, `EGL_BAD_ALLOC` | GPU nodes (`/dev/pvr_sync`, `/dev/ion`, kgsl equivalents) not world-writable per vendor ueventd.rc |
| QML apps die, "Failed to create wl_display" | XDG_RUNTIME_DIR split; wayland socket symlink missing |
| Modem "exception", RIL dead (MTK) | wrong fstab picked → NV partitions unmounted |
| No wifi on MTK; `wmt_loader` errors | connectivity vendor modules not force-loaded; `/dev/wmtdetect`/`/dev/wmtWifi` not exposed/poked |
| Screen dark but system running | nothing drives the backlight (`/sys/class/leds/lcd-backlight` at 0) |
| Hardware keys ignored by Qt | input node lacks `ID_INPUT_KEYBOARD` udev tag |
| Vendor HAL hangs block boot queue | lshal without a per-call watchdog |
| Audio, camera or other subsystems dead; their modules not loaded (GKI) | container's `/vendor_dlkm` is an empty bind, so the vendor's `insmod_sh` loaded nothing |
| Compositor spins on "failed to get drm master" | Android `charger` holds DRM master (device booted in charger mode), or the compositor opened the HWC a second time (`deviceinfo_force_hwc2`) |
| `QT_QPA_FORCE_HWC2` set but no effect | an `export ` prefix in a systemd `EnvironmentFile=` line — systemd ignores the line |
| Device powers off within a minute while charging | batteryd's critical-percent check on a gauge that reports `capacity=-1` |
| batteryd reports `Charging:false` on the cable | charger `online` is `2` ("online programmable"); nyx only accepted `1` (fixed: any `> 0`) |
| pulseaudio SIGSEGV after "cannot locate symbol ... referenced by /vendor/..." | vendor HAL needs its VNDK: `HYBRIS_PREFER_VNDK` per device |
| `hci0` DOWN, "Invalid request code (56)" | controller rejects a command it advertised (HCI status 0x01); find it with `btmon`, mask it in bluebinder |
| `nfcd` stopped a few minutes after boot | Waydroid's container start runs `systemctl stop nfcd` (meta-luneos waydroid patch 0010 removes it) |
