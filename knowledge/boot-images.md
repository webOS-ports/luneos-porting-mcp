# Boot Image Construction for LuneOS Ports

How to build, verify and flash LuneOS boot images for the three layout classes: legacy header v2, A12-launch GKI (ramdisk in boot) and A13-launch GKI (ramdisk in init_boot).

Covers header versions and layouts, the kernel/ramdisk window, AVB analysis, the
initramfs overlay technique, the hardware-diagnosed init patches (module ordering,
module cmdline params, userdata resize), debug images, and where every fix now lives.
Flash steps and kits are in installing.md; each device's stock layout is in its device
file. **Always unpack the stock factory image first and
verify the layout — every table below was verified from the actual images, not
assumed.**

---

## Boot header versions

| Header | Android generation | Notes |
|---|---|---|
| v0 | ≤ Android 8 | |
| v1 | Android 9 | |
| v2 | Android 10/11 | adds a `dtb` field (an AOSP dt_table or a bare FDT, per bootloader) |
| v3/v4 | GKI (Android 12+) | v4 adds `boot_signature` for GKI certification; no dtb section exists |

- A11/A12: generic ramdisk in `boot`.
- **A13+ launch devices: `boot` = GKI kernel only; the generic ramdisk moved to
  `init_boot`.** LuneOS replaces both (the stock GKI config is not sufficient, see
  kernel-config.md § The config delta) and leaves `vendor_boot` stock.
- **v1 has no dtb section.** v1 adds only the `recovery_dtbo` fields to v0, so a v1
  image carries its device tree appended to the kernel (`Image.gz-dtb`).
  `kernel_android.bbclass` once split the appended FDT off a v1 kernel and then wrote it
  only for `hv >= 2`: a kernel with no tree, with no error anywhere. The split is now
  `hv == 2` only. An image assembler given a section it has no field for is usually
  silent about it. (Found on fajita; see device-fajita.md.)

Note the class is set by the **launch** Android version, not the running one:
bluejay runs Android 16 but launched on A12, so it has no `init_boot`.

---

## The kernel/ramdisk window — a build-time invariant

A boot header gives the kernel a *budget*, not just an address: the header asks the
bootloader to load the kernel at `base + kernel_offset` and the ramdisk at
`base + ramdisk_offset`, so a kernel longer than the gap overlaps the ramdisk's
load address.

```
window = ramdisk_offset - kernel_offset
```

On the common Qualcomm v0 layout (`base 0x0`, `kernel 0x8000`,
`ramdisk 0x01000000`) that window is **16,744,448 bytes** — and everything in the
kernel image counts, appended device trees included.

**Assert it at build time:**

```sh
python3 - "$IMG" <<'EOF'
import struct, sys
d = open(sys.argv[1], 'rb').read()
ks, ka, rs, ra, ss, sa, ta, ps, hv, ov = struct.unpack('<10I', d[8:48])
end = ka + ks
print(f"kernel {ks:,} B  ends 0x{end:08x}   ramdisk 0x{ra:08x}")
print("OVERLAP" if end > ra else f"fits, {ra-end:,} B spare")
EOF
```

**Whether an overlap matters depends on the bootloader.** Loaders that honour the
header offsets (the older Qualcomm `aboot` and its relatives) can be bound by it.
ABL, the UEFI-based Qualcomm loader that boots header v2 images on Android-10-launch
devices, relocates what it loads, and the offsets are close to advisory: surya
(POCO X3 NFC, SM7150-AC) has the same nominal 16,744,448 B window and its shipping
/e/OS kernel is 17,781,272 B, a megabyte over, booting every day. When a shipping
image for that exact device violates the window, believe the device.

**It has never been shown to cause a failure.** On athena a 24.9 MB image against
the 16.7 MB window coincided with a splash hang and was blamed for it; the splash on
that device never clears, so a dead kernel and a working boot look the same, and the
oversized image was never shown to have failed (see device-athena.md). Treat the
window as a cheap invariant to assert, not a diagnosis to reach for — and an image
that fits is never evidence that something else is the bug.

