# deviceinfo Reference (UBports/HGABT format)

LuneOS's Tier 1 adaptation format deliberately reuses the UBports/postmarketOS
`deviceinfo` variable names **verbatim**, so UBports and pmOS device configs can be
consumed directly and fixes contributed back. This file is the missing reference table:
the `halium-generic-adaptation-build-tools` (HGABT) repo has **no README** — the variable
documentation lives in its `deviceinfo.sample`, captured here, plus the extra variables
its `make-bootimage.sh` consumes. A porter writing a LuneOS `devices/<codename>/deviceinfo`
(or translating a Droidian port) should work from this table.

Sources:
- https://gitlab.com/ubports/porting/community-ports/halium-generic-adaptation-build-tools (`deviceinfo.sample`, `make-bootimage.sh`; default branch `main`)
- https://docs.ubports.com/en/latest/porting/build_and_boot/standalone_kernel_build.html
- https://docs.droidian.org/porting-guide/kernel-compilation/ (kernel-info.mk mapping)

## Basic device information

| Variable | Example / meaning |
|---|---|
| `deviceinfo_name` | `"Smartphone 12Pro 5G"` — marketing name |
| `deviceinfo_manufacturer` | `"UBports"` |
| `deviceinfo_codename` | `"yumi"` — the port's identifier everywhere |
| `deviceinfo_arch` | `"aarch64"` (userland arch) |
| `deviceinfo_kernel_arch` | `"arm64"` (kernel ARCH=) |
| `deviceinfo_halium_version` | `"10"` — Halium generation the port targets |
| `deviceinfo_ubuntu_touch_release` | `"24.04-2.x"` — UT-specific; no LuneOS meaning |

## Kernel source, toolchain and build

| Variable | Meaning |
|---|---|
| `deviceinfo_kernel_source` | git URL of the kernel tree |
| `deviceinfo_kernel_source_branch` | branch to build |
| `deviceinfo_kernel_defconfig` | e.g. `halium_yumi_defconfig` |
| `deviceinfo_kernel_cmdline` | boot cmdline (e.g. `console=ttyMSM0,115200n8 … systempart=/dev/mapper/system`) |
| `deviceinfo_kernel_vendor_cmdline` | vendor_boot cmdline (v3/v4 devices), e.g. `bootopt=64S3,32N2,64N2 …` |
| `deviceinfo_kernel_gcc_toolchain_source` | tarball URL of a GCC toolchain (legacy trees), e.g. Linaro 6.3.1 |
| `deviceinfo_kernel_gcc_toolchain_dir` | directory name inside that tarball |
| `deviceinfo_kernel_clang_compile` | `"true"` → build with clang |
| `deviceinfo_kernel_clang_branch` | AOSP clang prebuilt branch, e.g. `android12L-gsi` |
| `deviceinfo_kernel_clang_revision` | e.g. `r416183b` |
| `deviceinfo_kernel_llvm_compile` | `"true"` → LLVM=1 (full LLVM binutils) |
| `deviceinfo_kernel_use_lld` | `"true"` → link with LLD |
| `deviceinfo_kernel_image_name` | build target/artifact: `Image.lz4`, `Image.gz`, `Image-dtb.gz`, `zImage`… (see the Droidian mapping below — the *right* target is per-device) |
| `deviceinfo_kernel_disable_modules` | `"true"` → build everything in, ship no modules |

## Boot image geometry

