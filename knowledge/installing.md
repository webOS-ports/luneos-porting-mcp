# Installing LuneOS on Ported Devices (Flash Kits)

How LuneOS is installed: flash kits that write vbmeta, a boot image (plus init_boot on A13-launch devices) and a userdata image, leaving stock partitions alone.

LuneOS installs without touching the device's `system`, `vendor`, `vendor_boot`, `dtbo` or `super` partitions: you flash a verification-disabled `vbmeta`, a LuneOS boot image (and on A13-launch devices an `init_boot` image), and a `userdata` image containing the LuneOS rootfs and the Halium GSI as plain files. Stock Android's vendor stays in place and provides the HALs; the install is reversible. This document holds the general model, the vbmeta flags, the kit layout, the flash steps per layout class, the other install routes (MediaTek BROM, lk2nd, Samsung Download mode) and the anti-rollback constraints that can brick a device if ignored. Each device's own kit and quirks are in its device file.

## The general model

```
adb reboot bootloader        # or the device's key combo
./install.sh                 # vbmeta (verification off) → boot [→ init_boot] → userdata → reboot
```

- `fastboot flash vbmeta` verification-disabled **when the stock vbmeta chains `boot`** (a self-built boot image never verifies against it). Some bootloaders need none: sargo's unlocked ABL reports but does not enforce, and athena's ROM has no vbmeta to disable (boot-images.md § AVB: does the stock vbmeta cover `boot`?).
- `fastboot flash boot` — and on A13-launch devices also `fastboot flash init_boot` (kernel and ramdisk live in separate partitions there).
- `fastboot flash userdata userdata-luneos.img` — an ext4 image holding `rootfs.img` + `android-rootfs.img`.
- `userdata` must end up **unencrypted** (FBE is on by default from Android 10); flashing the prebuilt ext4 image satisfies this.
- Everything else stays stock on a port that runs over the phone's own vendor. Ports that replace the stock vendor with a LineageOS or /e/OS build (athena, bramble, sunfish, surya, fajita) also flash `vendor` through fastbootd; see the device file. Reverting = reflash stock boot/vbmeta (and vendor) and wipe the files.

## vbmeta: flags 2 vs flags 3

```
avbtool make_vbmeta_image --flags 3 --padding_size 4096 --output vbmeta-disabled.img
```

sets flags 3 (HASHTREE_DISABLED | VERIFICATION_DISABLED), the value to use for new kits.
`--flags 2` sets VERIFICATION_DISABLED only, and also boots: the mindphone kit ships its
stock vbmeta with the flags word set to 2 (sm-t220 likewise).
`fastboot --disable-verity --disable-verification flash vbmeta vbmeta.img` also sets flags
3, as the radon and surya vbmeta images have. An empty unsigned AVB image (256-byte header, `algorithm_type 0`,
zero-padded to 4096) is trivially regenerable, so a kit can ship its own rather than
redistributing a vendor's. Whether a device needs a vbmeta at all, and how to read the
stock one: boot-images.md § AVB: does the stock vbmeta cover `boot`?

## Flash kits

Every fastboot kit has the same pure-fastboot shape — no `fastboot boot` + `adb push` dance:

| File | |
|---|---|
| `boot-<device>-luneos.img` | boot image (A13-launch: kernel only, ramdisk=0) |
| `init_boot-<device>-luneos.img` | A13-launch devices only: ramdisk only |
| `boot-<device>-luneos-debug.img` | kernel + ramdisk + `enable_adb`, for `fastboot boot` only |
| `userdata-luneos.img` | ext4 labeled `userdata` (~3.8 GB), with `rootfs.img` + `android-rootfs.img` side by side |
| `vbmeta.img` | stock copy flashed with verity/verification off, or a generated verification-disabled image |
| `install.sh` | vbmeta → boot [→ init_boot] → userdata → reboot |
| `make-userdata.sh` | rebuilds the userdata image after a rootfs rebuild |
| `luneos_<device>_<yyyymmdd>.tar.gz` | the whole kit, distributable |

Contents of the userdata image:

- `rootfs.img` — the deploy ext4 of `luneos-image-halium-arm64` (universal rootfs, ~2.6–3 GB).
- `android-rootfs.img` — the Halium GSI `system.img` (raw ext4, system-as-root). **The name matters** (`halium-boot.sh` checks `/tmpmnt/android-rootfs.img`), and the halium `file_layout` puts it **next to** `rootfs.img` on userdata. mindphone instead carries it inside `rootfs.img` and boots, so both layouts are in use (device-mindphone.md).

Rebuild command (adjust size):

```
mke2fs -q -F -t ext4 -L userdata -d <dir with rootfs.img> userdata-luneos.img 3600m
```

The small image **grows to the real partition size on first boot** — only with an
initramfs that carries the UFS resize fix (boot-images.md § The userdata-resize-on-UFS
bug). The alternative flow — `fastboot format:ext4 userdata`, `fastboot boot` the debug
image and `adb push` the two images into the mounted partition — still works and
sidesteps the resize path, since the format sizes the filesystem to the partition. Cut
kits from current bitbake images: the bitbake initramfs carries every fix the
flashed-userdata install relies on.

