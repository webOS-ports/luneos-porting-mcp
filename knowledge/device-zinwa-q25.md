# Device: q25 (Zinwa Q25 / Q25 Pro)

A BlackBerry Classic (Q20) chassis with modern MediaTek internals: physical QWERTY, capacitive trackpad, 3.5" **720x720** 1:1 panel — the first LuneOS port where the shell must live on a square screen, and the first MediaTek **Tier A (GKI)** target (mindphone was MediaTek but pre-GKI and 32-bit). Status: the Yocto side is complete (`MACHINE=q25 bitbake --dry-run luneos-bootimg-gki` resolves 1657 tasks) and the stock firmware has been obtained and dissected; remaining: build the kernel, run the KMI check, then hardware. Working notes: `/home/herrie/webos/LuneOS/zinwa/zinwa-q25-notes.md`.

## Platform facts

Verified from the device's own LineageOS device tree (`LineageOS/android_device_xelex_Q25`, `lineage-23.2`), its GPL kernel (`LineageOS/android_kernel_xelex_mt6789`), the Droidian port (`JamiKettunen/droidian-zinwa-q25`), and the stock firmware — not yet from hardware.

| Fact | Value |
|---|---|
| Codename / vendor | `Q25` (capital Q), `xelex`; board name `q20_v12_factory` |
| SoC / GPU | MediaTek Helio G99 = **MT6789**, Mali (`ro.hardware.vulkan=mali`); EGL driver `libGLES_meow.so` (`ro.hardware.egl=meow`) |
| CPU / RAM / storage | arm64 cortex-a76+a55 (armv8-2a); 12 GB RAM, 256 GB UFS |
| Panel | 3.5" 720x720 IPS, `panel-q20-hd720-lcm-dsi-vdo.ko`; true 291 ppi, LineageOS ships density 193 |
| Stock Android | **12** (`SP1A.210812.016`): `ro.vndk.version=31`, `ro.board.first_api_level=31`. The Android 14 build *fingerprint* on system/product/odm is an attestation spoof — every real platform property says 12 |
| Kernel | `5.10.198-android12-9`, clang **r416183b** → KMI **android12-5.10**; `CONFIG_MODVERSIONS=y`, `MODULE_SIG_FORCE` not set; `Image.gz` |
| Partitions | A/B, dynamic (`super` 9216 MiB), separate 32 MiB `metadata`. `init_boot_a/b` exist in the scatter but are **unused** — no `init_boot.img` ships |
| boot | header **v4**, 64 MiB, kernel + **non-zero ramdisk** (generic ramdisk rides in `boot`), os_version 12.0.0 / 2024-03, **cmdline empty** |
| vendor_boot | 64 MiB, v4, one 18.9 MB ramdisk fragment + 184 KB dtb; cmdline `bootopt=64S3,32N2,64N2 buildvariant=user`; 180 early modules incl. `bbqX0kbd.ko`, `8250_mtk.ko` |
| Vendor modules | **344 unique**: 180 in the vendor_boot ramdisk + 184 in `vendor_dlkm_a` |
| AVB | enabled, boot rollback index 1, vbmeta + vbmeta_system + vbmeta_vendor |
| Connectivity | connac1x combo `gen4m_6789`, control node `/dev/wmtWifi`; single SIM (`ro.telephony.sim.count=1`) |
| GSI pairing | vendor API 31 → the existing **halium_arm64 16.0** GSI (it already ships `com.android.vndk.v31`); no VNDK-snapshot work needed |

## The keyboard (the interesting part)

`drivers/input/keyboard/bbqX0kbd/` — Zinwa's fork of wallComputer's driver, I2C to an RP2040 running solderparty `i2c_puppet` firmware. Source is published (contrary to the Droidian wiki), though `bbqX0kbd_main.o_shipped` ships part prebuilt.

- **One** input device, `input->name = "Q25_keyboard"`, carrying `EV_KEY` *and* `EV_REL` *and* `BTN_LEFT`/`BTN_RIGHT` — QWERTY, toolbelt keys and trackpad on a single node; stock `.kl`/`.kcm`/`.idc` key on that name.
- `/proc/q20_switch_key_mouse`: `0` (default) = trackpad reports relative motion (pointer — what LuneOS wants); `1` = d-pad emulation.
- `/proc/q20_spec_power_flag`: `1` enables wake-on-`Call end`, at idle-power cost.
- `/proc/firmware_upgrade`: `1` then `2` while holding `Call end` = MCU mass-storage mode for `.uf2` update; without holding it, "PC mode" over USB.
- `bbqX0kbd.ko` is in `modules.load.ramdisk` → **the keyboard is alive in the initramfs** — worth a great deal on a device with no UART.

Power/volume are conventional (`mtk-pmic-keys`, `mtk-kpd`).

