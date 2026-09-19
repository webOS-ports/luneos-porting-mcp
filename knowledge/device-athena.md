# Device: athena (BlackBerry KEY2, SDM660) — Tier B, and the boot-image window

The first SDM660 / BlackBerry target, and the port that produced the **boot-image window rule** in boot-images.md. A 4.19 kernel forked to `shr-distribution/linux` branch `key2/4.19` builds clean under Yocto with GCC 15; the Android-15 vendor from a third-party ROM serves a Halium 16 GSI with **zero VNDK work**. First hardware attempt hung at the splash — cause identified as the kernel image overrunning the ramdisk load address. Pre-boot as of Sep 2026.

## Platform facts

| Fact | Value |
|---|---|
| Model | BlackBerry KEY2, **BBF100-8** (TCL), launched Jun 2018 |
| SoC | Qualcomm **SDM660**, arm64, Adreno 512 — `qcom,msm-id 0x13d`, `qcom,board-id 0xde000008` |
| Display | 4.5" **1080×1620** (3:2), ~433 ppi computed; LineageOS buckets it `TARGET_SCREEN_DENSITY := 384` |
| Stock Android | **8.1**, vendor API level 27 |
| Partitions | **non-A/B**, **no `super`**, real `recovery`; Qualcomm, so `/dev/block/bootdevice/by-name/*` exists |
| boot partition | 64 MiB |
| userdata | `fileencryption=ice` in stock fstab (Qualcomm ICE FBE) |
| Input | physical QWERTY `stmpe-keypad-bbry` (doubles as a trackpad); focaltech FT8707 **and** `synaptics_dsx_bbry` touch |
| Wifi/BT | `qcwcn` / WCN3990-class; `BOARD_HAS_QCA_FM_SOC := "cherokee"` |

**Variant warning:** SDM636 KEY2s exist (`msm-id 0x159`, board-ids `0xba000008` / `0xaa000008`) — the /e/OS boot image carries dtbs for two of them. The 4.19 tree has no dts for those, so an SDM636 unit has **no matching device tree at all**.

## The kernel

`tim-ecoder/android_kernel_blackberry_sdm660-4p19`, branch `lineage23.2-athena` — 4.19.325 with a real in-kernel Athena device tree (`sdm660-bbry-athena.dtsi`, camera dtsi, the BBRY input drivers). It is what the LineageOS 23.2 device tree selects (`TARGET_KERNEL_VERSION := 4.19`).

**But every shipping ROM for this device runs 4.4** (`4.4.302-Key2`, clang 19). No released build inspected boots 4.19 — it is the less-travelled path, and `android_kernel_blackberry_sdm660` (4.4) is the proven fallback. 4.4 is no obstacle for Halium (tissot and mido are 4.9).

Forked as `shr-distribution/linux` `key2/4.19`. The tree had never been built with anything but clang, so GCC 15 + GNU Make 4.4 both needed work — see kernel-porting.md for the generic traps. **Seven of the findings were real bugs in code LineageOS ships today**, fixed at source rather than silenced:

| Fix | Bug |
|---|---|
| `tfa9911` | `tfa98xx_get_i2c_status_id_string()` returned a pointer to a stack buffer |
| `amrwb_in` | missing braces — `AUDIO_GET_AMRWB_ENC_CONFIG` always returned `-EFAULT` |
| `ipa2 rt` | `memset(tmp, 0, SIZE/4)` on a `u32[SIZE/4]` — cleared a quarter of the buffer |
| `ipa debugfs` | `sizeof(buf) < count + 1` with `size_t count` — wraps at `SIZE_MAX`, 10 sites |
| `qcom pil` | `*ss_valid_seg_cnt--` decremented the pointer, not the count |
| `crypto ice` | format string split across two lines with no continuation |
| `kgsl` | `dev_err()` passed an argument the format string never consumed |

Only `wlan.ko` (qcacld-3.0) is built as a module, and it is the one that matters: **the ROMs ship no wlan module in `/vendor`**, so the driver must come from our build — which sidesteps the force-load/vermagic misery mindphone hit.

