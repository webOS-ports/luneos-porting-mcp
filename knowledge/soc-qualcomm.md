# Qualcomm SoCs: Facts Shared by Every Qualcomm Port

What holds across the Qualcomm ports (aboot and ABL, appended device trees, CAF/LineageOS kernels, legacy vendors); device files keep their own values and link here.

Ports: a3-2015-halium (MSM8916, 3.10, 32-bit, lk2nd), bullhead-halium (MSM8992, 3.10),
vince-halium (MSM8953, 4.9), sargo (SDM670, 4.9), fajita (SDM845, 4.9), athena (SDM660,
4.19), sunfish (SM7150-AB, 4.14), surya (SM7150-AC, 4.14), bramble (SM7250, 4.19). The
generic method stays in the component topics (boot-images.md, installing.md,
kernel-config.md, kernel-build.md, kernel-modules.md, kmi-crc-matching.md, hal-userspace.md,
gsi-building.md); this file holds
what is Qualcomm-only.

## Boot chain: aboot, ABL, lk2nd

- **aboot vs ABL.** The older `aboot` and its relatives honour the boot header's load
  offsets (athena's aboot also executed an unsigned image); ABL, the UEFI-based loader of
  Android-10-launch devices, relocates what it loads, so the offsets are close to advisory
  (surya's shipping kernel overruns its nominal window by a megabyte and boots daily). The
  common v0/v1 offsets are `kernel 0x8000`, `ramdisk 0x01000000`, a 16,744,448 B window
  (athena, fajita, surya); the sunfish recipe uses `BoardConfig-common.mk`'s `0x02000000`. The rule and
  the build-time assertion: boot-images.md § The kernel/ramdisk window — a build-time
  invariant.
- **What ABL does with the header cmdline**: Pixel ABL (SDM670, SM7150) drops unrecognised
  arguments, so an `enable_adb` in the header never arrives and the debug image is a kernel
  rebuild with `LUNEOS_ENABLE_ADB=1` in `CONFIG_CMDLINE` (sargo, sunfish; fajita builds its
  debug image the same way). The per-bootloader table is in kernel-config.md § The kernel
  command line; the open question about bluejay is in boot-images.md § Debug images.
- **AVB on an unlocked ABL reports without enforcing** (sargo flashes no vbmeta:
  `androidboot.vbmeta.device_state=unlocked`, `verifiedbootstate=orange`). LineageOS
  already builds its vbmeta verification-disabled (fajita), and a community ROM may write
  no vbmeta at all (athena; boot-images.md § AVB: does the stock vbmeta cover `boot`?).
- **The header `id` is not load-bearing**: LineageOS's fajita image boots with an `id` that
  matches no `mkbootimg` recipe (device-fajita.md § Boot image).
- **`boot` is recovery** on the A/B Pixels and OnePlus (`BOARD_USES_RECOVERY_AS_BOOT`:
  sunfish, bramble, fajita). Flashing `boot` replaces recovery; keep the stock or
  LineageOS boot.img to go back.

### Header v0/v1 and appended device trees

Pre-Android-10 Qualcomm devices carry the device tree **concatenated onto the
compressed kernel** (`BOARD_KERNEL_IMAGE_NAME := Image.gz-dtb`) rather than in a
header section. There is no `dtb` field in a v0 header and often no `dtbo.img`.
aboot scans the blobs after the gzip stream and selects one by matching
`qcom,msm-id` (SoC id) and `qcom,board-id` (platform/subtype) against what the
hardware reports — so the set must contain the board, and only needs to contain
the board.

To read them back out of an image, decompress the gzip member and scan the
remainder for the FDT magic `d00dfeed`; `dtc -I dtb -O dts` then shows the
`model` / `msm-id` / `board-id` of each. Comparing that list against a working
image for the same device is the fastest way to confirm a board match.

`abootimg` is what builds v0 here, and it **defaults to 2048-byte pages and takes
no notice of `ANDROID_BOOTIMG_PAGESIZE`** — a 4096-byte-page v0 device needs
`ANDROID_BOOTIMG_EXTRA_ABOOTIMG_ARGS = "-c pagesize=4096"` or the sections land at
the wrong offsets. (Verified: `abootimg -c pagesize=4096` does produce a correct v0
header.) Only `android_bootimg_v2()` reads the pagesize variable.

**QCDT.** Older Samsung-on-Qualcomm images put a QCDT table after the ramdisk instead,
with its size in the header word at offset 40 and `SEANDROIDENFORCE` appended
(a3-2015-halium; device-a3-2015-halium.md § Boot image).

**DT_OVERLAY trees append the dtbo bases.** With `CONFIG_BUILD_ARM64_DT_OVERLAY=y` the
`dtb-y` list is empty, but every overlay's `-base` dtb is still built and
`arch/arm64/boot/Makefile` appends every `.dtb` it finds; leave `KERNEL_DEVICETREE` unset or
the bbclass concatenates a second copy (fajita; device-fajita.md § Kernel).

**Keep the stock dtbo.** The overlays select by `qcom,board-id`/`qcom,msm-id` inside each
FDT, so a base dtb from a different build still gets the right overlay (sunfish, surya);
building the base dtb with `DTC_FLAGS=-@` keeps the `__symbols__` the overlays need
(fajita, sunfish).

### lk2nd

- lk2nd lives in the first 512 KiB of the boot partition and boots the real boot image
  from 0x80000. `fastboot flash boot` inside lk2nd writes behind it; `fastboot boot`
  RAM-boots and passes the previous bootloader's arguments on (including
  `androidboot.mode=charger`).
- **Never dd a boot image to the start of the partition** — it overwrites lk2nd. Keep a
  copy of lk2nd's 512 KiB; restore over Samsung Download mode with
  `heimdall flash --BOOT <lk2nd 512 KiB + boot.img>`.

Device detail (charger-mode boots on the Samsung SBL, the postinst that did overwrite
lk2nd): device-a3-2015-halium.md.

## Install and recovery

- **Vendor swap.** Ports that run a LineageOS vendor flash it with the kit. On the A/B
  Pixels with `super` (sunfish, bramble) `vendor` is a logical partition, so `install.sh`
  reboots into **fastbootd**, and Google's stock factory image must have been flashed and
  booted once first (it supplies bootloader, modem, tz and the other firmware partitions).
  On fajita `vendor` is a real partition that bootloader fastboot writes; athena (non-A/B)
  flashes its extracted LineageOS 22 `vendor` the same way.
- **Flash both slots** on fajita: the bootloader can fall back to the inactive slot. sargo
  flashes only the active slot (flashing the inactive one and rebooting is a silent no-op).
  The general slot policy: installing.md § Flash steps per layout class.
- **Revert** with the factory image on the Pixels (sargo, sunfish, bramble); otherwise the
  stock boot image and vbmeta, then `fastboot -w`.
- **EDL is not a recovery plan**: Firehose needs the SoC's signed programmer, which is
  rarely available (tools.md § edl — the Qualcomm counterpart); a bad flash of sargo's GPT
  is an EDL brick. Qualcomm and Tensor kernels usually have ramoops instead
  (debugging.md § Ramoops / pstore console); athena has none.

## Kernel

- **Sourcing.** Pin a LineageOS kernel to the revision the vendor was built from (its
  `build-manifest.xml`), not the branch tip: bramble's stock modules failed until the
  recipe moved to the vendor's revision (sunfish, bramble). Take the config from the
  shipping `boot.img`'s IKCONFIG (surya) or LineageOS's own config (`lineage-config`,
  sunfish and bramble).
- **Toolchain.** Build with the toolchain family the tree's own `build.config.common`
  names: GCC miscompiles the register-pinned SCM call (sunfish; kmi-crc-matching.md § Step 4),
  and bramble's `redbull_defconfig` forces clang through `LTO_CLANG`, `CFI_CLANG` and
  `SHADOW_CALL_STACK`. **Unresolved:** whether that holds for every Qualcomm tree. The
  evidence is sunfish's msm-4.14 `scm.c`; athena (CAF 4.19, hardware-verified) and
  a3-2015-halium build with OE's GCC 15, as do surya, fajita and vince (not yet run on
  hardware).