## The kernel decision — Tier A, but not pristine ACK

MT6789's stock vendor modules need kernel-side quirks upstream `android12-5.10` lacks. They exist in the Halium/Droidian fork `gitlab.com/deathmist/kernel-android-common` branch `common-android12-5.10-droidian` (18 patches on ACK android12-5.10-lts @ 5.10.250):

| Patch | Why it matters |
|---|---|
| GKI: SYSVIPC task_struct fields in Android ABI padding | **`SYSVIPC` is NOT KMI-poison on this KMI** — fields go into reserved padding so CRCs don't move. On android14-6.1 it *is* poison; the difference is this patch, not the kernel version |
| gki_quirks: `find_get_pid` hook for `mali_kbase(_mt6789)` | with `PID_NS=y` the Mali driver's pid lookups must resolve globally; without it, no GPU |
| gki_quirks: `snd_soc_jack_report` hook for `mt6358_accdet` | headset detection on the MT6358 codec |
| binder: ignore `txn_security_ctx` | the usual Halium hwbinder-stability patch |
| bluetooth: don't send `READ_SYNC_TRAIN_PARAMS` | ditto for BT |
| module.c: force-load on symbol-version failure | escape hatch only — **not the plan** |

**Where LuneOS deliberately differs from Droidian:** deathmist's `droidian.config` enables options its own comments call *"ABI-breaking when enabled for MT6789"* (`FANOTIFY`, `NF_TABLES`, `HUGETLBFS`, `NETFILTER_XT_MATCH_NFACCT`; the wiki adds `CGROUP_PIDS` and `POSIX_MQUEUE`) and leans on the force-load patch. The LuneOS fragment turns all six back **off**: a force-loaded module that disagrees about a struct layout corrupts memory rather than failing cleanly, and "stock vendor modules load legitimately" is the entire Tier A property. systemd needs none of the six. This is a hypothesis until `check-kmi.sh` reports 0 failures.

## What was wired up (Yocto)

New layer **`meta-smartphone/meta-zinwa`**: `conf/machine/q25.conf` (boot-image only, like bluejay), `70-q25.rules` (Q25_keyboard tagging, wmtWifi/stpbt/stpgps/conninfra_dev/accdet ownership — installed into the generic halium-arm64 rootfs like sargo's), `Q25-deviceinfo` Tier 1 adaptation (installed as `adaptations/Q25` + lowercase symlink).

Generalizations in **meta-android** (benefit every future GKI device):

- `linux-halium-gki_5.10.bb` + `luneos_defconfig-android12-5.10` — the **second KMI** in the tree (pins the deathmist fork @ `da8ef85f`; merges its `droidian.config` then the LuneOS fragment over `gki_defconfig`).
- `luneos-bootimg-gki` **moved from meta-google**, gated on `GKI_BOOTIMG = "1"` instead of a `^(bluejay|panther)$` regex — adding a GKI device is one line in its machine conf.
- `gki_bootimg.bbclass` gained `GKI_KERNEL_IMAGE_NAME` (default `Image.lz4`) so q25 can ask for `Image.gz`.
- `65-android.rules`: `/dev/mali0` 0666 `system:graphics` (device-class — same failure mode as pvr_sync: only root gets a GL context).
- bluejay/panther confs now state `PREFERRED_VERSION_linux-halium-gki = "6.1%"` explicitly.

Also: `nyx-modules/q25.cmake` (copy of halium-arm64.cmake — a machine without one does not parse), and machine-scoped `GKI_CLANG_DIR:q25` / `GKI_BUILD_TOOLS_DIR:q25` in local.conf because android12-5.10 wants clang **r416183b** while the unscoped values are android14-6.1's **r487747c**.

## Build

```sh
/home/herrie/webos/LuneOS/zinwa/fetch-gki-toolchain.sh   # once, ~3 GB prebuilts
cd /media/herrie/LuneOS/wrynose/webos-ports && . ./setup-env
MACHINE=q25 bitbake linux-halium-gki          # Image.gz + Module.symvers + kernel-config
MACHINE=q25 bitbake initramfs-android-image
MACHINE=q25 bitbake luneos-bootimg-gki        # boot-q25-luneos.img, -debug.img
MACHINE=halium-arm64 bitbake luneos-dev-image # the shared rootfs
```

## Stock firmware dissection — what it settled

Source: `drive.zinwa.com` → Google Drive → `OS-Images/Q25/MassProduction/With-GMS/OS-new-camera-0120-Q25-GMS.zip` (2.53 GiB, SP Flash Tool package — take the **OS** archive, not the OTA). Local: `zinwa/firmware/`, unpacked to `firmware/stock/`.

Settled: codename `Q25` (from `ro.product.vendor.device` — exactly what `luneos-device-config` reads), vendor API 31, no init_boot, os_version field `0x18000183` reproduces stock, boot cmdline empty (so the padded LuneOS cmdline displaces nothing), kernel `Image.gz`, clang r416183b.

Stock config (via IKCONFIG → `firmware/stock-config-5.10.198.txt`): `mer_verify_kernel_config` gives **23 errors / 54 warnings** — almost exactly bluejay's 23/59. 21 of 23 are covered by the LuneOS fragment + `droidian.config`; the two left are deliberate: `NET_L3_MASTER_DEV` (off — `l3mdev_ops` in `struct net_device`, KMI) and `DUMMY` (checker quirk, keep Android's `y`).

