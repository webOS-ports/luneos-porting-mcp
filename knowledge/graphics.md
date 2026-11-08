# Graphics and Display

How LuneOS draws through vendor GPU blobs: libhybris fixes, Mali, the display smoke test, DRM master, the Wayland socket split and browser scaling.

Symptom-first triage for a black or frozen screen is in debugging.md § Stage 3; GPU and display node permissions come from the vendor's ueventd (hal-userspace.md § udev rules from the container's own ueventd files).

## libhybris fixes discovered on real bring-ups

| Fix | Why | Where |
|---|---|---|
| Android 16 TLS adaptation | TLS abort in every `getprop`/`setprop` on the 16 GSI | TheKit's adaptation, carried on `Herrie82/libhybris` branch `herrie/android16-tls` |
| `/vendor/lib{,64}/egl` added to the linker's default LD paths | GPU driver otherwise not found | same branch |
| `MADV_WIPEONFORK` made non-fatal | `/init` aborts on kernels < 4.14 (sargo's 4.9) | `hybris-patches` `herrie/h16-fixes` |
| Patch 0004 (mindphone): functional `__system_property_find`, `wait`, `read_callback` hooks | they were stubbed (NULL / false / unhooked), breaking property waits | layer + device |
| Patch 0003 (mindphone): q linker missing legacy `StaticTlsLayout::finish_layout` | headers<16 builds | layer + device |

The A12+ ashmem trap (`/dev/ashmem<boot_id>` must exist on the host, or the HIDL composer's
command queue is never created) is in debugging.md § 2.4 Read the container's logcat; it applies to bluejay/panther and
every other A12+ GSI.

## Mali under libhybris

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

## The display smoke-test ladder (SFOS HADK/hadk-hot)

Isolate layers bottom-up with the libhybris test binaries, compositor stopped first (<https://github.com/mer-hybris/hadk-faq>):

1. `EGL_PLATFORM=hwcomposer test_hwcomposer` (as root). A spinning rectangle = EGL + gralloc + composer blobs work under the hybris linker. Segfault → `strace` or `gdb test_hwcomposer` → `bt full`. Runs-but-black → gralloc/copybit.
2. `EGL_PLATFORM=hwcomposer qmlscene -platform hwcomposer main.qml` adds the Qt QPA hwcomposer plugin. Tuning: `QPA_HWC_IDLE_TIME=5`, `QPA_HWC_BUFFER_COUNT=3`; black backgrounds inside working apps → `QT_OPENGL_NO_BGRA=1`.
3. Only then the full compositor.

**surfaceflinger as a bisect oracle:** run the GSI's own `/system/bin/surfaceflinger` (A11+: also `ANDROID_ROOT="/system" /system/bin/bootanimation`). If it renders, kernel + blobs + gralloc/composer are good and the fault is in hybris/QPA; if not, fix the Android side first.

## Charger-mode boots and DRM master

A MediaTek device that is never truly off boots with `androidboot.bootreason=usb` whenever a cable is attached; `init.halium.rc` then starts `/system/bin/charger`, which takes DRM master and never gives it back (`lsof | grep card0`). `start-android-hals.sh` stops it via `DISPLAY_CONFLICT_MATCH` — but there are two copies of that script (`meta-android` and `meta-luneos`; the `meta-luneos` one ships). Diff the deployed file against both before assuming a fix is in.

## Measuring a wrong-sized or cropped window

Client (web apps): WebAppMgr runs Chromium with `--remote-debugging-port=9998`; `adb forward tcp:9998 tcp:9998`, list pages at `http://127.0.0.1:9998/json` and evaluate `screen`, `innerWidth/Height`, `outerWidth/Height`, `devicePixelRatio`, `visualViewport.scale` and `document.hidden` via `Runtime.evaluate` (measure the page with `hidden:false`). Compositor: a temporary `qWarning` in `WebOSSurfaceItem` on `QWaylandSurface::bufferSizeChanged/destinationSizeChanged/sourceGeometryChanged/bufferScaleChanged` and the item's size shows what the client committed against the item; build it from a worktree at the deployed `SRCREV` via a temporary `externalsrc`, push only `libWebOSCoreCompositor.so` from `packages-split/`, and remove the `externalsrc` before building an image. If the compositor side is consistent, the crop is inside Chromium (found on mp01; see device-mp01.md). Screenshots: `luna-send -n 1 luna://com.webos.surfacemanager/captureCompositorOutput '{"output":"/tmp/x.png","format":"PNG"}'` or `/media/internal/screencaptures/`, both in panel orientation.

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

**maliit-server and webapp-mgr abort instead of exiting when the Wayland socket disappears**
("The Wayland connection broke…" → SIGABRT), so each compositor restart leaves their
coredumps behind (found on sargo; device-sargo.md § Idle health).

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