## Flash steps per layout class

The classes are defined in boot-images.md.

**A12-launch GKI (ramdisk in `boot`; e.g. bluejay):** vbmeta → boot → userdata → reboot.
One boot image.

**A13-launch GKI (`init_boot`; e.g. panther):** vbmeta → boot (our GKI kernel, no
ramdisk) → init_boot (our initramfs, kernel=0) → userdata → reboot. `vendor_boot`,
`vendor_kernel_boot`, `dtbo`, `super` stay stock.

**Legacy header v2, A/B, no custom recovery (e.g. mindphone):**

```
adb reboot bootloader            # or the device's key combo
fastboot flashing unlock         # once; needs the OEM-unlock toggle in Android; wipes data
fastboot flash vbmeta   vbmeta-disabled.img
fastboot flash boot_a   boot-luneos-<device>.img
fastboot flash boot_b   boot-luneos-<device>.img
fastboot flash userdata userdata-luneos.img
fastboot reboot
```

Flash **both** boot slots to keep A/B consistent. **Unresolved:** this is not the
practice everywhere: sargo flashes the active slot only (an inactive-slot flash is a silent
no-op there), and q25 and mp01 keep Android on slot A and LuneOS on slot B on purpose.

## Other install routes

### MediaTek BROM/preloader: SP Flash Tool / mtkclient, no fastboot

Some MediaTek devices are flashed only over the BROM/preloader link. The rules (write by name, never `preloader`, nominal scatter sizes, back up `boot_a`/`boot_b`): soc-mediatek.md § Install over BROM/preloader.

### lk2nd (old Qualcomm devices with a Samsung or other locked SBL)

lk2nd sits in the first 512 KiB of `boot`; never dd a boot image over it. Rules and recovery: soc-qualcomm.md § lk2nd.

### Recovery sideload (`luneos-dev-package`)

A recovery zip like hammerhead's and tenderloin's, `adb sideload`ed from the LineageOS recovery or TWRP onto a formatted `/data` (goyavewifi, vince). Its updater script checks neither the mount nor the copy: after a failed unpack it still flashes `boot` and reports success (found on vince; device-vince.md). Verify the rootfs on `/data` before rebooting.

### Samsung Download mode (Odin, TWRP)

Samsung's lk speaks Odin only. What worked (found on SM-T220; see device-sm-t220.md):

- **Unlock once** via Developer options → OEM unlocking, then the Vol Up long-press at
  the Download-mode warning screen. The Knox bit is set.
- **Odin (`odin4` for Linux, built from `main`; the release fails multi-part files)** is
  fine for `boot` and `vbmeta` (unsigned header, verification-disabled flag); do not
  trust it for a multi-GB `userdata` (it left holes in the rootfs image).
  `SW REV CHECK FAIL: [userdata]` on the screen is cosmetic.
- **Boot partition from a running LuneOS:** `dd` the image to `boot`, read it back and
  compare checksums, keep a copy of the old partition.
- **Rootfs through TWRP:** `adb -s <serial> push` to `/data/rootfs.img.new`, verify the
  checksum on the device, then rename the current `rootfs.img` to `rootfs.img.prev` and
  the new file into place. Push over USB, not Wi-Fi ssh. Use `adb -s` always.

## Debug boot images

Every kit ships `boot-<device>-luneos-debug.img`; `fastboot boot` runs it without
flashing. Construction, the exceptions (MediaTek lk without `fastboot boot`) and the
boot-failure gadget: boot-images.md § Debug images.

## Anti-rollback (ARB) — read before flashing anything on a Pixel

Pixel bootloaders enforce anti-rollback: flashing a factory build older than the ARB level
on the device risks a **permanent brick**, including through the inactive-slot fallback, so
keep both slots consistent and never flash older than what is installed. The LuneOS boot
image pairs with a specific stock vendor build (kernel modules, cmdline, vendor HALs):
match the factory image you analysed to what is on the device, and redo the analysis if the
device is on a newer build. Device specifics: device-bluejay.md § Install,
device-panther.md § Install.

## Installer design (luneos-installer)

No installer exists; kits are flashed with their own `install.sh`. The intended
`luneos-installer` (Python, host-side): detect the device (`fastboot getvar product`, `ro.product.device`, `ro.vndk.version` or `ro.vendor.build.version.sdk` — `ro.board.api_level` is a YYYYMM date on A15+ vendors — `ro.boot.slot_suffix`, boot header version from the stock boot.img) → look up `devices/<codename>/deviceinfo`; unknown devices get "generic GKI" mode (pull the stock boot/init_boot off the device, repack with the LuneOS initramfs, warn loudly) → download universal `rootfs.img`, `system-gsi-<vndk>.img`, boot images → flash vbmeta/boot/init_boot, format userdata unencrypted, push the two images → reboot.
