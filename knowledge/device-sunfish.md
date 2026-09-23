# Device: sunfish (Google Pixel 4a) — Tier B Qualcomm, vendor modules and all

A pre-GKI Snapdragon 730G (SM7125, platform `sm7150`) running the generic `halium-arm64` rootfs and an Android 16 GSI over its final Android 13 vendor. Closest relative in the tree is sargo, and it was modelled on it — same vendor, same Qualcomm/Adreno libhybris path, same A/B + boot-header-v2 arrangement. What makes sunfish its own case is that Google shipped **44 kernel modules on the vendor partition**, so the Tier B "rebuilt kernel refuses the stock modules" problem is not a footnote here, it is the port. Layer `meta-smartphone/meta-google`, `MACHINE=sunfish`, build tree `/media/herrie/LuneOS/wrynose/webos-ports`.

## Platform facts

| Fact | Value |
|---|---|
| SoC | Qualcomm SM7125 (Snapdragon 730G), Adreno 618. `androidboot.hardware.platform=sm7150`, but `ro.board.platform=sm6150` — three different names for one chip, so match on `ro.hardware=sunfish` |
| Reference build | `google/sunfish/sunfish:13/TQ3A.230805.001.S2/12655424:user/release-keys`, security patch 2023-08-05, `ro.vndk.version=33` |
| Kernel | **4.14.355**, LineageOS `android_kernel_google_msm-4.14` branch `lineage-22.2` (SRCREV `b8cf65288a`). Pre-GKI → Tier B. The device-specific `android_kernel_google_sunfish` repo was abandoned at lineage-18.1 / 4.14.212 — do not use it |
| Toolchain | Google Clang **r416183b**, not OE's GCC. Not a preference — see below |
| A/B | yes (`androidboot.slot_suffix`) |
| Dynamic partitions | genuine `super` (launched on Android 10), not sargo's retrofit |
| Storage | **UFS**: `/dev/sd*`, by-name at `/dev/block/platform/soc/1d84000.ufshc/by-name/` |
| boot partition | **is** recovery (`BOARD_USES_RECOVERY_AS_BOOT`). Flashing LuneOS replaces recovery; keep the stock boot.img |
| boot header | v2, pagesize 4096, kernel 0x00008000, ramdisk 0x01000000, tags 0x00000100, dtb 0x01f00000 (one 425,348 B FDT). Read out of the stock image, which **disagrees with BoardConfig-common.mk** on ramdisk and tags — the shipped image wins |
| Builds | boot.img + initramfs only. The rootfs is `MACHINE=halium-arm64`; the GSI is chosen at install time |

## The vendor modules are the port

`/vendor/etc/init.insmod.sunfish.cfg` names 48 modules; 44 actually ship in `/vendor/lib/modules`. Against a kernel rebuilt with `luneos.cfg` **none of them load** — `disagrees about version of symbol module_layout`, 44 out of 44, measured 22 Sep 2026. The stock defconfig sets `CONFIG_MODVERSIONS` and the LuneOS delta (SYSVIPC alone adds two fields to `task_struct`) moves the CRCs.

The vendor's `/vendor/bin/init.insmod.sh` calls plain `modprobe`, with no `--force`, and then sets `vendor.all.modules.ready` **unconditionally** — so it cannot recover and nothing downstream notices. `CONFIG_MODULE_FORCE_LOAD=y` makes forcing possible; the force has to come from the host side.

**The chain that is easy to misread.** The cfg does not only load modules:

```
modprobe|adsp_loader_dlkm.ko apr_dlkm.ko ... wlan.ko wsa881x_dlkm.ko heatmap.ko ftm5.ko drv2624.ko
setprop|vendor.all.modules.ready
enable|/sys/kernel/boot_adsp/boot
enable|/sys/kernel/boot_cdsp/boot
enable|/sys/kernel/boot_slpi/boot
setprop|vendor.all.devices.ready
```

Those three `enable` lines are what actually start the DSPs, and `/sys/kernel/boot_adsp/boot` is created by `adsp_loader_dlkm.ko` — the first entry on the modprobe line. No module → no sysfs node → no write → **the ADSP and SLPI never boot**, and the symptom points somewhere else entirely:

- `adsprpc: fastrpc_rpmsg_probe: opened rpmsg channel for cdsp` — cdsp only, never adsp
- `ADSPRPC: audio_pdr_adsprpc is uninitialzed` / `sensors_pdr_adsprpc is uninitialzed`
- `adsprpcd: apps_dev_init failed for domain 0, errno Transport endpoint is not connected`, restarting ~4×/s forever (2561 restarts in ten minutes)
- `chre: remote_handle_open failed for chre_slpi`
- `sensorfw: HYBRIS CTL invalid sensor type: 1` → `no such sensor "accelerometeradaptor"` → sensorfwd exits 1