- **`-Werror` in vendor Kbuilds.** qcacld-3.0 and the techpack Kbuilds set `-Werror`
  unconditionally, untouched by `CONFIG_CC_WERROR=n`: fajita and surya carry a patch
  dropping it (27 Kbuilds on surya); athena demotes only the benign classes (§ Building a
  4.19 CAF tree with a modern GCC and Make).
- **`linux_banner` and build paths.** On a 4.14/4.19 tree `init/Makefile` passes
  `$(CONFIG_CC_VERSION_TEXT) $(KBUILD_CFLAGS)` as the compiler version, and the former does
  not exist before 5.x, so the banner is the flag list, OE's `-fmacro-prefix-map=<TMPDIR>/...`
  included: build paths end up in `vmlinux`, `uname -v` and every dmesg, and
  `do_package_qa` fails `[buildpaths]`. surya's patch
  `0002-init-keep-the-build-flags-out-of-linux_banner` is worth carrying to every
  LineageOS msm tree.
- **Vendor modules.** Many Qualcomm ports have none to match: qcacld built in (fajita,
  surya, bullhead), or the port builds its own `wlan.ko` (athena). Where the vendor has a
  set, `init.insmod.<hw>.cfg` loads it in the vendor's order, and its `enable|<sysfs path>`
  lines are what start the DSPs (sunfish; device-sunfish.md § Kernel).
