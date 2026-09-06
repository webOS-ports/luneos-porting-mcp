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
- **Patch set to carry from day one** (check whether the rootfs's Herrie82/libhybris
  `herrie/android16-tls` build already includes them):
  - PR #543 / #575 — TLS-register leak workaround for A12+ Mali blobs (still open
    upstream; shipped by Droidian/FuriLabs)
  - PR #601 — queueBuffer skip → tearing fix
  - PR #594 + qt5-qpa-hwcomposer-plugin PR #104 — present-fence / buffer-slot
  - FuriLabs 4a42d42 — WaylandNativeWindow buffer-thrash crash
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