Everything else that is dead without the modules: **wifi** (`wlan.ko` — the firmware side is already fine, `icnss: WLAN FW is ready: 0xd87`), **audio** (the whole dlkm stack, so no ALSA card at all: `Cannot get card index for b1`), **the vibrator** (`drv2624` → no `/sys/class/leds/vibrator`, HAL started and exited 124 times), and **vold's user-0 storage** (`incrementalfs`).

**Fix:** the `45-vendor-modules` pre-start hook in `android-system` walks the vendor's own cfg, escalating plain → `--force-vermagic` → `--force` per module, honouring the `enable|` lines. Opt-in per codename via `vendor-modules.d/<codename>`, because force-loading is a per-device judgement. Two details worth keeping:

- **Not `/lib/modules/$(uname -r)`.** udev coldplug autoloads by modalias from there; a depmod'd vendor set in that directory bootloops the device from the second boot on (measured on MP01 — `mtk_lpm` a second after udevd, SoC freeze, hardware watchdog). Use a private tree under `/run` with `depmod -b` and `modprobe -d`.
- **`incrementalfs` is not in the cfg.** Android loads it itself with `finit_module`, which cannot force (`Exec format error`), so it has to be named separately.

**Reason from the vendor partition, not from the defconfig.** Only nine symbols on that cfg line are `=m` in `sunfish_defconfig`, which reads as "LineageOS builds the audio stack in, so a first boot has audio". It does not: Google shipped the whole dlkm stack as `.ko` (adsp_loader, apr, q6\*, wcd\*, swr\*, \*_macro, bolero, machine, platform, stub, snd_event). The touchscreen half of that reasoning *is* right — `CONFIG_TOUCHSCREEN_FTS_S5` is built in and touch works on a kernel where not one vendor module loaded.

## Multi-fstab: firmware_mnt, and what it takes down with it

sunfish splits its fstabs by purpose — `fstab.persist`, `fstab.postinstall`, **`fstab.sm7150`** (the SoC one; *not* `fstab.sunfish`). `mount-android.sh` used to read one, and a plain glob sorts `fstab.persist` first, so `/vendor/firmware_mnt` was never mounted:

```
ueventd: firmware: attempted /vendor/firmware_mnt/image/modem.mdt, open failed
subsys-pil-tz ...: Initializing image failed(rc:-5)      (modem, cdsp, venus, npu, ipa_fws)
```

With TrustZone unable to authenticate any peripheral image, the Adreno zap shader never loads either — so no `/dev/kgsl-3d0`, no EGL, and **surface-manager aborts in a loop on a black screen**. One unmounted vfat partition, the whole device. Fix: read *every* `fstab*` the vendor ships, not the best-looking one. The rule is not "pick the right fstab", it is "do not pick".

There is **no `dsp` partition** on sunfish — `fstab.sm7150` has none, and the DSP images live in the modem partition at `/vendor/firmware_mnt/image/` alongside `modem.*`. So firmware_mnt is the only mount the DSPs need.

## Kernel recipe traps

- **Clang or nothing.** With OE's GCC every TrustZone call failed (`scm_call failed with error code -1` ×44, `QSEECOM: Failed to get QSEE version info -19`) and took PIL, the GPU and the display with it. `drivers/soc/qcom/scm.c`'s arm64 entry is register-pinned inline asm with `__asmeq` — exactly where GCC and Clang disagree — and this tree has never been built with anything but Clang. Point `GKI_CLANG_DIR:sunfish` at r416183b.
- **LTO and CFI were silent until the toolchain switch — and then got turned off for the wrong reason.** Both depend on Clang, so under GCC Kconfig forced them off; with Clang the LineageOS defconfig's `CONFIG_LTO_CLANG=y` / `CONFIG_CFI_CLANG=y` activated and the kernel grew 5.4 MB past stock. They were then disabled to match what the device's own `CONFIG_IKCONFIG` showed Google shipping (`LTO_NONE`, no CFI) — **and that was the wrong reference.** This phone does not run Google's vendor; it runs a LineageOS-derived one, whose modules were built *with* CFI and say so on contact:

  ```
  snd_event_dlkm: Unknown symbol __cfi_slowpath (err 0)
  ```

  `__cfi_slowpath` exists only in a CFI kernel, and `Unknown symbol` is the failure class no force-load can survive (kmi-crc-matching.md). **Rule: the authority is the vendor whose modules the device loads, not the OEM whose logo is on the case.** LTO is still a Kconfig *choice* — `# CONFIG_LTO_CLANG is not set` does nothing, you select `CONFIG_LTO_NONE=y` — but on this device you do not want to.