- **`ANDROID_PARANOID_NETWORK` and `ipc_router`**: kernel-config.md § Config facts from the
  other distros (unresolved there).

### The appended-DTB glob trap (CAF arm64 trees)

`CONFIG_BUILD_ARM64_APPENDED_DTB_IMAGE_NAMES` exists so a product can append only
the device trees it needs. In a correct tree `arch/arm64/boot/Makefile` honours it:

```make
DTB_NAMES := $(subst $\",,$(CONFIG_BUILD_ARM64_APPENDED_DTB_IMAGE_NAMES))
ifneq ($(DTB_NAMES),)
DTB_LIST := $(addsuffix .dtb,$(DTB_NAMES))
DTB_OBJS := $(addprefix $(obj)/dts/,$(DTB_LIST))      # <- the branch that matters
else
DTB_OBJS := $(shell find -L $(obj)/dts/ -name \*.dtb)
endif
```

**Some vendor forks resolve `DTB_LIST` and then never use it**, leaving
`Image.gz-dtb` depending on the bare `find` — so the trim knob is decorative and
every board's dtb is appended. On an SDM660 tree that is 27 blobs / ~8 MB, of which
one is wanted, and it is enough on its own to blow the kernel/ramdisk window
(boot-images.md). Check for the `ifneq ($(DTB_NAMES),)` branch before trusting the
config; UBports' `android_kernel_xiaomi_sdm660` has it, tim-ecoder's
`sdm660-4p19` did not.

Enabling the parent `CONFIG_BUILD_ARM64_APPENDED_DTB_IMAGE` also rewrites
`KBUILD_IMAGE` to `$(KBUILD_IMAGE)-dtb` and surfaces a Kconfig *choice*; pin
`CONFIG_IMG_GZ_DTB=y` rather than relying on first-entry-wins. Name the dtb by its
path under `$(obj)/dts/` — e.g. `"vendor/qcom/sdm660-internal-codec-mtp-athena"`.

### Building a 4.19 CAF tree with a modern GCC and Make

Two traps that are not about the kernel at all (found on athena; see
device-athena.md):

