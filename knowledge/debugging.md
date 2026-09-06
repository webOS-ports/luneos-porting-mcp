# LuneOS GSI/GKI Bring-up Debugging Playbook

A stage-by-stage playbook for "the device doesn't come up", distilled from real bring-ups: Pixel 3a (sargo, Halium 9→14/16 GSI), Pixel 6a (bluejay, GKI Tier A), Pixel 7 (panther), and a MediaTek MT6739 32-bit device (mindphone). Every failure mode here was hit on hardware and diagnosed; the fixes named are the ones that shipped. Work through the stages in order — each stage's failures are only visible once the previous stage is cleared, and several of these bugs hide behind one another.

**The install/boot model these stages assume:** `fastboot flash vbmeta --disable-verity --disable-verification`, our `boot.img` (and `init_boot.img` on A13-launch devices), stock `vendor_boot`/`vendor`/`super` untouched, `rootfs.img` + `android-rootfs.img` (the Halium GSI system image) as files inside an unencrypted ext4 `userdata`. The LuneOS initramfs loop-mounts `rootfs.img` as `/`, and the Android container mounts the GSI at `/android` with the device's real `/vendor` bound in.

---

## Stage 0 — Does the kernel even boot?

Nothing on the screen, no adb, device reboots or sits dead. Two tools before anything else:

### Ramoops / pstore console

On a kernel panic the console log survives the reboot in pstore. This is how the bluejay MCT clock panic was diagnosed — the whole `deferred probe timeout` wall and the final
`Kernel panic: exynos4_timer_resources: unable to determine tick clock rate`
were read from the ramoops console dump after the device rebooted. If the device panics and resets, pull the pstore console before touching anything else.

### The debug boot image (`fastboot boot`, no flashing)

Every device kit ships a `boot-<device>-luneos-debug.img`: the same kernel + initramfs with `enable_adb` on the cmdline. `fastboot boot` runs it without flashing (on Pixels this works even for images that would normally live in `init_boot` — the debug image is deliberately self-contained, kernel + ramdisk in one image). With `enable_adb`, init panics into the initramfs adbd debug shell: the device enumerates as a USB gadget named **"Halium initrd — Failed to boot"**. Then:

```
adb shell
cat /dev/kmsg        # live kernel log, includes every initramfs message
```

The same shell appears automatically (without the debug image) when the initramfs itself fails to boot — e.g. `rootfs.img` not found on userdata. If you get the gadget, the kernel and initramfs core are fine; read kmsg to see where boot stopped.

---

## Stage 1 — Initramfs failures

Known failure classes, all hit on hardware:

### 1.1 Module load order — `modules.load` is NOT dependency-ordered

On GKI devices the vendor's early modules (from the `vendor_boot` DLKM fragment or `vendor_kernel_boot`) land in `lib/modules` of the merged initramfs, and our init must load them — the stock LuneOS initramfs loads no early modules at all (fine on sargo where storage is built-in, fatal on GKI devices where even UFS is a module).

**Never assume `modules.load` order is topological.** It is a list, not an order: stock init feeds it to libmodprobe, which resolves `modules.dep` per entry. Measured with `tools/module-order.py`: bluejay has **335 hard-dependency pairs listed backwards** across 99 of 203 modules; panther 332 across 107 of 204. On bluejay, `clk_exynos_gs.ko` sits at line 15 while its symbol exporter `cmupmucal.ko` sits at line 45 — one-pass insmod-in-list-order left the clock driver unloaded, so no clocks → power domains deferred → `deferred probe timeout` wall → MCT timer panic at 11.5 s.