- **The boot window is tight and worth watching.** Kernel at 0x8000, ramdisk at 0x01000000 → 16 MiB for everything before the ramdisk. `sunfish_check_boot_window` in the recipe fails the build rather than shipping a kernel that overwrites its own initramfs — nothing in bitbake notices this on its own, and the failure on-device is a silent non-boot. Measured headroom has ranged from 570,316 B (21–22 Sep, before the LTO/CFI corrections landed) to 1,032,296 B after them; adding the Bluetooth block cost 67,066 B. **Read those numbers out of `log.do_deploy*` in time order** — the files are timestamp-named, so a glob sorts them by build id, not by date, and it is easy to quote a stale one.
- **`DTC_EXT` and `DTC_FLAGS=-@` are both mandatory.** The in-tree dtc is 1.4.4 and cannot parse the overlay sugar these dtsi files use (`&thermal_zones {` at the top level of a `/plugin/`); the vendor uses a newer prebuilt too. And the base dtb must carry `__symbols__` or the stock dtbo overlays have nothing to resolve against.
- **The bootloader drops command-line arguments it does not recognise** (measured on sargo with a `zz.marker=1` canary), so nothing added to `ANDROID_BOOTIMG_CMDLINE` reaches `/proc/cmdline`. Anything LuneOS needs goes in `CONFIG_CMDLINE`; `LUNEOS_ENABLE_ADB=1` builds the initramfs debug shell's flag in.
- `CONFIG_COMPAT_VDSO` off (no arm32 cross-gcc in the sysroot), `CONFIG_CC_WERROR` off, `CONFIG_MSM_RDBG` off (a real `-Werror=designated-init` that survives `CC_WERROR=n`).
- **Bluetooth needs `BT_BREDR` and `BT_LE` spelled out.** They are `default y` in `net/bluetooth/Kconfig`, so every other LuneOS fragment just lists the protocols — but `sunfish_defconfig` turns both off explicitly, and RFCOMM/BNEP/HIDP all `depends on BT_BREDR`. List only the protocols and the fragment silently does nothing.
- The **dtbo partition is left stock**. The eight `sm7150-sunfish-*` overlays select by `qcom,board-id`/`msm-id` inside each FDT rather than by the table header, which is why a base dtb from a different build still gets the right overlay. Expected to work; if the device does not boot with an otherwise sane kernel, build `dtbo.img` from this tree (needs AOSP `mkdtimg`, which OE does not package).

## Which vendor is this, and the move to LineageOS 23.2

The phone arrived with **/e/OS 13**, a LineageOS 20 derivative — and the owner's
recollection was not needed to establish that, because the vendor modules name
their own kernel:

```
vermagic=4.14.336-gfe61ffb52659 SMP preempt mod_unload modversions aarch64
```

`fe61ffb52659` is the head of `lineage-20` in `android_kernel_google_msm-4.14`,
which matches the `api=33` (Android 13) the device reports. All 42 modules
carried that identical string with no `+` or `-dirty`, so /e/OS applied no kernel
patches of its own: they shipped LineageOS's tree as-is. Pinning that revision
took `module_layout` from mismatching to matching — the branch tip
(`lineage-22.2`, 4.14.355) had scored 42 of 42 failing.

**The port then deliberately retargeted to the current release instead.**
LineageOS 23.2 is actively maintained for sunfish (nightlies, latest 2026-09-17),
and its build publishes everything needed to reproduce it exactly:

| Artifact | Where | Size |
|---|---|---|
| kernel revision | `build-manifest.xml` next to the zip — `28f9290ae067` | 285 KB |
| the config it shipped | `IKCFG_ST` blob inside the standalone `boot.img` | 67 MB |
| its 41 vendor modules | `vendor.img`, via `payload_extract.py` on `payload.bin` | 1.2 GB zip |

So the recipe is pinned to `lineage-23.2` / `28f9290ae067` / 4.14.357-openela,
and — the important part — **its config base is the `.config` extracted from that
shipped kernel, not `arch/arm64/configs/sunfish_defconfig`.** Their own config
has `DEBUG_FS=n` with `TRACING=y`, which is reachable on 4.14.357 and was not on
the lineage-20 tree; guessing from the defconfig is what produced two wasted
builds. `KERNEL_LOCALVERSION = "-g28f9290ae067"` supplies the rest of the
vermagic (a `CONFIG_LOCALVERSION` line in a fragment does not survive —
`kernel.bbclass` owns that option).