Notable stock-config facts: `SYSVIPC` and `PID_NS` **not set** in stock (confirming the ABI-padding patch is what makes enabling them safe), `STATIC_USERMODEHELPER=y` (fragment unsets it), `VT`/`BT_HCIVHCI` not set (both come from droidian.config), **`OVERLAY_FS=y`** (Tier 2 overlay path works, unlike sargo's 4.9), `ANDROID_BINDERFS=y`, and **both `USB_CONFIGFS_RNDIS` and `ECM` = y** — both debug-network gadgets available.

Module set: `./extract-vendor-modules.sh firmware` → 344 unique .ko. Both halves matter — `mali_kbase_mt6789.ko` and `mt6358-accdet.ko` (the two the kernel quirks exist for) are in the `vendor_dlkm` half only.

## Remaining before hardware

1. **KMI check first — nothing gets flashed before this**: `MACHINE=q25 bitbake linux-halium-gki && ./check-kmi.sh` (expect 0 failures; if drift, bisect the fragment bluejay-style — drop `CHECKPOINT_RESTORE` first, the one addition not validated on this KMI).
2. `mer_verify_kernel_config` on the deployed kernel-config (target: the same two accounted errors).
3. Stock-vs-ours boot.img header diff field by field (caught real mistakes on mindphone); inputs in `firmware/unpacked-boot/`.
4. Flash, then the debugging playbook stage by stage.

## Install sketch (untested)

A/B gives the Droidian port's nicest property: **Android keeps slot A, LuneOS takes slot B** — stock stays bootable, switching is `fastboot --set-active=other reboot`. Slot B must first receive the stock firmware (everything except `logo`, `super`, `boot_b`) or it is in an unknown state — the Q25 wiki has the list. Then:

```sh
fastboot --disable-verity --disable-verification flash vbmeta_b vbmeta.img
fastboot set_active b
fastboot flash boot_b boot-q25-luneos.img
```

`rootfs.img` + `android-rootfs.img` go in one of: a flashed `userdata` image (mindphone/sargo style), a microSD partition (Droidian's default — touches nothing), or a dedicated `linux` partition carved with `mtkclient` + a wiki GPT blob. Not chosen yet. **Anti-rollback: unknown — assume it exists, never flash older firmware.**

## Known hazards (inherited from the Droidian port)

- **MediaTek G99 lk drops the first 20 characters of the boot-image cmdline.** `ANDROID_BOOTIMG_CMDLINE` pads with `?`; anything essential goes in `CONFIG_CMDLINE` instead (where the cgroup-v1 pair lives).
- `/vendor/lib/modules` is an **absolute symlink** to `/vendor_dlkm/lib/modules` — it resolves on the *host* when read via `/android/vendor/...`; `mtk-load-modules.sh` assumes the mindphone layout and will need a vendor_dlkm-aware path.
- Backlight IC varies by unit: `ocp2131` early, `rt4831a` final (`ocp2131_drv.ko` ships).
- Headset needs replugging if present at boot; mic always routed from the jack (kernel-workaround artefacts on Droidian).
- Hotspot needs `echo A > /dev/wmtWifi`, not the UI toggle.
- Signal strength is under-reported by the modem stack.

## Tools in `/home/herrie/webos/LuneOS/zinwa/`

`check-kmi.sh` (KMI verification), `extract-vendor-modules.sh` (vendor_boot + vendor_dlkm module extraction), `fetch-gki-toolchain.sh` (KMI toolchain prebuilts), `lpunpack.py` (minimal liblp reader — handles sparse input, then `debugfs -R rdump` extracts from ext4 without root; for hosts with neither lpunpack nor simg2img).

## Sources

- <https://github.com/JamiKettunen/droidian-zinwa-q25> (+ wiki) · <https://gitlab.com/deathmist/halium-gki> (`q25-droidian`) · <https://gitlab.com/deathmist/kernel-android-common> (`common-android12-5.10-droidian`)
- <https://github.com/LineageOS/android_device_xelex_Q25> · <https://github.com/LineageOS/android_kernel_xelex_mt6789> · <https://wiki.lineageos.org/devices/Q25/>