- **GNU Make 4.4** (what OE ships as `make-native`) fails every `techpack/audio`
  subdirectory with `scripts/Makefile.lib:408: *** prerequisites cannot be defined
  in recipes`. Two causes: directives inside `ifeq` blocks indented with **TABs**
  (Make 4.4 reads those as recipe lines), and a bare `export` after each
  `include <soc>auto.conf` — Make 4.4 changed export semantics, and exporting
  kbuild's multi-line command macros wholesale makes the sub-make re-parse them as
  makefile text. Replace the bare `export` with the explicit
  `export $(shell sed 's/=.*//' <the conf just included>)`.
- **`CONFIG_CC_WERROR=y` + GCC 12+** turns long-standing vendor patterns into ~90
  build failures. Keep `-Werror` and demote only the benign classes via
  `$(call cc-option,-Wno-error=<x>)`: `format`, `format-extra-args`, `address`,
  `unused-variable`, `maybe-uninitialized`, `unused-result`, `enum-int-mismatch`,
  `attributes`, `parentheses`, `bool-operation`, `duplicate-decl-specifier`,
  `misleading-indentation`, plus `missing-attributes` and `array-parameter` once
  you build modules (qcacld-3.0). Vendor Makefiles carrying **clang-only**
  `-Wno-error=` spellings (`vla-extension`, `typedef-redefinition`,
  `non-literal-null-conversion`, `fortify-source`) must be wrapped in `cc-option`:
  GCC rejects an unknown `-Wno-error=` outright rather than ignoring it.

GCC's stricter analysis is worth the trouble — on athena it found seven genuine
bugs in shipping code, including a `memset` clearing a quarter of its buffer and an
overflowable `copy_from_user` bound check. Fix those at source; silence only the noise.

### LSE atomics on ARMv8.0 SoCs: keep them off

`CONFIG_ARM64_USE_LSE_ATOMICS` builds ARMv8.1 atomics alongside the LL/SC ones and
picks at runtime with a static key; on an ARMv8.0 SoC (SDM660: Cortex-A73/A53) it
is dead weight. Turn it off to match the reference ROMs: a 4.19 tree marks clang's
assembler `CONFIG_BROKEN_GAS_INST`, so LineageOS and UBports never enable LSE,
while a Yocto build with binutils passes that test and gets a code-generation
difference no shipped ROM has. On such a tree a `can't patch jump_label` warning
on every boot means a static key keeps whatever value it had, so do not assume a
runtime CPU-feature switch is inert just because the hardware lacks the feature
(found on athena; see device-athena.md).

## Legacy Qualcomm vendors on the 16.0 GSI

Found on a3-2015-halium (a LineageOS 18.1, VNDK 30, MSM8916 vendor converted by
halium-legacy-vendor; see device-a3-2015-halium.md). Each item is generic to legacy
Qualcomm vendors.

### Display: three gaps, each hiding the next

1. The composer HAL links framework copies (libhwui, libmedia) that the converter puts in /vendor/lib;
   libhwui needs **libft2.so**, which the GSI's LLNDK list names but the container's vendor linker does
   not hand over. Converter revision 32 brings it along by itself; before that it took
   `HALIUM_LEGACY_EXTRA_LIBS = "libft2.so"`. The rule, the other route to it (libpdfium) and the
   silent symptom are in gsi-building.md § Before deriving, item 5.
2. Those copies want full-libbinder/libmedia symbols (`android::MetaDataBase::writeToParcel`):
   `HALIUM_LEGACY_SHIM_TARGETS` (halium-legacy-shim).
3. **gralloc in sphal** (`gralloc.msm89xx.so` -> libqdutils -> libui, libbinder, both VNDK-core) cannot
   load, media.swcodec aborts "gralloc-mapper is missing", and everything behind the Codec2 store
   (droidmedia, gst-droid, the compositor) waits for ever. Fixed GSI-side in
   `system/linkerconfig/generator/variableloader.cc` for VNDK 28 and 30 (branch luneos/sphal-vndk-legacy).
   A quick way to prove it on a running device: append `:libui.so:libbinder.so` to the
   `namespace.sphal.link.vndk.shared_libs` lines of the container's generated /linkerconfig/*ld.config.txt
   (tmpfs) and restart media.swcodec.

