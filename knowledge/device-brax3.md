# Device: brax3 (Brax Technologies BraX3, MT6835)

BraX3 (`brax3`), Brax Technologies' privacy phone on MediaTek Dimensity 6300 (MT6835), Tier A on MediaTek's mgk android13-5.15 kernel: KMI-clean kernel built host-side; never booted.

The first android13-5.15 MediaTek port and the first MediaTek device with an
`init_boot` partition. It produced two corrections to the MT6789 method — BTF on,
and **`SYSVIPC` poisons, `USER_NS` is clean** (soc-mediatek.md § Kernel). Same
`meta-zinwa` shape otherwise: device tree kernel, stock vendor modules, boot images only.

## Status (as of 11 Nov 2026)

| Area | State | Notes |
|---|---|---|
| Kernel | built, KMI-verified host-side | 0/774 BaseOS and 0/377 Iode stock modules fail; `kernel.release` exact |
| Boot images | built (bitbake), both vendors | boot + init_boot + debug; never flashed |
| Mali in Waydroid | patched module built host-side | r38p1 pid-namespace fix, interface identical to stock; not run |
| Fastboot package | `init_boot` support added | the kit used to write `boot` only (§ Install) |
| Everything on hardware | not run | no device attached yet |

## Platform facts

From Brax's own sources on git.os-source.co: the BaseOS device tree
(`Brax3_BaseOs/android_device_brax_brax3`, `baseos-1.0`), its kernel tree and
prebuilts (`android_kernel_mt6835`, `android_device_brax_brax3-kernel`), the
Iode trees (`Brax3_IodeOs/*`) and the UBports port (`Brax3_UbuntuTouchOs/*`).