## Vendor and GSI — the Android-15 shortcut

Stock athena vendor is Android 8.1 / VNDK 27 and cannot serve an Android 16 GSI. The way out generalises well beyond this device:

> **Android 15 removed VNDK.** An A15 vendor image has no `ro.vndk.version` and no VNDK payload at all — just `ro.board.api_level=202404` and `ro.vendor.build.version.sdk=35`. So it needs **no VNDK snapshot ported into the GSI**, which is otherwise the expensive part (mindphone needed a v30 port).

Checked on `e-4.1.1-a15-20260725-UNOFFICIAL-athena.zip`: `/vendor/etc/vintf/manifest.xml` is **53 HALs, every one `format="hidl"`**, `target-level="5"`. A pure-HIDL vendor is exactly what libhybris wants. So the shape is sargo's, with **no vendor rebuild** — flash the A15 `vendor.img` as-is, leave `system` alone, loop-mount the GSI from userdata.

`target-level="5"` is FCM level 5 (Android 11) against an Android 16 framework matrix. That fails strict VINTF/VTS; Halium does not enforce them.

## Boot image — and the window that broke it

Header **v0**, page size **4096**, verified field-for-field against the shipping /e/OS image (not read out of the BoardConfig):

```
header_version 0    page_size 4096
base 0x00000000 + kernel_offset 0x00008000
ramdisk 0x01000000   tags 0x00000100   second 0x00000000
BOARD_KERNEL_IMAGE_NAME = Image.gz-dtb        (appended dtb, no dtbo.img)
```

The UBports Halium port for the Xiaomi Mi A2 (`jasmine_sprout`, also SDM660) uses an **identical** offset set, which is good independent confirmation. Its `deviceinfo` is worth keeping as the reference:

```
deviceinfo_flash_pagesize="4096"        deviceinfo_flash_offset_base="0x00000000"
deviceinfo_flash_offset_kernel="0x00008000"   deviceinfo_flash_offset_ramdisk="0x01000000"
deviceinfo_flash_offset_second="0x00f00000"   deviceinfo_flash_offset_tags="0x00000100"
deviceinfo_bootimg_header_version="0"         deviceinfo_bootimg_qcdt="false"
deviceinfo_kernel_cmdline="… selinux=0 console=tty0 …"
```

`second` is `0x00f00000` there and `0x00000000` in the real athena image — ours matches the device, theirs the BoardConfig default. `second_size` is 0 either way, so it does not matter.

**The failure:** first flash hung at the BlackBerry splash with `fastboot flash boot`. aboot *accepted* the image and jumped — so not AVB, not a missing dtb. The kernel image was **24.9 MB** against a window of `0x01000000 - 0x8000 = 16,744,448 B`. aboot loads the kernel at `base+0x8000`, writes the ramdisk at `base+0x01000000` through the middle of it, and jumps into the wreckage. The stock 4.4 image is 13.76 MB and clears the window by 2.99 MB.

**8.07 MB of the 24.9 MB was 27 appended device trees, 26 of them for other sdm630/sda630 boards** — see kernel-porting.md for the `DTB_OBJS` glob trap that makes the trim config a no-op. The fix is the trim plus config slimming, **not** moving the ramdisk: `0x01000000` is proven on this bootloader by two independent working images, and swapping a verified address for an unverified one while debugging a boot failure is the wrong trade.

Size levers that mattered, in order:

| Lever | Saving |
|---|---|
| append only `vendor/qcom/sdm660-internal-codec-mtp-athena` instead of all 50 `dtb-y` entries | ~7.7 MB |
| `# CONFIG_IKHEADERS is not set` — the embedded kernel-headers tarball, Android-only | the largest single config item |
| `# CONFIG_KALLSYMS_ALL is not set` (keep `IKCONFIG` — `/proc/config.gz` is how mer-kernel-check gets run on the real config) | few hundred KB |
| `# CONFIG_FB_MSM_MDSS_XLOG_DEBUG is not set`, drop ISO9660/UDF | modest |