**Fix the kernel, not the address.** A published-and-working boot image for the
device (a stock ROM, or another distro's port) proves its offsets on that
bootloader. Moving `ramdisk_offset` up to buy room replaces a verified address with
an unverified one — a bad trade while a boot failure is already being debugged.
Shrink the image instead: trim the appended device trees first (usually the biggest
and most pointless chunk — see soc-qualcomm.md § The appended-DTB glob trap), then `CONFIG_IKHEADERS`,
`CONFIG_KALLSYMS_ALL`, vendor debug loggers. `CONFIG_DEBUG_INFO` is a red herring:
it lives in `vmlinux`, not in `Image`. On surya those two levers alone took the
LuneOS kernel inside a window its own vendor kernel overruns (see device-surya.md).

Cross-check the offsets against another project's port of the same SoC before
inventing them. UBports and Droidian both publish them as `deviceinfo`
(`deviceinfo_flash_offset_ramdisk` etc.); Droidian's `kernel-info.mk` calls the same
value `KERNEL_BOOTIMAGE_INITRAMFS_OFFSET`.

## Header v0 with an appended device tree (Qualcomm aboot)

Pre-Android-10 Qualcomm devices append the device trees to the compressed kernel; aboot picks one by `qcom,msm-id`/`qcom,board-id`. Reading them back, the `abootimg` page-size trap and QCDT: soc-qualcomm.md § Header v0/v1 and appended device trees.

## Class 1 — legacy header v2 (no vendor_boot)

No `vendor_boot`, no `init_boot`; often no `super` and A/B slots. The whole first stage
lives in the boot ramdisk, so replacing it with the LuneOS/Halium initramfs replaces the
entire early boot — nothing is merged on top (unlike GKI devices, where vendor_boot
fragments come first). Example: mindphone (MT6739); its stock layout is in
device-mindphone.md.

- Take every header field (base, offsets, page size, cmdline, `os_version`,
  `os_patch_level`) from the stock image, and check the boot partition size.
  **Unresolved:** whether a lower `os_version` than stock is ever refused. mp01, q25 and
  radon keep the stock value as a rule ("never lower"); titanpocket's lk boots an older
  patch level than stock.
- The v2 `dtb` field holds whatever the bootloader parses: an AOSP **dt_table** (magic
  `0xd7b7ab1e`, the `dtbo.img` format) on the MediaTek lk of mindphone, titanpocket and
  sm-t220 (which does not parse a bare FDT), a **bare FDT** on radon's lk and on Qualcomm
  ABL (surya, sunfish). Read the stock image's magic; reuse a stock dt_table verbatim, or
  wrap a self-built dtb with `mkdtboimg.py create`.

```
mkbootimg --header_version 2 --pagesize <stock> \
  --base <stock> --kernel_offset <stock> \
  --ramdisk_offset <stock> --tags_offset <stock> --dtb_offset <stock> \
  --os_version <stock> --os_patch_level <stock> --cmdline "<stock cmdline>" \
  --kernel <zImage|Image.gz> --ramdisk initrd.gz --dtb <stock dt_table> \
  -o boot-luneos.img
```

Sanity-check with `unpack_bootimg.py` and diff the printed header fields against the
stock image. In Yocto, `kernel_android.bbclass` builds it inside the kernel recipe,
taking a prebuilt dt_table via `ANDROID_BOOTIMG_DTB = "file://dt-table.img"`; the
recipe deploys `<image>-<machine>.fastboot` (= boot.img).

### AVB: does the stock vbmeta cover `boot`?

Read the stock `vbmeta.img` (`avbtool info_image`) before flashing. If it is signed with
verification enforced (`flags 0`) and its descriptors chain `boot` — the stock boot.img
then carries its own vbmeta in an `AVBf` footer — a self-built boot image will **not**
verify; with the bootloader unlocked, flash a verification-disabled vbmeta (flags 2 vs
3: see installing.md). MediaTek lk in orange state then boots the unsigned image (soc-mediatek.md § Boot chain:
preloader and lk). An
unsigned hash footer is optional once verification is off.

The opposite case exists too: check whether the community ROM that already boots on the
device ships or writes a vbmeta at all. If it does not, and its boot image carries no
AVB footer, there is nothing to disable. (Found on athena; see device-athena.md.)

### The `skip_initramfs` trap

Many Android 8–10 vendor kernels honour `skip_initramfs` and bypass the packed ramdisk
entirely: a repacked boot.img flashes fine and your init never runs (no gadget, no logs,
stock-looking behaviour). The fix is in the kernel: grep `init/initramfs.c` for
`skip_initramfs`; if the tree offers `CONFIG_INITRAMFS_IGNORE_SKIP_FLAG` (LineageOS trees,
e.g. Sony's sdm660 `common.config` sets it), enable it, otherwise revert the commit that
added the option.

The LuneOS initramfs reads the flag too: its `init.sh` boots Android recovery when
`/proc/cmdline` lacks `skip_initramfs` **and** `/recovery/init` exists, so a ramdisk that
carries an Android recovery boots into it on a bootloader that does not pass the flag.

---

## Class 2 — A12-launch GKI (ramdisk in `boot`)

No `init_boot`. Stock `boot` is header v4; whether it carries the generic ramdisk depends
on the build: bluejay's has the kernel only (ramdisk size 0), the MediaTek MT6789 ones
(q25, mp01) carry a non-zero generic ramdisk (device-q25.md § Boot image).
`vendor_boot` is v4 with its ramdisk fragments (typically a PLATFORM fragment with
first-stage init and a DLKM fragment with the early modules under `lib/modules`) and the
dtb; separate `dtbo.img`, real `super`, a `vendor_dlkm` partition. Example: bluejay
(device-bluejay.md).

**Boot flow consequence:** the bootloader concatenates the vendor_boot fragments first,
then the `boot` ramdisk on top — later cpio entries win. So `boot.img` = our GKI kernel +
**LuneOS initramfs as the boot ramdisk** overrides vendor `/init`, while the DLKM
fragment still lands in `lib/modules` of the merged initramfs: our init can modprobe the
vendor's early modules (UFS!) without shipping any. Flash `boot` and a
verification-disabled vbmeta; vendor_boot/dtbo/vendor/super stay stock.

Read the vendor cmdline out of vendor_boot: it carries bootconfig
(`androidboot.load_modules_parallel=true`, `androidboot.boot_devices=...`) and
`<module>.param=` options that the init must pass to the modules it loads (v3 below).

---

## Class 3 — A13-launch GKI (`init_boot`)

The generic ramdisk lives in its own `init_boot` partition and `boot` holds the kernel
only; the early modules may move from a vendor_boot fragment to their own
`vendor_kernel_boot` partition (with the dtb), and AVB chains `init_boot` separately.
Example: panther (device-panther.md).

Consequence: **two images instead of one** — `boot` gets our GKI kernel with no ramdisk,
`init_boot` our LuneOS initramfs with kernel size 0. `vendor_boot`, `vendor_kernel_boot`,
`dtbo`, `super` stay stock. Merge order still puts the init_boot ramdisk last, so our
`init` wins and `lib/modules` (from vendor_kernel_boot) is there to modprobe.

**Watch the init_boot size** — the partition can be small (8 MB on panther); lz4 instead
of gzip is the escape hatch if the ramdisk grows, but it must be **legacy** lz4 and match
the vendor ramdisk's compression (debugging.md § 1.10 Ramdisk compression must match). The debug image is self-contained
(kernel + ramdisk + `enable_adb`), so it works regardless of what the bootloader does
with `init_boot` during `fastboot boot`.

---

## Initramfs construction: overlay, not repack

Do not unpack-and-repack the base initramfs — that loses ownership/suid. Instead
**concatenate a gzip cpio member** onto the base cpio.gz containing only the
changed files (later cpio entries win). The bluejay ramdisk = base
`initramfs-android-image` cpio.gz + `init-overlay.cpio.gz` with the patched
`init` (later also `halium-boot.sh`). The overlay diff
(`overlay/init-gki-modules.diff` in the build repo) is verified to reproduce the
patched init byte-exact.

An alternative shape worth knowing: Droidian kernels can ship boot-time hook
functions in `debian/initramfs-overlay/scripts/halium-hooks`, executed before
the rootfs loads (documented use cases: encryption and display fixups). That is
a first-class **per-device hook file** doing the same job as our init-overlay
patches — a cleaner home for device quirks than growing the shared `init`
(https://docs.droidian.org/porting-guide/kernel-compilation/).

### Init patch history — three hardware-diagnosed bugs, keep all fixes

**v2 — fixpoint module loader.** The stock LuneOS initramfs loads no early
modules at all (`mount_kernel_modules` is a no-op) — fine on sargo where storage
is built-in, **fatal on GKI devices** (UFS driver is a module). First attempt
insmod'd `/lib/modules/modules.load` in list order → kernel panic
(`exynos4_timer_resources: unable to determine tick clock rate`): `clk_exynos_gs`
at line 15 needs symbols from `cmupmucal` at line 45: **`modules.load` is NOT
dependency-ordered** (kernel-modules.md § `modules.load` is a list, not a dependency
order). v2 made repeated passes over the
remaining list until a pass makes no progress (bluejay: 88/203, 37/115, 26/78),
logging per-pass progress to kmsg and WARNING any module that never loaded
(never silence insmod errors with 2>/dev/null — that hid the diagnosis). Also:
after module load, poll sysfs PARTNAME up to 10 s for `userdata*` — UFS probes
async and `mountroot` has no retry.

**v3 — module cmdline parameters.** Second panic at 2.3 s:
`ufs-pixel-fips140: Invalid module params: first_lba=0 last_lba=0` → `FMP self
test failed`. Root cause: **the kernel applies `module.param=` cmdline options
only to built-ins**; modprobe parses `/proc/cmdline` for loadables, plain
`insmod` does not. `module_cmdline_args()` collects matching `<module>.*=`
tokens from /proc/cmdline for each module and passes them to insmod, treating
`-`/`_` as equivalent in the module name (modprobe semantics: file is
`ufs-pixel-fips140.ko`, cmdline says `ufs_pixel_fips140.`). This also carries
`exynos_drm.panel_name=` for the display.

**v4 — proper upfront dependency resolution.** The fixpoint loop was treating a
symptom: `module-order.py` showed **335 hard-dependency pairs listed backwards
across 99 modules** on bluejay (332 pairs / 107 modules on panther), plus **~15
`softdep pre:` edges** that no symbol dependency implies — and softdeps are
*invisible* to a retry loop (insmod succeeds, it just probes in the wrong order;
`exynos-drm` after `phy-exynos-mipi` and `exynos_pd` after `clk_exynos_gs` are
in that set — display and power-domain ordering). v4 resolves the order up front
the way modprobe does, in ~40 lines of busybox awk: each `modules.dep` line
holds the module's full dependency closure, nearest first and deepest last
(verified self-ordered per build), so emit the line reversed, then the module's
`softdep pre:` entries, then the module itself. The fixpoint loop stays behind
it as a safety net for anything whose dependency ships in `vendor_dlkm` (loaded
later). Verified host-side by extracting the awk back out of `init` and running
it under busybox awk against both devices' real
modules.dep/modules.load/modules.softdep — identical to the independent Python
resolver, 203/204 modules, 0 violations.

### The userdata-resize-on-UFS bug

`resize_userdata_if_needed()` in `halium-boot.sh` computed the partition size
with `case $path in /dev/mmcblk*) … /dev/disk*) …` — but `mountroot` sets
`path=$(readlink -f $part)`, which on a UFS device resolves to **`/dev/sd*`**.
Neither case matches, and the filesystem is silently left at its image size.
Harmless with `fastboot format:ext4 userdata` + push; **fatal to the
shipped-userdata-image flow**, which relies on a small image growing to the
~100 GB partition. Fix: read `/sys/class/block/<dev>/size` (512-byte sectors,
present for every block device including partitions), keep the old greps as
fallback, warn to kmsg if neither yields a size.

### Debug images

Same image + cmdline `enable_adb` → init panics into the initramfs debug shell. Where
the bootloader keeps the header cmdline, the debug image carries `enable_adb` there
(`ANDROID_BOOTIMG_DEBUG_CMDLINE`, `gki_bootimg.bbclass`); where it drops or mangles it
(kernel-config.md § The kernel command line), the debug image is a kernel rebuilt with
`enable_adb` in `CONFIG_CMDLINE` (`LUNEOS_ENABLE_ADB=1`: sargo, sunfish, radon).
**Unresolved:** bluejay's file says the Pixel bootloader drops unrecognised header
arguments, yet the bluejay/panther debug images rely on header `enable_adb`; whether that
works under `fastboot boot` on Tensor is not recorded. On Pixels,
`fastboot boot boot-<dev>-luneos-debug.img` runs it without flashing — that is
the push/rescue channel. If boot fails on any halium device, the initramfs drops to the
same shell behind a USB gadget named "Failed to boot"; with the default
`USB_FUNCTIONS=rndis` that is telnet on `192.168.2.15`, adb only where the machine adds
it (debugging.md § Debug channels).

- MediaTek lk often does not implement `fastboot boot`; there the debug image has to be
  flashed (mp01), and devices with no fastboot at all take it through their flash tool.
- **`fastboot boot` is not the same test as `fastboot flash boot`:** RAM-booting uses
  fastboot's own load addresses, so it will not reproduce a load-address bug. (Found on
  athena; see device-athena.md.)

Heritage note: hybris-boot (the ancestor of Halium's initramfs) signals the boot
*stage* through its debug channel — telnet on port **23** means still in the
initrd (pre-switch_root), port **2323** means post-switch_root, and marker files
(`init_enter_debug` / `init_enter_debug2` on the data partition) halt boot at a
chosen point deliberately (https://github.com/mer-hybris/hybris-boot). The LuneOS
initramfs (`initramfs-scripts-halium` `init.sh`) has the first: on its debug path it
starts telnetd at `192.168.2.15` port 23 and announces the stage in the USB
gadget's iSerial string. There is no halt-boot flag file. The full debug flow is
in debugging.md.

---

## Verification

- Unpack every produced image (`unpack_bootimg.py` for v0–v2; the factory images
  for v3/v4 comparisons) and diff header fields against the stock table for the
  device.
- Expected GKI shapes: header v4, header_size 1584; on an A13-launch device the boot
  image has `ramdisk=0` and the init_boot image `kernel=0`. The Yocto writer and its
  validation: yocto.md § GKI device machines.

---

## Where the fixes live now

- **`initramfs-scripts-halium`** (upstream LuneOS repo): `init.sh` carries the
  dependency-ordered module loader and the cmdline module parameters (verified
  byte-identical to the hand-patched init);
  `0002-halium-size-userdata-from-sysfs-not-proc-partitions.patch` carries the
  resize fix; `0001-halium-find-the-Android-image-instead-of-assuming-whe.patch`
  fixes the "userdata image with only rootfs.img in it does not boot"
  case the flashed-userdata install relies on. Build the initramfs from bitbake to
  get all of them: `MACHINE=<machine> bitbake initramfs-android-image`.
- **`luneos-bootimg-bluejay`** build repo (github.com/Herrie82/luneos-bootimg-bluejay):
  the self-contained hand build of the bluejay boot image, carrying the init patch as
  `overlay/init-gki-modules.diff`; contents: tools.md § build-bootimg.sh.
- **Yocto**: kernel and boot images from bitbake, the writer and the recipes —
  yocto.md § GKI device machines.