| Fact | Value |
|---|---|
| Codename | `brax3` (`PRODUCT_DEVICE` in `baseos_brax3.mk`); board `k6835v1_64`. The UBports port calls it `prithvi` — unverified which `ro.product.vendor.device` reports |
| SoC / GPU | MediaTek Dimensity 6300 = **MT6835**, Mali r38p1 (`mali_kbase_mt6835.ko`, built out of tree from BaseOS's `vendor/mediatek/kernel_modules`, not from the kernel tree) |
| CPU | arm64 only (no 32-bit ABI in BaseOS), cortex-a55 variant, armv8.2-a+dotprod |
| Panel | 720x1612, 67.93 x 152.09 mm (6.56", 269 ppi) in all four panel drivers shipped: huayin ft8057s, huike/huashi ili9883, truly td4160c (90 Hz). LineageOS density 280 |
| Touch | FocalTech ft8057s (`focaltech_ft8057s.ko`), plus ilitek_v3 on other panel variants |
| Keys | `mtk-pmic-keys`, `mtk-kpd` |
| RAM / storage | 8 GB LPDDR4X, 256 GB (Brax spec page; the homepage says 6 GB), microSD. **Storage type is ambiguous:** the spec page says "UFS class", BaseOS's BoardConfig speaks of "every qualified brax3 eMMC part", and Brax's SP Flash package ships both `preloader_emmc.img` and `preloader_ufs.img` — assume batches differ. vendor_boot carries both `mtk-mmc.ko` and `ufs-mediatek-mod.ko`, so the initramfs handles either. userdata ~222 GiB, f2fs in BaseOS |
| Cameras | rear 50 MP ov50k40 (AF) + 2 MP macro BF2257, front 5 MP GC05A2 (Brax spec page) |
| Battery | 5000 mAh, 10 W USB-C (USB 2.0) |
| Sensors | light, proximity, accelerometer, magnetometer; **no gyroscope**; side-mounted capacitive fingerprint |
| SIM | one nano-SIM + eSIM |
| Other hardware | NFC (`sec-nfc`), FocalTech SPI fingerprint, connac1x Wi-Fi/BT (`ro.vendor.bt.platform=connac1x`), dual SIM with AIDL radio (UBports `ofono/binder.d/mtk.conf`: `InterfaceType = aidl`, `/ril_0`, `/ril_1`) |
| OSes | ships with **iodéOS**: v7.9 = LineageOS 23.2 on `android-16.0.0_r4` (`Brax3_IodeOs/manifests_android`; the community OS table still says Android 15). **BaseOS** 1.0 = LineageOS 23.2 on the same tag. **LunarOS** = an Android 14 BSP by lunr, which Brax's UT guide requires installed first. Ubuntu Touch 24.04 (Halium 13). BraxOS "coming soon" |
| Vendor | BaseOS: Android 16, `BOARD_VNDK_VERSION := current`, `BOARD_SHIPPING_API_LEVEL := 33` → no VNDK snapshot needed |
| Partitions | A/B, dynamic (`super` 9 GiB), `boot` 64 MiB, `init_boot` 8 MiB, `vendor_boot` 64 MiB, `dtbo` 8 MiB |
| AVB | enabled; public builds without Brax's keys use test keys and vbmeta `--flags 3` |

## Kernel

- **Tree:** `git.os-source.co/Brax3_BaseOs/android_kernel_mt6835`, branch
  `baseos-1.0`, SRCREV `815b9e54f14ede5c702869dff1f0ddcebba4476b` (one squashed
  commit, 5.15.209), recipe `linux-brax-brax3_git.bb` in `meta-smartphone/meta-brax`.
  Config: `brax3_defconfig` alone — a full generated config, not a fragment
  chain. Against `extract-ikconfig` of the shipped BaseOS kernel it differs only
  in LTO mode, `LOCALVERSION`/`_AUTO`, `MODULE_SCMVERSION` and `PAHOLE_VERSION`.
- **Toolchain:** clang **r450784e** ("Android (8508608, based on r450784e) clang
  version 14.0.7"), the stock kernel's own string and `CLANG_VERSION` in
  `build.config.constants`; `GKI_CLANG_DIR:brax3`. The Halium 14.0 tree's
  `prebuilts/clang/host/linux-x86` has it.
- **pahole is required** (kmi-crc-matching.md § Step 5). Stock sets `DEBUG_INFO_BTF`
  and `DEBUG_INFO_BTF_MODULES`; without `pahole` the build scored **774/774 failing**,
  `module_layout` included (0x4ccd63ed vs stock 0x0222dd63).
  The recipe `DEPENDS` on `pahole-native` (meta-oe 1.31; stock used 1.25 —
  `PAHOLE_VERSION` feeds no struct, measured 0/774) and fails `do_configure` if
  `DEBUG_INFO_BTF_MODULES` is missing.
- **Vermagic:** `5.15.209-android13-8-gdd511ad2a748`, set by `vermagic.cfg`
  (soc-mediatek.md § Kernel). Storage (`mtk-mmc.ko`, `ufs-mediatek-mod.ko`) and USB
  (`mtu3.ko`) are vendor_boot modules loaded by busybox `insmod`.
- **The bisect** (kmi-crc-check.py, BaseOS = 177 vendor_boot + 597 vendor_dlkm,
  Iode = 377):

  | Kernel | BaseOS | Iode |
  |---|---|---|
  | baseline, no pahole (BTF dropped) | 774 fail | 377 fail |
  | baseline with pahole | **0** | **0** |
  | + LuneOS fragment (shipped) | **0** | **0** |
  | + `SYSVIPC`, `SYSVIPC_SYSCTL`, `IPC_NS` | 774 fail | 377 fail |
  | + `USER_NS` | 0 | 0 |

  **KMI-poison on MediaTek mgk android13-5.15 / MT6835: `CONFIG_SYSVIPC`.**
  `USER_NS` is clean but stays off like every other port. `NET_L3_MASTER_DEV` is
  **=y in stock** and must stay on (kernel-config.md § Poison options: per KMI, and
  drift is a max). UBports' `halium.config` for
  this kernel sets SYSVIPC and USER_NS (plus AppArmor, squashfs, USB-ethernet)
  — not a reference.
- **Fragment:** q25's sections 1–2 unchanged (systemd/udev, VT, usermode
  helper, uevent helper, bluez/vhci, Waydroid binders, netfilter/PPP/L2TP), all
  stock-off except `VETH`, `PPP`, `L2TP`, `BT_RFCOMM`, `BT_HIDP`, which stock
  already has. `CONFIG_CMDLINE` = stock + `cgroup.memory=nokmem console=tty0` +
  the cgroup-v1 pair; no `selinux=0` (kernel-config.md § selinux=0). Every
  fragment line verified present in the resulting `.config`.
- **Iode vs BaseOS — two machines, one kernel tree:** the two module sets share
  3,832 imported symbols with **0 CRC differences** and the same
  `module_layout` — one KMI — but report different releases (BaseOS
  `5.15.209-android13-8-gdd511ad2a748`, iodéOS `5.15.211-android13-8-g63db33e5daa0`).
  `SUBLEVEL=211` on the make line gives Iode's exact string (soc-mediatek.md
  § Kernel). So
  `MACHINE=brax3` builds for BaseOS and `MACHINE=brax3-iode` for iodéOS
  (`BRAX3_VENDOR`, `vermagic-<vendor>.cfg`); `do_deploy` fails if
  `kernel.release` differs from the vendor's. The `.211` is only a label: Iode
  publishes no kernel source.
- **`MODULE_SIG_PROTECT` stays at the stock `=y`.** The general rule to turn it
  off on a rebuilt GKI does not apply to this tree: its protected and exported
  symbol lists are empty, and with the option on `module_sig_check()` lets
  unsigned modules load, which every stock module is
  (kmi-crc-matching.md § A failure class invisible to CRC checks).
- **Mali (Waydroid):** the stock r38p1 driver has the `find_get_pid(kctx->tgid)`
  pid-namespace bug (graphics.md § Mali in a pid namespace). The recipe also fetches
  `Brax3_BaseOs/android_vendor_mediatek_kernel_modules` (`baseos-1.0`, SRCREV
  `724de3483929a68439d15a9815f2c53783058f98`), applies `0001-mali-r38p1-*`, builds
  `gpu/mt6835/mali_valhall/mali-r38p1/drivers/gpu/arm/midgard` with `M=` and the
  vendor's arguments (`MTK_PLATFORM_VERSION=mt6835`,
  `LOCAL_MTK_GPU_VERSION=mali_valhall_r38p1_mt6835`, `BUILD_RULE=OOT`), and ships it as
  `linux-brax-brax3-vendor-dlkm-override`. Against both vendors' stock `.ko`: all 397
  imported and 134 exported CRCs identical, same `depends=`; the iodéOS and BaseOS
  binaries share one interface and differ only in vermagic, which each machine's
  kernel supplies.