| Variable | Meaning |
|---|---|
| `deviceinfo_bootimg_header_version` | 0/1/2/3/4 — drives everything else (see below) |
| `deviceinfo_flash_pagesize` | e.g. `4096` (mindphone: 2048) |
| `deviceinfo_flash_offset_base` | mkbootimg `--base` |
| `deviceinfo_flash_offset_kernel` | `--kernel_offset` |
| `deviceinfo_flash_offset_ramdisk` | `--ramdisk_offset` |
| `deviceinfo_flash_offset_second` | `--second_offset` |
| `deviceinfo_flash_offset_tags` | `--tags_offset` |
| `deviceinfo_flash_offset_dtb` | `--dtb_offset` (header v2) |
| `deviceinfo_bootimg_os_version` | `--os_version`, e.g. `11` |
| `deviceinfo_bootimg_os_patch_level` | `--os_patch_level`, e.g. `2022-12-05` |
| `deviceinfo_bootimg_partition_size` | boot partition size in bytes (also enables the AVB footer) |
| `deviceinfo_bootimg_tailtype` | e.g. `SEAndroid` — appended tail magic some bootloaders want |
| `deviceinfo_bootimg_append_vbmeta` | `"true"` → append a vbmeta blob to the image |
| `deviceinfo_bootimg_has_init_boot_partition` | `"true"` on A13-launch devices → produce a separate `init_boot.img` (ramdisk-only) |
| `deviceinfo_init_boot_partition_size` | e.g. `8388608` (8 MB — panther's real constraint) |
| `deviceinfo_vendor_boot_partition_size` | vendor_boot size (sample uses `$((100*$((2**20))))`) |
| `deviceinfo_bootimg_has_vendor_kernel_boot_partition` | `"true"` on devices with a separate `vendor_kernel_boot` (panther-style) |
| `deviceinfo_ramdisk_compression` | `gzip` or `lz4` — the size escape hatch when init_boot headroom runs out |

## dtb / dtbo handling

| Variable | Meaning |
|---|---|
| `deviceinfo_bootimg_prebuilt_dtb` / `deviceinfo_bootimg_dt` | prebuilt dtb file to embed |
| `deviceinfo_dtb_has_dt_table` | `"true"` → the dtb slot wants an AOSP dt_table, so the raw FDT is wrapped via `mkdtboimg.py create` (exactly the mindphone v2 finding — the v2 dtb field is a dt_table, not a bare FDT) |
| `deviceinfo_dtb_id` / `_rev` / `_custom0`–`_custom3` | dt_table entry metadata |
| `deviceinfo_prebuilt_dtbo` | prebuilt `dtbo.img` to flash |
| `deviceinfo_dtbo` | `"true"` → build dtbo from the kernel tree |
| `deviceinfo_dtbo_ids` | e.g. `"0x0 0x1"` — which overlay ids go into dtbo.img |
| `deviceinfo_skip_dtbo_partition` | `"true"` → device has no dtbo partition |
| `deviceinfo_kernel_use_dtc_ext` | use an external dtc (tree's bundled one too old) |
| `deviceinfo_kernel_apply_overlay` | apply a DT overlay at build time (`build-ufdt-apply-overlay.sh`) |

## Ramdisk, recovery, rootfs

| Variable | Meaning |
|---|---|
| `deviceinfo_prebuilt_boot_ramdisk` | filename of a prebuilt Halium boot ramdisk |
| `deviceinfo_prebuilt_boot_ramdisk_source` | where to fetch it (initramfs-tools-halium continuous release, `initrd.img-touch-ARCH`) |
| `deviceinfo_use_unified_recovery` | `"true"` → UT's unified recovery |
| `deviceinfo_unified_recovery_ui_density` | e.g. `mdpi` |
| `deviceinfo_prebuilt_recovery_ramdisk_source` | recovery ramdisk artifact URL (UBports CI) |
| `deviceinfo_recovery_ramdisk_compression` | `gzip` or `xz` |
| `deviceinfo_has_recovery_partition` / `deviceinfo_recovery_partition_size` | separate recovery partition + size |
| `deviceinfo_rootfs_image_sector_size` | e.g. `4096` |
| `deviceinfo_system_partition_size` | e.g. `3584M` |
| `deviceinfo_use_overlaystore` | `"true"` → enable the marker-file overlay store (see architecture notes, Tier 2 prior art) |

`make-bootimage.sh` additionally consumes `deviceinfo_bootimg_board` (mkbootimg
`--board`) and `deviceinfo_vendor_bootconfig_path` (v4 vendor bootconfig).

## How the header version drives image assembly (HGABT behavior)

- **v0/v1** — legacy offsets, optional `--dt` blob appended.
- **v2** — adds the dtb section + `dtb_offset` (the mindphone recipe; dtb is a dt_table).
- **v3/v4** — split images: `boot` = kernel(-only), generic ramdisk either in `boot`
  (A11/A12 launch) or in `init_boot` when `bootimg_has_init_boot_partition=true`
  (A13+ launch); vendor ramdisk fragments + dtb live in `vendor_boot`.
- **v4** — adds vendor bootconfig support.
- When partition sizes are set, **AVB hash footers** are appended to the produced images.

This matches the layout classes documented in the boot-images notes (bluejay = v4
boot-carries-ramdisk, panther = v4 + init_boot + vendor_kernel_boot, mindphone = v2).

## Translating a Droidian port: kernel-info.mk ↔ deviceinfo

Droidian describes the same axes in its per-device `kernel-info.mk`
(https://docs.droidian.org/porting-guide/kernel-compilation/). Equivalences for a porter
moving a Droidian device onto our format:

| kernel-info.mk | deviceinfo / concept |
|---|---|
| `KERNEL_IMAGE_WITH_DTB` + `KERNEL_IMAGE_DTB` | dtb appended to the kernel image (`Image-dtb.gz`-style builds — dtb appended *before* gzip on older trees); pick `deviceinfo_kernel_image_name` accordingly |
| `KERNEL_IMAGE_WITH_DTB_OVERLAY` + dtbo path | `deviceinfo_dtbo` / `deviceinfo_prebuilt_dtbo` / `deviceinfo_dtbo_ids` |
| `KERNEL_IMAGE_PREBUILT_DT` | Samsung-style prebuilt device tree → `deviceinfo_bootimg_prebuilt_dtb` (+ `deviceinfo_dtb_has_dt_table` when the slot wants a dt_table) |
| build target choice `Image` / `Image.gz` / `Image-dtb.gz` | `deviceinfo_kernel_image_name` — per-device, not a taste choice |
| `DTC_EXT=/usr/bin/dtc` | `deviceinfo_kernel_use_dtc_ext` — same escape hatch for ancient bundled dtc |
| `KERNEL_CONFIG_USE_FRAGMENTS=1` (fragments in a `droidian/` dir) | same shape as our `luneos/luneos_defconfig` Kleaf fragment, but for plain-make Tier B trees |
| `KERNEL_CONFIG_USE_DIFFCONFIG` | fragment-vs-defconfig drift checking |
| packaged clang-android-6.0/9.0/10.0/12.0/14.0 (+ gcc-4.9 fallback; "4.4+ should compile with clang") | `deviceinfo_kernel_clang_*` / `_gcc_toolchain_*` — calibrate the toolchain to the tree's era *before* resorting to source patches (cf. the six mindphone rounds) |

Droidian's documented header-version-by-Android mapping (A≤8→v0, A9→v1, A10/11→v2,
GKI→v3+) agrees with ours, and `KERNEL_BOOTIMAGE_DTB_OFFSET` being needed only for v2
confirms the mindphone recipe.

## HGABT script inventory

All in the repo root; entry point `./build.sh -b workdir` (downloads toolchains, clones
the kernel per deviceinfo, builds, packs the boot image):

`build.sh`, `build-kernel.sh`, `make-bootimage.sh`, `make-dtboimage.sh`,
`build-tarball-mainline.sh`, `build-ufdt-apply-overlay.sh`, `common_functions.sh`,
`setup_repositories.sh`, `prepare-fake-ota.sh`, `fetch-and-prepare-latest-ota.sh`
(pull vendor bits out of an OEM OTA), `system-image-from-ota.sh`, and `gsi-port-ci.yml`
— a GitLab CI template for ports, worth cribbing when LuneOS sets up per-device
boot-image CI.

## Cross-references

- Boot-image assembly per layout class, initramfs patches, AVB: see the boot-images notes.
- Kernel fragment content and KMI constraints (what a `deviceinfo`-driven Tier B build
  may set that a Tier A GKI build must not): see the kernel-porting notes.
- Where deviceinfo sits in the adaptation tiers (Tier 1: only what cannot be read off a
  running device): see the architecture notes.
