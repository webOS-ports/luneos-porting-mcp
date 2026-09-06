# Device: bluejay (Google Pixel 6a)

First Tensor LuneOS port (nobody — Halium/UT/Droidian/SFOS — has shipped any Tensor port). GKI Tier A: our own ACK-built kernel + LuneOS initramfs in `boot`, everything vendor-side stock. Working reference for the "one kernel per KMI" model: the same kernel binary serves panther. Working notes: `gsigki/bluejay/bluejay-notes.md`; build repo `~/Documents/GitHub/luneos-bootimg-bluejay`.

## Platform facts (verified from factory image `bluejay-bp4a.251205.006`, Android 16 QPR2)

| Fact | Value |
|---|---|
| SoC / GPU | Google Tensor (gs101) / Mali-G78 (big-Valhall — unproven under libhybris before this port) |
| Launch layout | **A12-launch: no `init_boot`** — `boot` (67 MB), `vendor_boot` (67 MB), `dtbo`, `vendor_dlkm`, real `super` |
| Stock `boot.img` | header **v4, kernel only, ramdisk size 0** |
| Kernel | `6.1.145-android14-11-gc1de4747ac59-ab14219743`, LZ4 Image, clang 17.0.2 → **KMI `android14-6.1`**; `CONFIG_MODVERSIONS=y`, `MODULE_SIG_FORCE` not set |
| `vendor_boot` | v4, two ramdisk fragments: rd00 PLATFORM (25 MB, full stock `/init` + recovery), rd01 DLKM (5.9 MB, 203 early Tensor modules incl. UFS) |
| Console | `ttySAC0` (vendor cmdline); bootconfig `androidboot.load_modules_parallel=true`, `boot_devices=14700000.ufs` |
| Vendor API | `ro.board.api_level=202504`, **no `ro.vndk.version`** (VNDK gone) → pair with the **Halium 16 GSI** |

Boot-flow property everything relies on: the bootloader concatenates vendor_boot fragments first, then the `boot` ramdisk on top (later cpio entries win). So our repacked `boot.img` = GKI kernel + LuneOS initramfs overrides vendor `/init`, while the DLKM fragment still lands in `lib/modules` of the merged initramfs — we modprobe the vendor's early modules (UFS!) without shipping any.

## Anti-rollback — hard constraint

Bootloader ARB was bumped by Android 13 and **again by the May 2025 update**. A device on Android 16 cannot boot anything older than the May-2025 A15 build; flashing older factory images risks a permanent brick (including the inactive-slot fallback trap — keep both slots consistent). **No downgrade ladder on bluejay**: the port targets 6.1 kernel + Android 16 vendor + Halium 16 GSI, full stop.

## Kernel: source, fragment, KMI results

- Source: `repo init -u https://android.googlesource.com/kernel/manifest -b android-gs-bluejay-6.1-android16` (10 GB; tree at `/media/herrie/LuneOS/bluejay-kernel`). Kleaf/Bazel, entry `build_bluejay.sh`; prebuilt GKI is the default — `--config=use_source_tree_aosp` builds `//aosp` from source (needed for any config change).
- LuneOS fragment: `luneos/luneos_defconfig`, applied via `--//build/kernel/kleaf:defconfig_fragment=//luneos:luneos_defconfig`. Archived at `gsigki/bluejay/luneos_defconfig`.
- Stock config (via IKCONFIG → `stock-gki-config-6.1.145-bp4a.txt`): `mer_verify_kernel_config` reports 23 errors / 59 warnings — **gki_defconfig alone is NOT enough**, the delta is small and known (DEVTMPFS+MOUNT, FHANDLE, TMPFS ACL/XATTR, VT, netfilter/PPP/L2TP, etc.).
- **KMI-poison list (final, from CRC bisect): `SYSVIPC` (+`IPC_NS`), `FANOTIFY`, `NET_L3_MASTER_DEV`.** These change core struct layouts under MODVERSIONS — with them on, all 203 stock modules fail (3145 symbol CRCs drift). Everything else in the fragment is KMI-clean (0 drift). Property of GKI, not gs101.
- Userland consequences of the poison list staying off: no SysV IPC (watch Qt QSharedMemory/QSystemSemaphore), no fanotify (systemd fine), no VRF (ofono fine), and **LXC must not unshare the IPC namespace** (PID_NS is available, IPC_NS is not).
- ACK pin bumped to tag `android14-6.1-2026-06_r7` (6.1.172) for the vendor-hook tracepoints `vh_mm.ko`/`vh_sched.ko` need → **203/203 factory modules load, 0 CRC drift**. Caveat: `repo sync` reverts the pin — re-checkout the tag and re-apply the modules.bzl trim. Also `CONFIG_UEVENT_HELPER=y` added (mdev hotplug).
- Kernel comes from the **kernel-only** build (`out-luneos-tierA/`), not the full dist — manifest-pinned google-modules don't compile against 6.1.172 headers (irrelevant for Tier A; if option B is ever needed, build at the manifest-matched 6.1.124 state).
- Verification tools (host-side, no device): `kmi-crc-check.py` (parses `__versions` from stock .kos vs our `Module.symvers`), `symvers-drift.py`, `tools/module-order.py`.