- **v4l2loopback** is wanted but not built. The shared `v4l2loopback` recipe
  (`inherit module`, `DEPENDS = "virtual/kernel"`) cannot serve a GKI machine, whose
  `virtual/kernel` is `linux-dummy`, and the `vendor_dlkm-override` directory ignores
  modules the vendor does not ship. It needs building in the kernel recipe like Mali,
  plus a rootfs path that `systemd-modules-load` reads.

## Boot image

Header **v4** with **init_boot** (`ANDROID_BOOTIMG_INIT_BOOT = "1"`):
`boot` holds the kernel alone, `init_boot` the LuneOS ramdisk, LZ4 **legacy**
(`GKI_RAMDISK_COMPRESSION = "lz4-legacy"`). Confirmed against the UBports
images, which boot: `boot.img` v4, kernel 19,297,307 B (gzip), ramdisk 0,
os_version 13.0.0/2023-05; `init_boot.img` v4, ramdisk 6,280,221 B, magic
`02 21 4c 18`. BaseOS uses `Image.lz4`, so does LuneOS (`GKI_KERNEL_IMAGE_NAME`).

- Sizes (26 Oct 2026): `boot` 22,679,552 B (64 MiB partition); `init_boot`
  8,015,872 B against an **8 MiB** partition — ~364 KiB headroom, the binding
  constraint on the initramfs (UBports' is 6.3 MB); debug image 30,691,328 B.
- Host build trap: native headers via `-idirafter` (kmi-crc-matching.md § Step 5).
- No stock boot.img is published, so `ANDROID_BOOTIMG_OS_VERSION` is **unset**
  (0): read the flashed `boot_a` header first.
- Cmdline: the 20 `?` padding, carried defensively; MT6835 unmeasured
  (soc-mediatek.md § Boot chain: preloader and lk). BaseOS's `bootopt=64S3,32N2,64N2`
  lives in vendor_boot, which stays stock.
- The debug image is kernel + ramdisk in `boot` (gki_bootimg.bbclass), in case
  `fastboot boot` does not exist (soc-mediatek.md § Boot chain: preloader and lk).

## Vendor and GSI

BaseOS vendor = Android 16 (LineageOS 23.2) → Halium 16.0 `halium_arm64`,
nothing to convert, no VNDK snapshot. Tier 1 keys carried over from the MediaTek
ports with evidence from the UBports port: `deviceinfo_force_hwc2="1"`
(`MIR_ANDROID_FORCE_HWC2=1`), `deviceinfo_audio_sample_rate="48000"` (their
`module-droid-card rate=48000`). Not carried: `hybris_prefer_vndk` and the
connac1x bluebinder mask (try first if hci0 fails) (soc-mediatek.md § Userspace and
vendor keys).

## Yocto

Layer `meta-smartphone/meta-brax`, `MACHINE=brax3` (BaseOS) or `brax3-iode`. The
install is `luneos-dev-fastboot-package` built for that machine, so its rootfs
carries the machine's packages (the Mali override); a separate `MACHINE=halium-arm64`
rootfs would not (kernel-modules.md § The vendor_dlkm set).

| File | Role |
|---|---|
| `conf/machine/include/brax3.inc` | shared: boot images only; `GKI_BOOTIMG`, `linux-brax-brax3`, `Image.lz4`, v4 + init_boot, lz4-legacy |
| `conf/machine/brax3.conf`, `brax3-iode.conf` | `BRAX3_VENDOR = baseos / iode`; iode adds `MACHINEOVERRIDES =. "brax3:"` |
| `recipes-kernel/linux/linux-brax-brax3_git.bb` + `files/luneos.cfg`, `vermagic-{baseos,iode}.cfg` | the kernel; `DEPENDS += pahole-native`; native headers via `-idirafter` |
| same recipe + `files/0001-mali-r38p1-*.patch` | the Mali override (`${PN}-vendor-dlkm-override`), added in `brax3.inc` via `MACHINE_EXTRA_RRECOMMENDS` |
| `recipes-core/luneos-device-config/.../brax3-deviceinfo` | Tier 1: key devices, hwc2, 48 kHz |

```sh
MACHINE=brax3 bitbake luneos-dev-fastboot-package        # BaseOS vendor
MACHINE=brax3-iode bitbake luneos-dev-fastboot-package   # iodéOS vendor
```

The zip holds `boot.img`, `boot-debug.img`, `init_boot.img`, `vbmeta.img`,
`userdata.img` and `flash.sh`. **`init_boot` support was missing from the shared
fastboot package**: it shipped and flashed `boot` alone, which on this layout would
have left the stock `init_boot`, so our kernel would have started Android's generic
ramdisk. `FASTBOOT_INIT_BOOT_IMAGE` (meta-webos-ports `luneos-fastboot-package.inc`,
default from meta-android's `meta-android-halium.inc` when `ANDROID_BOOTIMG_INIT_BOOT
= "1"`) now copies it and flashes `init_<partition>` beside every boot partition.

## Install

Not yet done. Pick the machine by the vendor on the phone (`uname -r` under
Android says which). Unlock (Brax's guide):
`fastboot flashing unlock` then `fastboot flashing unlock_critical`, each
confirmed with Volume Up within 3 s; Brax warns a MediaTek firmware bug then
breaks OTA, so updates go by SP Flash Tool. Their UT install flashes `boot_a/_b`
and `init_boot_a/_b` from the bootloader after `fastboot --set-active=a`, and
needs platform-tools ≥ 35.0.2. Users report bricks from flashing the iodéOS SP
Flash preloader (≤ 7.6) onto newer batches (DRAM init fails): **never flash a
preloader**; back up with mtkclient first. Brax publishes an SP
Flash Tool package for Iode (`Brax3_IodeOs/brax3_spflash_vendor`: scatter,
preloader, modem) but no boot images. Planned flow: q25's (installing.md § Flash
steps per layout class), with `init_boot` flashed beside `boot` on the inactive slot.

## Open issues

- Read on the device: `ro.product.vendor.device` (`brax3` or `prithvi`),
  `ro.vendor.build.version.sdk`, `uname -r` (must be `5.15.209-android13-8-gdd511ad2a748`),
  the flashed `boot_a` header (os_version), whether `fastboot boot` works.
- AIDL radio (`InterfaceType = aidl`): check ofono-binder-plugin and the RIL
  derivation in hal-userspace.md before expecting telephony.
- Mali in Waydroid: the patched module is built and interface-checked, not run;
  confirm on the device that `mali_kbase_mt6835` is ours (`vendor_dlkm: our own
  build of mali_kbase_mt6835.ko` in the journal) and Android reaches
  `sys.boot_completed`.
- v4l2loopback (§ Kernel).
- Move the kernel to `shr-distribution/linux` as `brax3/5.15.209/lune`.

## Sources

- http://opensource.braxtech.net/devices/privacy/BraX3/Specifications/1.device-specifications/
- https://opensource.braxtech.net/Technical%20Guides/guides/unlock-bootloader/
- https://opensource.braxtech.net/devices/privacy/BraX3/Supported%20OS/ubuntu-touch/3.releases/
- https://community.braxtech.net/t/brax3-supported-operating-systems/315
- https://community.braxtech.net/t/i-have-bricked-my-brand-new-brax3-phone-how-can-i-fix-it/4646

- https://git.os-source.co/Brax3_BaseOs/android_manifest (BaseOS 1.0)
- https://git.os-source.co/Brax3_BaseOs/android_device_brax_brax3
- https://git.os-source.co/Brax3_BaseOs/android_kernel_mt6835
- https://git.os-source.co/Brax3_BaseOs/android_vendor_mediatek_kernel_modules (Mali r38p1)
- https://git.os-source.co/Brax3_BaseOs/android_device_brax_brax3-kernel
- https://git.os-source.co/Brax3_IodeOs/device_brax_brax3-kernel
- https://git.os-source.co/Brax3_UbuntuTouchOs/brax3-ubports