### Camera HAL1: provider service, and a deadlock in minimediaservice

- A LineageOS vendor may declare `android.hardware.camera.provider@2.4` **passthrough** only, for its own
  cameraserver to load in-process. The GSI needs the service: build
  `android.hardware.camera.provider@2.4-service` in the vendor's own Android tree (matching VNDK), ship it
  in the device tarball, and list the provider in `HALIUM_LEGACY_BINDERIZED_HALS`.
- **takePicture() deadlock:** minimediaservice (droidmedia) serves the HAL's ICameraDeviceCallback with
  libhidl's default of one HwBinder thread. The QCamera2 HAL's capture thread holds its API lock and calls
  `unregisterMemory()` back while that thread is in the shutter notification, calling `disableMsgType()`
  into the HAL. Fix in droidmedia minimedia.cpp: `hardware::configureRpcThreadpool(5, false)`, as
  cameraserver does. Diagnose with `debuggerd -b <container pid>` on the provider and on minimediaservice.
- Camera service "rejected (too many other clients connecting)" after such a hang: restart
  `vendor.camera-provider-2-4`, `qcamerasvr` and `camera_service` (ctl.restart) instead of rebooting.

### WCNSS (pronto): Wi-Fi and Bluetooth share one chip

- Built-in prima starts on `echo sta > /sys/module/wlan/parameters/fwpath`, only once the WCNSS control
  channel is up: wait until `/sys/devices/soc.0/a000000.qcom,wcnss-wlan/wcnss_version` stops reading
  `INVALID` (before that the write fails with ENODEV after ~12 s, and repeating it does not help).
- start-android-hals force-starts disabled services; the vendor's **hciattach** (init.qcom.bt.sh) among
  them powers WCNSS through the Bluetooth path before wcnss_service has triggered it: "regulator get of
  riva_vddmx failed (-19)", "Failed to execute wcnss_wlan_power", and then neither WLAN nor BT works. Put
  it in `deviceinfo_android_skip_services`; the BT HAL starts it itself later.
- With EFS mounted, wcnss_service hands the firmware the real MAC (/efs/wifi/.mac.info).

### Samsung EFS and the Bluetooth address

- `/efs` may have no fstab line at all (LineageOS a3lte). Ship a vendor `/etc/fstab.efs`; mount-android.sh
  reads every /vendor/etc/fstab* and mounts it at /android/efs. Read-only is enough.
- The BT HAL aborts in initialize() with "Open: No Bluetooth Address!" without `ro.bt.bdaddr_path` (a
  system.prop property: `HALIUM_LEGACY_SYSTEM_PROP_PREFIXES += "ro.bt. ..."`) or when it cannot read the
  file (radio:net_bt_stack 0640): give the HAL group 3008 in an rc override. **By number**: the 16.0 init
  no longer knows `net_bt_stack` ("Unable to decode GID"), and the whole override is then dropped.
- bluebinder_post.sh reads that property's path on the host; bluebinder patch 0004 (meta-luneos) falls
  back to /android<path>.

### A LineageOS 21 vendor without VNDK (bullhead, msm8992)

Found on bullhead (device-bullhead.md): a LineageOS 21 vendor built with `RELEASE_DEPRECATE_VNDK`
(no `ro.vndk.version`, its own libbinder/libhidlbase, LLNDK only from the GSI) under the arm64 16.0
GSI. The derive-time checks are in gsi-building.md § Before deriving; the per-subsystem results:

- **Camera.** `mm-qcamera-daemon` (32-bit) needs `libicu.so` through `libharfbuzz_ng.so`, and the
  provider's `camera.msm8992.so` → `libgui.so` needs the system libbinder (`PermissionCache`). Both
  services got a private directory of LineageOS 21's own `/system/lib` libraries (libbinder,
  libstagefright_foundation, libprocessgroup, libsqlite), its i18n APEX's ICU libraries and the GSI's
  `libdl_android.so`, through `setenv LD_LIBRARY_PATH`, plus the daemon's LineageOS shims
  (`liboemcamera.so|libshim_sensor.so`, `mm-qcamera-daemon|libc_mutexdestroy_shim.so`) through
  `LD_PRELOAD`. The HAL then streamed (4032x3024, AF, face detection). On the host side libdroidmedia
  needs the media APEXes mounted (`/etc/android-host-apexes`) and
  `libcom.android.media.swcodec.apexcodecs.so` linked from `/odm/lib64` (from `/odm/lib` on 32-bit),
  as on hammerhead; without them `library "libcom.android.media.swcodec.apexcodecs.so" not found`.
- **RIL, ATFWD-daemon, cnd.** LineageOS shims (`libril-qc-qmi-1.so|libaudioclient_shim.so`,
  `ATFWD-daemon|libshim_dpmframework.so`, `libcne.so|libshim_dpmframework.so`). The audioclient shim
  pulls the vendor's libaudioclient and libmediautils, which want `checkCallingPermission` from the
  system libbinder: rild needs LineageOS's 64-bit system libbinder in a private directory too. The
  vendor's `cnd` has no `user` and is rejected by Android 16 init.
- **lmkd on a 3.x kernel** aborts in a static constructor of `libmemevents` (BPF memory events) before
  `main`, every time, and init restarts it every 5 s (`init.svc_debug.no_fatal.lmkd` only stops the
  reboot). LuneOS runs no framework for it to serve: stop it from
  `on property:init.svc.lmkd=restarting` (an `/odm` override of this system service is refused).
- **Wi-Fi, qcacld-2.0 built in.** Like prima it waits for `sta` in
  `/sys/module/wlan/parameters/fwpath`, which Android's Wi-Fi HAL writes; `wlan-dynamic-start`
  (meta-luneos) writes it when there is no `/dev/wlan` and the `cnss` platform driver is bound. Scans
  then work but every connect to a PMF-capable AP fails after 5 s (`connection failed with <bssid>
  result:70 and Status:9` = `eCSR_ROAM_RESULT_SCAN_FOR_SSID_FAILURE`, `CTRL-EVENT-ASSOC-REJECT`):
  kernel-build.md § Legacy 3.x kernels has the cause and the one-line fix.

### Adreno 4xx on a 3.10 kgsl: Chromium's low-4GB reservation

The 3.10 kgsl of the Adreno 4xx (Nexus 5X, msm8992) can only place a CPU-mapped GPU buffer below
`KGSL_SVM_UPPER_BOUND` (0xc0000000 - 16 MB): the GPU addresses 32 bits. Chromium 151's PartitionAlloc
reserves the whole first 4 GB + 1 MB of every 64-bit Linux process as an inaccessible "zero segment"
(`enable_user_space_zero_segment`, on by default; V8's sandbox reserves the same range itself when
PartitionAlloc has not). So every GPU mapping in WebAppMgr and the browser fails, EGL never
initialises and the in-process GPU thread crashes on every start, while the compositor (no Chromium)
draws fine. Tells: `kgsl_get_unmapped_area| pid N ... failed error -12` in dmesg, and
`00010000-100100000 ---p ... [anon:partition_alloc]` as the first line of WebAppMgr's
`/proc/<pid>/maps`. meta-luneos patch `0002-Halium-let-a-device-opt-out-of-the-low-4GB-reservation`
skips both reservations when `/etc/webruntime/no-low-4gb-reservation` exists; a machine that needs it
installs that file. Expect it on any 64-bit device whose GPU driver keeps an SVM range below 4 GB
(older kgsl for 32-bit-address Adreno parts); newer kgsl puts 64-bit processes' SVM above 4 GB.