`CONFIG_DEBUG_INFO` is a red herring — debug info lives in `vmlinux`, not `Image`.

## Framebuffer console: the debug lever this device needs

A retail KEY2 exposes **no debug UART without a jig**, so a hang shows only as a frozen splash and netconsole/`printk.devkmsg=on` cannot help — they only emit once the kernel runs and the USB gadget is up. But `CONFIG_FB_MSM`/`FB_MSM_MDSS` are already in the stock defconfig and `FRAMEBUFFER_CONSOLE` only depends on `FB`, so:

```
CONFIG_FRAMEBUFFER_CONSOLE=y
CONFIG_FRAMEBUFFER_CONSOLE_DETECT_PRIMARY=y
CONFIG_FONT_SUPPORT=y   CONFIG_FONT_8x16=y
# plus console=tty0 on the cmdline, and CONFIG_VT from the LuneOS fragment
```

turns "splash, then nothing" into a readable kernel log on the phone's own screen. **Neither the /e/OS build nor the UBports SDM660 port enables it**, though both carry `console=tty0` — where it resolves to the dummy console and shows nothing. Worth the ~100 KB on any Tier B device without a serial port.

## mer-kernel-check

Run on the **merged `.config`**, never the defconfig:

| | errors | warnings |
|---|---|---|
| stock `athena-perf_defconfig` | 8 | 54 |
| + `luneos.cfg` | **1** (deliberate) | 35 |

The 8 were `SYSVIPC`, `FHANDLE`, `DEVTMPFS`, `DEVTMPFS_MOUNT`, `VT`, `NLS_UTF8`, `DUMMY`, `STATIC_USERMODEHELPER`. Two worth calling out:

- **`CONFIG_STATIC_USERMODEHELPER=y` with `STATIC_USERMODEHELPER_PATH=""`** — an empty path disables *every* `call_usermodehelper()`: `request_module()`, core dumps, the firmware fallback loader. Android never calls them; LuneOS does.
- **`PID_NS`, `USER_NS` and `CGROUP_DEVICE` all off** in the stock defconfig. The LXC Android container needs all three.

Better than the MTK ports to start with: `ANDROID_BINDERFS`, `ASHMEM`, `ION`, `VETH`, `TUN`, `OVERLAY_FS`, `PSI`, `SECURITY_SELINUX_DEVELOP` already set, and **no `ANDROID_PARANOID_NETWORK` anywhere in the tree**.

SELinux: the UBports SDM660 port boots with `selinux=0` on the cmdline and `CONFIG_SECURITY_SELINUX_BOOTPARAM_VALUE=0`, i.e. off by default rather than merely permissive. Adopted here.

## Traps

- **The `merge_config.sh` comment trap.** A comment reading `# CONFIG_DUMMY=y  kept at the stock value` is parsed as a *directive* and silently unsets the symbol — `merge_config.sh` matches `^(# )?CONFIG_[A-Za-z0-9_][= ]`. Never start a comment line in a fragment with `# CONFIG_`. Cost an hour here.
- **Flash-kit directories on `/media` get cleaned.** The staging dir was wiped twice by disk cleanups. Keep the *scripts* on the root disk and treat the images as regenerable — the kernel recipe's `_deploy` sstate entry still holds the finished `.fastboot` boot image, so a wiped `tmp/deploy` costs an untar, not a rebuild.
- **`fastboot boot` is not the same test as `fastboot flash boot`** — RAM-booting uses fastboot's own load addresses, so it will not reproduce a load-address bug.
- **Bisect the boot image before adding logging.** A boot image built from a *known-good* kernel plus *our* initramfs (with `enable_adb`) separates kernel from initramfs in a single flash. On this device `enable_adb` makes the Halium initrd `panic` straight to its debug gadget before it looks for userdata, so a missing `rootfs.img` does not affect the test.