With that base the config diff against LineageOS is **37 symbols, all of them
ours**, and `printk`/`kfree`/`mutex_lock` already match while `dev_err` and
`module_layout` do not — a config difference in `struct device` and
`struct module`, which also proves the compiler is not the problem (ours is
clang 12, theirs clang 21).

**The trade this commits to:** the device has to run LineageOS 23.2, since that
is the vendor being matched. In exchange the target is maintained and exactly
reproducible, which /e/OS 13 was not.

### Two traps this cost, both now in kmi-crc-matching.md

- **`DEBUG_FS` was a red herring** and two builds went into it. 11 of the 42
  modules import `debugfs_create_*`/`debugfs_remove_*` themselves, so the vendor
  kernel provably had it **on**; the selector chain
  (`DEBUG_FS ← TRACING ← GENERIC_TRACER ← IPC_LOGGING`) also runs through an
  option the vendor's own defconfig sets. A `# CONFIG_X is not set` line cannot
  turn off a selected symbol in any case.
- **The recipe had no baseline switch**, so a run believed to be a stock-config
  control silently carried the whole LuneOS delta (`bitbake -R` with a variable
  the recipe never reads changes nothing) and its 42/42 was reported as evidence.
  `LUNEOS_KERNEL_FRAGMENT ?= "1"` now exists here, as it always has on bramble.

## Decoding `bad ioctl: -1072934383`

60,304 of these in one boot, and they are a **symptom, not a cause**. `-1072934383` = `0xc00c5211` = `_IOWR('R', 17, 12)`: magic `'R'` is fastrpc, number 17 is `FASTRPC_IOCTL_GET_DSP_INFO`, and 12 bytes is `struct fastrpc_ioctl_capability` (3 × u32). The vendor's `adsprpcd` calls it; the in-kernel `adsprpc` here is older and does not implement it, so it prints and returns. The flood is the restart loop multiplying one harmless line — fix the ADSP and it goes to near zero.

## Android services stubbed (and one deliberately not)

`stubbed-services.d/sunfish`: `pixelstats-vendor`, `wait_for_strongbox` (exit — init *waits* on it in late-fs), the Titan M rebootescrow HAL, `mm-pp-dpps`, the SurfaceFlinger configstore HAL, `diag_mdlog` (exit) and `ssr_diag`, `storaged`, and the **USB gadget HAL** — LuneOS owns the gadget host-side, so the container has no `/config/usb_gadget/g1` and the HAL's constructor treats that as fatal (`"configfs setup not done yet"`, 124 SIGABRTs in ten minutes, each one setting `sys.init.updatable_crashing=1` and running `flags_health_check`).

**The health HAL is not stubbed**, unlike sargo's 2.0 equivalent. Stubbing it cost more noise than it saved — 621 `Could not find 'android.hardware.health@2.1::IHealth/default' for ctl.interface_start` in ten minutes, because `storaged` is not the only client: **`gnss_service`** polls for it once a second forever, and GPS is wanted. The vendor rc declares the service with no `interface` line, so init can never satisfy a `ctl.interface_start` for it — the only thing that works is the real HAL registering `IHealth` itself.

## Status (22 Sep 2026)

Up: display, touch (FTS built in), modem and RIL (`Connected to android.hardware.radio@1.4::IRadio/slot1`, `SIM card OK`), cdsp, venus, the GPU.
Not yet: wifi, audio, sensors, vibrator, bluetooth, telephony — all of the first four behind the vendor modules, bluetooth behind the kernel fragment, telephony behind an **ofono 2.19 SEGV** that fires right after the SIM file reads (`Requested file structure differs from SIM: 6fb7`, `Facility lock query error: INVALID_ARGUMENTS`, `session_read_info not implemented`) and restarts every nine seconds. No backtrace yet: `systemd-coredump` is disabled on the device.

## Reading the stock vendor image without a device

Most of the facts above came out of the factory image rather than a phone, and nothing needed root or a loop mount:

```
unzip -j sunfish-<build>-factory-<hash>.zip '*/image-sunfish-*.zip'
unzip -j image-sunfish-<build>.zip vendor.img        # already raw ext4, not sparse
debugfs -R "cat /etc/init.insmod.sunfish.cfg" vendor.img
debugfs -R "ls -l /lib/modules"                vendor.img
debugfs -R "cat /etc/fstab.sm7150"             vendor.img
debugfs -R "dump /bin/hw/<binary> /tmp/x"      vendor.img   # then strings/readelf
```

Worth doing before guessing at a vendor's behaviour — the module list, the load order, the fstab split and the abort string in the USB gadget HAL were all one `debugfs` call away.