## Boot images & Yocto

- Hand-built artifact: `gsigki/bluejay/boot-bluejay-luneos.img` (23.5 MB, header v4) + `-debug.img` (`enable_adb`). Ramdisk = sargo initramfs base + concatenated gzip overlay containing the patched `init` (module fixpoint→v4 loader, cmdline params, PARTNAME poll).
- Since 4 Sep 2026 the images come out of bitbake: `MACHINE=bluejay bitbake initramfs-android-image` then `luneos-bootimg-gki` → `tmp/deploy/images/bluejay/`. Machinery: `meta-android/lib/halium/bootimg.py` (v3/v4 writer, byte-identical to AOSP mkbootimg for all four shipped shapes), `gki_bootimg.bbclass`, `meta-google/conf/machine/bluejay.conf`, `meta-luneos/…/nyx-modules/bluejay.cmake`. `ANDROID_BOOTIMG_INIT_BOOT = "0"` → single boot image.
- **The GKI kernel deliberately stays outside bitbake**: `PREFERRED_PROVIDER_virtual/kernel = "linux-dummy"`, `GKI_KERNEL_IMAGE` in local.conf points at the `build-bootimg.sh` Image. Rebuilding ACK with OE's toolchain would move MODVERSIONS CRCs and break the stock vendor modules — the whole Tier A property.

## libhybris-on-Tensor feasibility (verdict: feasible)

De-risked by direct vendor.img inspection: composer is **HIDL @2.4::IComposer** (Google never IDL-migrated gs101 graphics; legacy `hwcomposer.gs101.so` + `gralloc.default.so` shims also present) — interface-identical to the working sargo setup. Gralloc: AIDL allocator v2 + `mapper.pixel.so`; the 16 GSI's libui speaks gralloc5 and libhybris delegates to it. EGL: monolithic `/vendor/lib64/egl/libGLES_mali.so` — the sargo default-LD-path fix applies. Audio HIDL 7.1, IRadio HIDL 1.6 dual-slot, GNSS HIDL 2.1, camera HIDL 2.7 — all covered by the existing stack. **One genuine unknown: Mali-G78 blobs under the hybris linker** (production precedent only up to Valhall G57/G68). Carry the Mali patch set from day one: PR #543/#575 (TLS-register leak), #601, #594 + qt5-qpa #104, FuriLabs 4a42d42. Known gaps, not boot-blocking: BT HAL is AIDL-only (bluebinder is HIDL), sensors AIDL v3 multihal; the `/dev/ashmem<boot_id>` host fix applies here too.

## Flash kit

`/media/herrie/LuneOS/bluejay-staging/` — pure-fastboot install (athena/panther parity): `install.sh` flashes vbmeta (verification off) → boot → `userdata-luneos.img` (3,774,873,600 B ext4 with `rootfs.img` + `android-rootfs.img` = Halium 16 GSI side by side; grows on first boot) → reboot. `make-userdata.sh` rebuilds after a rootfs rebuild. Distributable: `luneos_bluejay_20260904.tar.gz`. Only difference from panther: one boot image instead of two (no init_boot).

## Status

Kernel + initramfs boot verified on hardware (two panics diagnosed and fixed: module order → MCT panic; FMP module params). Boot images, KMI verification, flash kit, Yocto machine: done. UI/graphics bring-up on Mali-G78: the open frontier.