Fix history, worth knowing because the intermediate fix was a trap:
- **v2 (fixpoint loader):** repeated insmod passes until a pass makes no progress. Worked (88/203, 37/115, 26/78 per pass) but treats a symptom — and **`softdep pre:` edges are invisible to a retry loop** (insmod of the dependent *succeeds*, it just probes in the wrong order; `exynos-drm` after `phy-exynos-mipi` and `exynos_pd` after `clk_exynos_gs` are in that set, i.e. display and power-domain ordering).
- **v4 (shipped):** resolve the order up front the way modprobe does, in ~40 lines of busybox awk over `modules.dep` (each line holds the module's full dependency closure, deepest last — emit the line reversed, then `softdep pre:` entries, then the module). Fixpoint loop kept behind it as a safety net for deps that ship in `vendor_dlkm` (loaded later). This lives in `initramfs-scripts-halium` `init.sh` now.
- **Diagnostic lesson:** the original init silenced insmod errors with `2>/dev/null`, which hid the `Unknown symbol cal_clk_* (err -2)` failures completely. Log per-pass progress to kmsg and print a WARNING naming any module that never loaded.

Check any device's module set host-side, no hardware needed:

```
python3 gsigki/tools/module-order.py <lib/modules dir>
```

### 1.2 Module cmdline parameters — the kernel does not pass them to loadable modules

Second bluejay panic, at 2.3 s: `ufs-pixel-fips140: Invalid module params: first_lba=0 last_lba=0` → `Kernel panic: FMP self test failed` (the driver hard-fails when its LBA params are unset).

Root cause: **`module.param=` cmdline options only apply to built-ins.** modprobe/libmodprobe parse `/proc/cmdline` and pass them at load time; plain `insmod` does not. The device cmdline carries `ufs_pixel_fips140.fips_first_lba=30086` etc. (and `exynos_drm.panel_name=…`, which the display needs later).

Fix (init v3, shipped in v4): `module_cmdline_args()` collects matching `<module>.*=` tokens from `/proc/cmdline` for each module and passes them to insmod, **treating `-` and `_` as equivalent in the module name** (modprobe semantics — the file is `ufs-pixel-fips140.ko`, the cmdline says `ufs_pixel_fips140.`).

### 1.3 Async storage probe — poll for userdata

UFS (`ufs-exynos-gs.ko`) probes asynchronously, and `mountroot` has no retry — if storage is late it panics straight to the adb shell. The init patch polls sysfs `PARTNAME` for `userdata*` up to 10 s after module load before proceeding.

### 1.4 userdata never grows on UFS devices

`resize_userdata_if_needed()` in `halium-boot.sh` computed the partition size with a `case $path in /dev/mmcblk*) … /dev/disk*) …` over `/proc/partitions` — but `mountroot` sets `path=$(readlink -f $part)`, which on UFS resolves to **`/dev/sd*`**: neither case matches, the size stays empty, and the filesystem is silently left at its image size. Harmless if you `fastboot format:ext4 userdata` and push files; **fatal to the shipped-userdata-image flow**, which relies on a ~3.6 GB image growing to the ~100 GB partition. Fixed generically: read `/sys/class/block/<dev>/size` (512-byte sectors, present for every block device including partitions), keep the old greps as fallback, warn to kmsg if neither yields a size.

### 1.5 Missing tools, file layout, hotplug

- The initramfs lacked `udevadm` and `dumpe2fs` (`halium-boot.sh` calls both). Boot survives, but settle is skipped and the resize check degrades — add them to `initramfs-android-image`.
- **`android-rootfs.img` must sit NEXT TO `rootfs.img` on userdata** (halium file layout) — not only inside the rootfs. The name matters: `halium-boot.sh` checks `/tmpmnt/android-rootfs.img`. Also note `0001-halium-find-the-Android-image-instead-of-assuming-whe.patch` fixes the "userdata image with only rootfs.img in it does not boot" case.
- mdev hotplug writes `/sys/kernel/uevent_helper`, which needs `CONFIG_UEVENT_HELPER=y` — not in stock GKI configs. Without it, late hotplug events are lost; if by-partlabel links come up empty, this is why. (Added to the LuneOS kernel fragment; KMI-safe.)
- Old forked `machine.conf` files with hardcoded `mmcblk0p*` partition numbers: the modern initramfs discovers partitions by name — stale copy-pasted numbers are mostly harmless (panic path only) but should be deleted.

---

## Stage 2 — Android container failures

The rootfs is up, systemd runs, but HALs / display / radio are dead. This stage has the deepest traps.

### 2.1 Init "stuck" vs "curtailed" — always look for `wait_for_prop` first

Halium patches Android init so the framework never starts, and `on nonencrypted` is dead on a GSI (no fstab → `mount_all` never runs). It is tempting to conclude init stopping after `post-fs-data` is by design. **It usually isn't — look for a `wait_for_prop` gate before concluding anything.**

On sargo, `init.<board>.rc` gates `post-fs-data` on `wait_for_prop vendor.qcom.time.set true`; that property is set by Android's `time_daemon`, which Halium doesn't run. `wait_for_prop` blocks init's state machine outright — everything after it (`early-boot`, `boot`, every `class_start`, every `chown`/`chmod` the vendor HALs depend on) is simply never reached. Setting that **one property** on a running device brought up the whole modem subsystem (`per_mgr`, `per_proxy`, `pd_mapper`, `qcrild`), fixed the vibrator restart loop, zeroed the sensors' QMI errors, and cut EACCES failures in a boot from 50 to 1.

The shipped mechanism (`start-android-hals.sh`) generalizes this: parse every `wait_for_prop` out of the container's rc files, grant a grace period, then force only the stragglers — and keep a `class_start`/`chown` replay as a safety net.

### 2.2 The quoted-property trap

mt6739's vendor rc writes `wait_for_prop hwservicemanager.ready "true"` — **with quotes**, which init's own parser strips. `start-android-hals.sh` harvested gates with awk, which kept the quotes, so the gate never looked satisfied, and after the grace period the script "forced" the literal value `"true"` (quotes included) over the correct one — **wedging every libhidl `WaitForProperty`, i.e. every HIDL `getService`, on host and container**. This was the one true root cause under the mindphone boot-splash hang, hiding beneath several real-but-secondary bugs. Fixed with a gsub in the awk. sargo never triggered it (its vendor gates carry no quotes) — a reminder that "works on device A" proves nothing about the parser.

### 2.3 Container init dies with no trace — the logging black hole

Inside the LXC container, init often has no usable `/dev/kmsg` (the host owns `/dev`; first stage's mknod can fail), so KernelLogger discards every line. Worse, init is built with `REBOOT_BOOTLOADER_ON_PANIC`, so a fatal signal becomes a handled `reboot()` — the kernel records nothing — and a pid namespace delivers that as SIGHUP. All the container manager can say is:

```
Child <pid> ended on signal Hangup(1)
```

Two init patches (in `gsigki/halium16-init-logging-patches/`) close the hole:
1. **Tee every log line to `/dev/socket/init.log`** — the container config bind-mounts `/dev/socket` from the host, so the log outlives the container and is readable from outside after init is gone.
2. **Breadcrumbs before `InitKernelLogging`** — two plain `write()` markers at `FirstStageMain` entry and after the `/dev` setup block, so a death in that window is distinguishable from init never having been exec'd. No-ops outside a Halium container.

This is how the Android 16 GSI's PropertyInit failure was found: the tee captured init's `InitFatalReboot` backtrace naming `prop_area::map_prop_area_rw` — the host's **4M `/dev` tmpfs running out of pages** while mapping one 128K `prop_area` per SELinux property context, of which a 16 GSI has ~557.

### 2.4 Read the container's logcat, not just journalctl

The `/dev/ashmem` case: system booted to `systemctl is-system-running = running`, **0 failed units**, 32 audio sinks, working nyx/ofono — and sat on the bootloader splash forever. Nothing in journalctl. The evidence was **only in the container's logcat**: from Android 12, libcutils opens `/dev/ashmem<boot_id>`, not `/dev/ashmem`; the container's init creates that node inside the container, but hybris runs on the host — every `ashmem_create_region()` failed, so libfmq couldn't allocate, so the HIDL composer's command queue was never created and the compositor sent no display commands at all. Fix: create `/dev/ashmem<boot_id>` on the host (`mount-android.sh`). When the host side looks perfect, go read logcat.

### 2.5 Other container-side failure modes (all real)

| Failure | Cause / fix |
|---|---|
| vndservicemanager aborted, every vendor HAL blocks on `/dev/vndbinder` | A stock vendor's vndservicemanager aborts without selinuxfs — preload `libselinux_stubs` into vndservicemanager (halium device-tree patch; on 32-bit the GSI preloaded it from a hardcoded `/system/lib64/` path and died — fixed in `device/halium/halium_arm`) |
| Boot queue hangs on one bad HAL | `lshal` hangs forever on an unresponsive HAL — `luneos-device-config` runs lshal under a per-call watchdog |
| Dynamic-partition mounts racy/missing nodes | dmsetup/udev race — run `dmsetup mknodes` in `mount-android.sh` |
| Binder calls fail on host | Host needs `/dev/{binder,hwbinder,vndbinder}` symlinks into binderfs |
| `.capex` APEXes silently skipped (conscrypt, media) on a 16 GSI | `mount-apexes.py` cannot mount compressed APEXes — build the GSI with `PRODUCT_COMPRESSED_APEX := false` |
| `/init` aborts instantly on an old (4.9) kernel | `MADV_WIPEONFORK` needs Linux ≥ 4.14 — hybris-patches makes it non-fatal |
| getprop/setprop TLS abort on Android 16 GSI | Needs the Android 16 libhybris adaptation (`Herrie82/libhybris` `herrie/android16-tls`) |
| GPU driver not found | `/vendor/lib{,64}/egl` must be on the linker's default LD paths (same libhybris branch) |
| Container "service not found" for zygote/netd/update_verifier | By design — the Halium GSI strips them. Not a bug. |

---

## Stage 3 — Display and UI

First, distinguish the two black-screen shapes:
- **Stuck on the bootloader splash** with a healthy system underneath → compositor never sent display commands; think ashmem/composer (§2.4), or init gates (§2.1).
- **Screen dark but everything runs** → check the backlight before anything else: on mindphone nothing drives `/sys/class/leds/lcd-backlight` and the panel boots at brightness 0. `echo 200 >` it from a compositor drop-in as a bring-up hack; the real fix belongs in the display service.

Other verified display/UI failure modes:

| Symptom | Cause / fix |
|---|---|
| Compositor blocks forever before starting | `product.env` DRM probe loops forever on DRM-less devices — guard the probe (needs a luna-surfacemanager patch) |
| Wrong/unknown panel geometry | Fallback must read `/sys/class/graphics/fb0/modes` — **NOT `mode`**, which empties once the compositor owns the panel. (mindphone's machine conf claimed 1080x2340; the real panel is 480x800@~187ppi — never trust copy-pasted display constants) |
| Every `eglCreateContext` → `EGL_BAD_ALLOC`, webapps never render | GPU node permissions: `/dev/pvr_sync` and `/dev/ion` needed 0666 (the vendor's own ueventd.rc values) for the WAM user — ship a udev rule |
| QML apps die with "Failed to create wl_display"; webapp-mgr/maliit can't reach wayland | XDG_RUNTIME_DIR mismatch: compositor keeps its socket in `/tmp/luna-session` (surface-manager.env) while apps inherit `/tmp/xdg` from DefaultEnvironment — and `/tmp/xdg` is pulseaudio's dir (different perm domain, can't merge). Durable fix: a tiny always-on watcher `wayland-xdg-link.service` (Type=simple, Restart=always) re-linking `/tmp/xdg/wayland-0 → /tmp/luna-session/wayland-0` every 2 s. **Not** a systemd .path unit — PathExists stays true, a oneshot loops into its start limit |
| Compositor races the vendor HAL at boot | Don't sleep — wait for `IComposer` to actually register on hwbinder |

---

## Stage 4 — Subsystems (wifi, modem, BT, misc)

### Wifi
- A `wifi-module-load.service` modprobing a module that doesn't exist on this device (copy-paste from another port) produces a 2 s restart loop — check whether the driver is built-in (`CONFIG_MTK_COMBO=y` on mindphone: no module to load).
- MTK combo (WMT) pattern: the real drivers are the **stock vendor modules** (`/vendor/lib/modules`: wmt_drv, wmt_chrdev_wifi, wlan_drv_gen2, bt_drv, gps_drv). Their CRCs disagree with a reconfigured kernel (module_layout) — `CONFIG_MODULE_FORCE_LOAD=y` + `modprobe --force` proved safe in practice. Set the firmware path (`firmware_class.path` → `/android/vendor/firmware`) before loading.
- The container's `wmt_loader` needs the MTK connectivity `/dev` nodes exposed to the container; then power-on is `echo 1 > /dev/wmtWifi` **retried until wlan0 exists** (the container wmt daemons patch CONSYS firmware first).
- This is generalized in `meta-android/recipes-core/mtk-connectivity`: three condition-gated units keyed on `ConditionPathExists |wmt_drv.ko |conninfra.ko`, driven by the connectivity subset of the vendor's `modules.load` (grep `wmt|wlan|conn|bt_drv|gps|fmradio`) — no hardcoded module list, inert on non-MTK.

### Modem
- mindphone: `md1.status = "exception"`, RIL daemon stopped. Root cause was **fstab selection**: `mount-android.sh` picked `fstab.enableswap` (sorts before `fstab.mt6739` under the glob), so the modem NV partitions (nvcfg/nvdata/protect1/protect2 — MTK calibration + IMEI) never mounted. Fix: prefer `fstab.$(getprop ro.hardware)`, skip `*.enableswap`. Generic to any multi-fstab MTK device. After the fix: `md1.status=ready`, IRadio em1/em2 registered, ofono `/ril_0` + `/ril_1` both Powered (dual-SIM).
- MTK exposes NV partitions under `/dev/disk/by-partlabel` only (no by-name) — `find_partition_path` must cover that.

### Bluetooth
- Node ownership: the **vendor's** ueventd.rc says `/dev/stpbt` is `bluetooth:bluetooth`; the container's ueventd made it `system:system` → HAL can't open it. Chown in the container, then start the BT HAL (after android-system).
- BT MAC: `bluebinder_post.sh` knows no MTK source; the MAC lives in `/mnt/vendor/nvdata/APCFG/APRDEB/BT_Addr` (first 6 bytes) → write once to `/var/lib/bluetooth/board-address`.

### Misc
- Time-sync UI dead: LunaSysService calls `timedatectl`, which isn't installed until systemd-timedated ships.
- HW keypad ignored by Qt: udev tags it `ID_INPUT_KEY` only; Qt evdevkeyboard discovery needs `ID_INPUT_KEYBOARD` — promote with a udev rule.
- `library "libpq_cust.so" not found` from MTK HWC is benign — the vendor ships `libpq_cust_base.so` and the HAL falls back.

---

## Quick checklist: symptom → likely cause → where to look

| Symptom | Likely cause | Where to look |
|---|---|---|
| Device resets, nothing visible | Kernel panic | pstore/ramoops console dump |
| USB gadget "Halium initrd — Failed to boot" | initramfs couldn't finish (often rootfs.img not found) | `adb shell`, `cat /dev/kmsg` |
| `deferred probe timeout` wall, then timer/clock panic | Module load order — `modules.load` isn't topological | init v4 loader; `tools/module-order.py` |
| Driver panics on unset params (e.g. FMP self test) | `<module>.param=` cmdline not passed to insmod | init `module_cmdline_args()`; compare `/proc/cmdline` |
| Panics to adb only sometimes (storage race) | Async UFS probe, no mountroot retry | PARTNAME poll in init |
| First boot ok, disk full soon after | userdata never resized (`/dev/sd*` case miss) | `halium-boot.sh` resize; `/sys/class/block/<dev>/size` |
| Init "stops" after post-fs-data; HALs missing, EACCES everywhere | `wait_for_prop` gate blocking init's state machine | vendor rc files; `start-android-hals.sh` |
| Every HIDL getService blocks, host + container | Property gate forced with wrong literal (quoted-value trap) | gate values vs `getprop`; the awk harvest |
| "Child ended on signal Hangup(1)", container dead, no logs | Container init died pre-logging | `/dev/socket/init.log` tee + breadcrumb patches |
| 0 failed units, audio up, stuck on boot splash | Host-side ashmem → libfmq → composer queue | **container logcat**, `/dev/ashmem<boot_id>` on host |
| All vendor HALs block on vndbinder | vndservicemanager aborted (selinuxfs) | libselinux_stubs preload patch |
| Boot queue hangs at HAL enumeration | lshal hung on one HAL | per-call watchdog in luneos-device-config |
| Screen dark, system healthy | Backlight at 0 | `/sys/class/leds/lcd-backlight` |
| Compositor never starts on DRM-less device | DRM probe loop | product.env guard |
| Apps: "Failed to create wl_display" | XDG_RUNTIME_DIR split | wayland-0 symlink watcher |
| EGL_BAD_ALLOC everywhere | GPU node perms (ion/pvr_sync) | vendor ueventd.rc values → udev rule |
| Wifi service restart-looping | modprobing a nonexistent module | is the driver built-in? which modules does *this* vendor ship? |
| MTK modem "exception" | Wrong fstab chosen → NV partitions unmounted | `mount-android.sh` fstab selection |
| BT HAL can't open its node | Container ueventd ownership vs vendor ueventd.rc | chown in container |
| by-partlabel links empty | mdev hotplug needs CONFIG_UEVENT_HELPER | kernel fragment |
