# Device: vince (Xiaomi Redmi 5 Plus, MSM8953)

Xiaomi Redmi 5 Plus (`vince-halium`), Qualcomm MSM8953, Tier B on a LineageOS 18.1 vendor (VNDK 30): `luneos-dev-image` builds and its contents are verified host-side; never run on hardware.

Same SoC as tissot and mido, but not the same Android half. Those keep Android 9 vendors and patch the Treble gaps in; vince has a real VNDK 30 vendor from `m vendorimage` and needs none of that.

## Status (as of 31 Oct 2026)

| Area | State | Notes |
|---|---|---|
| Kernel, boot image | builds | GCC 15; header, addresses and cmdline read back; not booted |
| Vendor, GSI | builds | no conversion; the vendor image is not published yet |
| Out-of-tree modules | build | wlan, wireguard, v4l2loopback signed, vermagic 4.9.251 |
| HAL closure | link level | no unresolved symbols in vendor-owned objects |
| Everything on a device | untested | no vince was available |

## Platform facts

- 1080x2160, two panels in the device tree (nt36672, td4310); 401 PPI from the LineageOS README. The panels' `qcom,mdss-pan-physical-*` (69 x 122 mm) cannot give it, the height being a 16:9 panel's.
- Fingerprint: the device tree has both Goodix and FPC nodes. IR: Peel on SPI (`peel_ir`).
- NFC: none. The built device tree has an `nq@28` node, but it comes from `msm8953-qrd.dtsi`; the vendor has no NFC HAL or blobs. Do not read a device's features from a dtb that includes a QRD reference dtsi.

## Kernel

- `xiaomi-msm8953-devs/temp_android_kernel_xiaomi_vince`, lineage-18.1, 4.9.251, `vince_defconfig` + `luneos.cfg`. LineageOS's `android_kernel_xiaomi_msm8953` has no vince_defconfig on any branch, though the device tree names it. tissot's shr branch has no vince support.
- Ten recipe patches, kept as patches because the repository is third party.
- `arch/arm64/Makefile` here lacks the `ifeq ($(KBUILD_EXTMOD),)` guard around `vdso_prepare`, so every out-of-tree module stops with "No rule to make target 'prepare0'". Patch 0010.
- The tree backports `totalram_pages()` as a function at 4.9.251, which wireguard's compat.h cannot know from the version. The recipe now reads `mm.h`, as it does `skbuff.h`.
- `ANDROID_PARANOID_NETWORK` stays on, unlike tissot. `PRONTO_WLAN=m`, `MODULE_SIG_FORCE=y`.

## Boot image

Addresses from msm8953-common: kernel 0x80008000, ramdisk 0x81000000, tags 0x80000100, page 2048, boot partition 67,108,864 B. The kernel has 16,744,448 B before the ramdisk; `Image.gz-dtb` is 13,053,987 B.

## Vendor and GSI

- `lunch lineage_vince-userdebug`, `m -k vendorimage`, `m vnod` in the 11.0 tree. `art-check-release-apex-gen` fails because Halium disables ART; it does not matter for a vendor.
- `vendor/samsung/*` and `device/samsung/*` must be hidden from soong (`.find-ignore`): msm8916-common's namespace and a3lte's 32-bit prebuilts break an arm64 product.
- `ro.vndk.version=30` is in `/vendor/default.prop`, not `build.prop`. Halium's mount-android.sh then mounts all VNDK APEXes, a safe fallback.
- The vendor image travels in the rootfs, by the published-image path of `android-system-image-legacy-gsi.inc`. GSI: halium_arm64 20261017-1.
- 32-bit services: audio, camera provider, cas, omx.
- `audio.primary.msm8953.so` needs `set_sched_policy`, in VNDK 30's libprocessgroup and no longer in the GSI's libcutils: `deviceinfo_hybris_prefer_vndk="1"`.

## Yocto

- No ofono files: 40-ofono-binder derives both from the HAL. The vendor manifest has `@1.4::IRadio/slot1` and `slot2`. tissot's and mido's `ofono-conf/*` copies are older than the generator; do not copy them to a new port.
- fingerprint-hal-fixup's tissot block is skipped, since the vendor has no `gf_fingerprint.default.so`; only its uinput fix runs.

## Install

Fastboot (`luneos-dev-fastboot-package`): `boot` and `userdata` only. `userdata.img` holds `rootfs.img`, and vendor.img and the GSI are inside that, so `system` and `cust` stay as they are. The firmware partitions must suit LineageOS 18.1. Not yet confirmed on a phone.

The TWRP zip (`luneos-dev-package`) failed its first try by sideload on a freshly formatted /data: truncated tarball, `tar: short read`, cause not established. The updater script checks neither the mount nor the copy, and flashes `boot` and reports success after a failed unpack.

## Open issues

- Publish `vince-halium-vendor.img` to the `halium-luneos-20261005` release; until then the recipe needs it seeded in DL_DIR.
- Mirror the `temp_` kernel to shr-distribution/linux.
- On the first boot: lshal slot derivation, audio, fingerprint, key devices, pixel ratio.

## Sources

`meta-xiaomi/conf/machine/vince-halium-STATUS.md`, LineageOS android_device_xiaomi_vince and android_device_xiaomi_msm8953-common (lineage-18.1), the-muppets/proprietary_vendor_xiaomi.
