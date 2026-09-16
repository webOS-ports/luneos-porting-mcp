# Device: q25 (Zinwa Q25 / Q25 Pro)

The first MediaTek Tier A (GKI) target, the first LuneOS port onto a square screen, and the port that produced the method's sharpest correction so far: **"GKI device" does not imply "an ACK kernel will do"**. MT6789 ships MediaTek's *mgk* GKI derivative, not pure GKI, and an ACK build scored 344 of 344 stock vendor modules failing to load before the device-tree build scored 0. It also confirms that the KMI-poison list is a property of a specific KMI-plus-tree rather than of GKI in the abstract - though SYSVIPC poisoned and PID_NS stayed clean here exactly as on bluejay's android14-6.1. BlackBerry Classic chassis, Helio G99, 3.5" 720x720 1:1 panel, physical QWERTY and trackpad. Working notes: `/home/herrie/webos/LuneOS/zinwa/zinwa-q25-notes.md`; Yocto: layer `meta-smartphone/meta-zinwa`, `MACHINE=q25`.

Status: **a KMI-verified kernel and boot image now build from this tree.**
`boot-q25-luneos.img` (27 MB, 40% of the 64 MiB partition) reproduces the stock
header field for field, and all **344 stock vendor modules still load against
our kernel with zero CRC mismatches**. Nothing has touched hardware yet. The
stock firmware has been obtained and dissected (`drive.zinwa.com` → Google Drive → `OS-Images/Q25/
MassProduction/With-GMS/OS-new-camera-0120-Q25-GMS.zip`, 2.53 GiB, build
`SP1A.210812.016`, 20 Jan 2026). Every "unverified" item in the first draft of
these notes is now settled from that archive. Remaining: build the kernel, run
the KMI check, then hardware.

## Platform facts

All verified from the device's own LineageOS device tree
(`LineageOS/android_device_xelex_Q25`, `lineage-23.2`), its GPL kernel tree
(`LineageOS/android_kernel_xelex_mt6789`), and the Droidian port
(`JamiKettunen/droidian-zinwa-q25` + `gitlab.com/deathmist/halium-gki`
branch `q25-droidian`). Not from hardware.

| Fact | Value |
|---|---|
| Codename / vendor | `Q25` (capital Q), `xelex`. Board name `q20_v12_factory` |
| SoC / GPU | MediaTek Helio G99 = **MT6789**, Mali (`ro.hardware.vulkan=mali`); EGL driver is `libGLES_meow.so` (`ro.hardware.egl=meow`) |
| CPU | arm64, cortex-a76 + cortex-a55, armv8-2a |
| RAM / storage | 12 GB, 256 GB UFS (228 GiB userdata stock) |
| Panel | 3.5" 720x720 IPS, driver `panel-q20-hd720-lcm-dsi-vdo.ko`. True 291 ppi; LineageOS ships density 193 |
| Stock Android | **12** (`SP1A.210812.016`). `ro.vndk.version=31`, `ro.board.first_api_level=31`, `ro.vendor.build.version.sdk=31`. The Android 14 build *fingerprint* on system/product/odm is an attestation spoof — every real platform property says 12 |
| Kernel | `5.10.198-android12-9-gfcab0aff02db`, clang **r416183b** (12.0.5), `Image.gz` → KMI **android12-5.10 generation 9**. `CONFIG_MODVERSIONS=y`, `MODULE_SIG_FORCE` not set |
| Partitions | A/B, dynamic (`super` 9216 MiB), separate `metadata` 32 MiB. `init_boot_a/b` exist in the scatter (8 MiB) but are **unused** — no `init_boot.img` ships and nothing flashes one |
| boot | header **v4**, 64 MiB. kernel 20,174,525 B + ramdisk 1,189,717 B (non-zero → generic ramdisk rides here). os_version 12.0.0, patch 2024-03, **cmdline empty** |
| vendor_boot | 64 MiB, header v4, one ramdisk fragment (18.9 MB gzip), dtb 184,000 B. cmdline `bootopt=64S3,32N2,64N2 buildvariant=user`. 180 early modules incl. `bbqX0kbd.ko`, `8250_mtk.ko` |
| AVB | enabled, boot rollback index 1, vbmeta + vbmeta_system + vbmeta_vendor |
| Console | `8250_mtk.ko` → `ttyS0`. Stock vendor_boot cmdline asks for `console=tty0` |
| Wi-Fi / BT | connac1x combo, `gen4m_6789`, control node `/dev/wmtWifi` |
| Modem | single SIM (`ro.telephony.sim.count=1`), VoLTE/VoWiFi props present |
| SPL | 2024-03-05 |
| Vendor modules | **344 unique**: 180 in the vendor_boot ramdisk + 184 in `vendor_dlkm_a` (32.2 MiB, inside super) |
| Camera | `imx111_mipi_raw` + `s5kjn1_mipi_raw`; modem `q20v1_a_ulwctg_cogps` |

### The keyboard, which is the interesting part

`drivers/input/keyboard/bbqX0kbd/` in the GPL kernel tree — Zinwa's fork of
wallComputer's driver, talking over I2C to an RP2040 running solderparty
`i2c_puppet` firmware. Contrary to what the Droidian wiki assumes, the source
*is* published (though `bbqX0kbd_main.o_shipped` sits next to the `.c`, so
part of it ships prebuilt).

- It registers **one** input device, `input->name = "Q25_keyboard"`, carrying
  `EV_KEY` *and* `EV_REL` (`REL_X`/`REL_Y`) *and* `BTN_LEFT`/`BTN_RIGHT`. The
  QWERTY, the toolbelt keys and the trackpad are all that one node. The stock
  `.kl`/`.kcm`/`.idc` are keyed on the same name.
- `/proc/q20_switch_key_mouse`: `0` (the driver default) → the trackpad reports
  relative motion, i.e. a pointer. `1` → it accumulates offsets and emits
  `KEY_UP/DOWN/LEFT/RIGHT` past a threshold, i.e. a d-pad. LuneOS wants the
  default.
- `/proc/q20_spec_power_flag`: `1` enables wake-on-`Call end` (stock Android
  exposes it as "Keyboard function switching"), at some idle-power cost.
- `/proc/firmware_upgrade`: `1` then `2` while holding `Call end` puts the MCU
  in mass-storage mode for a `.uf2` firmware update. Without holding `Call end`
  the same sequence puts the keyboard into "PC mode" over USB.
- `bbqX0kbd.ko` is in `modules.load.ramdisk`, so it loads from `vendor_boot` —
  the keyboard is alive in the initramfs, which is worth a great deal when
  debugging a device with no UART.

Power and volume are separate and conventional: `mtk-pmic-keys.c` registers
`"mtk-pmic-keys"`, `mtk-kpd.c` registers the matrix keypad.

## The kernel decision, and the measurement that reversed it

The Q25 looks like a textbook Tier A device — GKI boot image, `android12-5.10`
KMI generation 9, stock `vendor_boot` and `vendor_dlkm`, `CONFIG_MODVERSIONS=y`
with no `MODULE_SIG_FORCE`. So the port first did the Tier A thing: ACK
`android12-5.10` (via the Halium/Droidian fork, which carries MT6789 `gki_quirks`
and a SYSVIPC-in-ABI-padding patch), built with the Clang the KMI was frozen
with.

**That kernel scored 344 of 344 stock vendor modules failing to load**, with
`module_layout` itself mismatching — a total CRC shift, not a stray option.

The reason is in the stock kernel's own IKCONFIG: `CONFIG_ARCH_MEDIATEK=y` and
~1,200 options `gki_defconfig` does not have. **MediaTek does not ship pure GKI
on MT6789.** Their kernel is *mgk*: `gki_defconfig` merged with
`mgk_64_k510_defconfig` (646 lines, 280 `CONFIG_MTK*`), then
`entry_level.config`, then the board's `q20_v12_factory.config` — on a tree that
carries `drivers/misc/mediatek` and `drivers/gpu/mediatek` out of tree. The stock
modules' CRCs follow that. No ACK build of any vintage can match them.

So the port builds the **device's own kernel**, from
`LineageOS/android_kernel_xelex_mt6789` (`lineage-23.2`, at 5.10.198 — exactly
the stock kernel's version), with the device's own four-fragment config chain
plus a LuneOS delta. The KMI discipline is unchanged — stock `vendor_boot` and
`vendor_dlkm` stay, we replace only the kernel — but the baseline to reproduce is
MediaTek's, not Google's.

This is worth generalising: **"GKI device" does not imply "ACK kernel will do".**
The test is cheap and decisive (`kmi-crc-check.py` against the stock `.ko` set)
and it should be run before assuming the one-kernel-per-KMI property holds.

### The bisect

All numbers against the full 344-module set (180 from the `vendor_boot` ramdisk
+ 184 from `vendor_dlkm`), `kmi-crc-check.py`:

| Kernel | Result |
|---|---|
| ACK 5.10.250 (Halium fork) + `gki_defconfig` + droidian + LuneOS fragments | **344 of 344 would fail** |
| device tree 5.10.198, device config chain, **no** LuneOS delta | **0 would fail** |
| + full LuneOS delta incl. `SYSVIPC`/`IPC_NS`/`USER_NS` | **344 would fail** |
| + LuneOS delta with those held out | **0 would fail** ← shipped |

**KMI-poison list for MediaTek mgk android12-5.10 on MT6789:**
`CONFIG_SYSVIPC` (with `SYSVIPC_SYSCTL`, `IPC_NS`) and `CONFIG_USER_NS`.

Everything else LuneOS needs is clean: `PID_NS`, `CHECKPOINT_RESTORE`,
`DEVTMPFS(+MOUNT)`, `FHANDLE`, `TMPFS_XATTR`/`POSIX_ACL`, `AUTOFS_FS`, `VT`,
`QUOTA_NETLINK_INTERFACE`, `UEVENT_HELPER`, `STATIC_USERMODEHELPER=n`, the whole
netfilter/PPP/L2TP block, the bluez/vhci set, `VETH`. That `PID_NS` is clean and
`SYSVIPC` is not is **the same answer bluejay's bisect gave on android14-6.1** —
two different SoCs, two different KMIs, same shape.

The two poisoned options were held out as a group, not separated from each other;
neither is needed, so the extra build was not spent.

Userland consequences, and they are real:
- No SysV IPC — watch Qt's `QSharedMemory`/`QSystemSemaphore`. POSIX shm and
  semaphores are unaffected.
- LXC must not unshare the IPC or user namespaces. `PID_NS` is available.

Escape hatch if SysV IPC ever turns out to be load-bearing: the Halium fork of
ACK carries *"GKI: use Android ABI padding for SYSVIPC task_struct fields"*,
which puts the new members in the reserved KABI padding so the CRCs do not move.
Cherry-picking it onto the MTK tree is untried but is the known shape of the fix.

### 5.10 kbuild gotchas (not device-specific — expect them on any 5.10 port)

Three of these cost a build cycle each:

| Symptom | Cause | Fix |
|---|---|---|
| `register 'sp' unsuitable for global register variables on this target` in `asm-offsets.c` | 5.10 derives clang's `--target` from `CROSS_COMPILE`; `LLVM=1` alone does not imply one (6.1 works it out from `ARCH`). clang was building for the x86_64 host | `CROSS_COMPILE=aarch64-linux-gnu-` — only the triple is used, no GNU binutils needed |
| wants an external assembler | 5.10 defaults to `-fno-integrated-as` | `LLVM_IAS=1` |
| whole kernel compiles, then `link-vmlinux.sh: python: not found` | 5.10 still spells `PYTHON` as `python`, and calls `scripts/jobserver-exec` | `PYTHON=python3`. Droidian's CI symlinks `python`→`python2`, which is both host-wide and the wrong interpreter — `jobserver-exec` parses clean as python3 |

Plus `CROSS_COMPILE_COMPAT=arm-linux-gnueabi-`, because `CONFIG_COMPAT_VDSO=y`.

## What was wired up

Everything below is in place and `MACHINE=q25 bitbake --dry-run
luneos-bootimg-gki` resolves the full graph (1657 tasks).

**New layer `meta-smartphone/meta-zinwa`** (added to `conf/bblayers.conf`):

| File | Role |
|---|---|
| `conf/layer.conf` | `zinwa-layer`, depends on core + openembedded-layer + android-layer |
| `conf/machine/q25.conf` | the machine. Boot-image only, like bluejay: no rootfs, no GSI baked in |
| `recipes-core/udev/udev-extraconf/70-q25.rules` | `Q25_keyboard` input tagging, `wmtWifi`/`stpbt`/`stpgps`/`conninfra_dev`/`accdet` ownership. Installed into the **generic halium-arm64 rootfs**, as sargo's are |
| `recipes-core/luneos-device-config/.../Q25-deviceinfo` | Tier 1: key devices, display DPI, device pixel ratio. Installed as `adaptations/Q25` with a lowercase symlink |
| `recipes-kernel/linux/linux-zinwa-q25_git.bb` + `files/luneos.cfg` | **the kernel** — device tree, device config chain, LuneOS delta, KMI-verified |

**`meta-smartphone/meta-android`** (generic):

| Change | Why |
|---|---|
| *(an ACK `android12-5.10` recipe lived here briefly and was removed once measurement showed it cannot serve this device — see above. The 6.1 one is untouched.)* |
| `recipes-bsp/gki-bootimg/luneos-bootimg-gki_1.0.bb` | **moved here from meta-google** and gated on `GKI_BOOTIMG = "1"` instead of a `^(bluejay\|panther)$` regex, so adding a GKI device is one line in its own machine conf. The recipe never was Google-specific; the class it inherits already lived here |
| `classes/gki_bootimg.bbclass` | `GKI_KERNEL_IMAGE_NAME` (default `Image.lz4`) so a machine can ask for `Image.gz` |
| `recipes-core/udev/udev-extraconf/65-android.rules` | `/dev/mali0` 0666 `system:graphics`, next to the existing `kgsl` and `pvr_sync` rules. Device-class, not q25-specific — same failure mode as pvr_sync (only root gets a GL context, so the compositor renders and every sandboxed GPU process does not) |

**`meta-smartphone/meta-google`**: `GKI_BOOTIMG = "1"` and
`PREFERRED_VERSION_linux-halium-gki = "6.1%"` added to `bluejay.conf` and
`panther.conf` — behaviour unchanged, they just now say out loud which KMI they
want, because there are two.

**`meta-webos-ports/meta-luneos`**: `nyx-modules/q25.cmake`, a copy of
`halium-arm64.cmake` (a machine without one does not parse).

**`conf/local.conf`**: `GKI_CLANG_DIR:q25` / `GKI_BUILD_TOOLS_DIR:q25`
machine-scoped, because android12-5.10 wants clang **r416183b** and the
existing unscoped values are android14-6.1's **r487747c**. Machine overrides
win over the plain assignments for `MACHINE=q25` only; bluejay and panther are
untouched.

## Build

```sh
# once: the KMI's own toolchain (clang-r416183b, ~3 GB, prebuilts only)
/home/herrie/webos/LuneOS/zinwa/fetch-gki-toolchain.sh

cd /media/herrie/LuneOS/wrynose/webos-ports && . ./setup-env

MACHINE=q25 bitbake linux-zinwa-q25          # Image.gz + Module.symvers + kernel-config
MACHINE=q25 bitbake initramfs-android-image
MACHINE=q25 bitbake luneos-bootimg-gki       # boot-q25-luneos.img, -debug.img
```

Output in `tmp/deploy/images/q25/`. The rootfs is the shared one:

```sh
MACHINE=halium-arm64 bitbake luneos-dev-image
```

Timing, so nobody thinks it has hung: the kernel is ~20 min, almost all of it
the single-threaded `LTO vmlinux.o` link (the device config uses
`LTO_CLANG_FULL`). Editing `files/luneos.cfg` at all — comments included —
rehashes the task and costs a full rebuild.

To reproduce the stock baseline instead of the LuneOS one, put
`LUNEOS_KERNEL_FRAGMENT = "0"` in a conf file and pass it with `bitbake -R`.
Do that first whenever a KMI check fails: it separates "my delta broke it" from
"the tree or toolchain is wrong".

### Verified output, 13 Sep 2026

```
344 modules checked, 0 would fail to load

boot-q25-luneos.img   header v4, kernel 20,424,381 B, ramdisk 6,634,352 B,
                      os version 12.0.0, patch 2024-03
stock boot.img        header v4, kernel 20,174,525 B, ramdisk 1,189,717 B,
                      os version 12.0.0, patch 2024-03
```

27,066,368 B, 40% of the 64 MiB `boot` partition. Every header field matches
stock except the sizes and our deliberate command line.

## The stock firmware, and what it settled

`drive.zinwa.com` is a redirect to a public Google Drive folder
(`Q25-P26-Q27-res`). The path that matters:
`OS-Images / Q25 / MassProduction / With-GMS / OS-new-camera-0120-Q25-GMS.zip`
— 2.53 GiB, direct-downloadable with
`https://drive.usercontent.google.com/download?id=14F9dbToL6euSiRKtBRJ_l6PGQYne0QNl&export=download&confirm=t`.
Take the **OS** archive, not the OTA one. It is a full SP Flash Tool package:
scatter, preloader, every firmware blob, `boot.img`, `vendor_boot.img`,
`super.img`, vbmeta, and — usefully — the partitions' `.prop` files loose in the
tree, so the identity questions are answerable without unpacking anything.

Local copy: `firmware/OS-new-camera-0120-Q25-GMS.zip`, unpacked to
`firmware/stock/`.

| Question | Answer | Where it came from |
|---|---|---|
| Codename | **`Q25`** | `q20_v12_factory/vendor.prop`: `ro.product.vendor.device=Q25` — the exact property `luneos-device-config` reads first. The adaptation directory was already right |
| Vendor API level | **31** (Android 12) | same file: `ro.vndk.version=31`, `ro.board.first_api_level=31` |
| Which GSI | the existing **halium_arm64 16.0** one | `halium-luneos-16.0-20260910-1-halium_arm64.tar.bz2` already carries `com.android.vndk.v31` (alongside v30/v32/v33/v34). No VNDK-snapshot work of the kind mindphone needed |
| init_boot? | **no** | stock `boot.img` has a 1,189,717-byte ramdisk; no `init_boot.img` ships. The scatter's `init_boot_a/b` are unused |
| os_version field | 12.0.0 / 2024-03 | `unpack_bootimg` on the stock boot.img. `ANDROID_BOOTIMG_OS_VERSION = "0x18000183"` reproduces it exactly |
| boot cmdline | **empty** | ditto. `bootopt=...` lives in vendor_boot's cmdline, which stays stock — so the padded LuneOS cmdline displaces nothing |
| Kernel image | `Image.gz` | stock kernel is gzip, 5.10.198-android12-9 |
| Clang | `r416183b` | the stock kernel's own version string, matching what the recipe pins |

### The stock kernel config, and what it means for the fragment

`CONFIG_IKCONFIG_PROC=y`, so the config came straight out of the boot image:
`firmware/stock-config-5.10.198.txt` (2,669 options).
`mer_verify_kernel_config` on it gives **23 errors / 54 warnings**
(`firmware/mer-check-stock-q25.txt`) — almost exactly bluejay's 23/59.

**21 of the 23 are already covered** by the LuneOS fragment plus the fork's
`droidian.config`. The two that are not are the two that should not be:

- `NET_L3_MASTER_DEV` — deliberately left off (adds `l3mdev_ops` to
  `struct net_device`, which every vendor wifi module touches). ofono does not
  need VRF.
- `DUMMY` — the checker wants `n` while its own stock run shows Android ships
  `y`. Known checker quirk; keep the Android value.

That is the same shape bluejay finished in: a handful of remaining errors, every
one accounted for.

The stock config also confirms the reasoning behind the kernel choice:

| Option | Stock | Consequence |
|---|---|---|
| `SYSVIPC` | **not set** | the vendor modules were built without it, so enabling it plainly *would* move `task_struct` CRCs. The fork's ABI-padding patch is exactly why it is safe here and poison on bluejay |
| `PID_NS` | not set | ditto — and the `mali_kbase_mt6789` `find_get_pid` quirks exist because we turn it on |
| `MODVERSIONS` | `y` | the KMI check applies |
| `MODULE_SIG_FORCE` | not set | force-load is available as an escape hatch |
| `DEBUG_INFO_BTF` | not set | no pahole needed — the recipe already says so |
| `STATIC_USERMODEHELPER` | `y` | UMH is disabled in stock; the fragment unsets it so `request_module()` works |
| `VT`, `BT_HCIVHCI` | not set | both needed (bluebinder wants vhci); both come from `droidian.config` |
| `OVERLAY_FS` | **`y`** | the Tier 2 adaptation overlay path works here, unlike sargo's 4.9 kernel |
| `ANDROID_BINDERFS` | `y` | LuneOS's host-binderfs model works |
| `USB_CONFIGFS_RNDIS` + `ECM` | both `y` | both debug-network gadgets available |

### Getting the module set

`./extract-vendor-modules.sh firmware` reproduces it: 180 `.ko` out of the
vendor_boot ramdisk plus 184 out of `vendor_dlkm_a`, **344 unique** in
`firmware/vendor-modules/all/`. The two halves are different files and both
matter — `mali_kbase_mt6789.ko` and `mt6358-accdet.ko`, the two modules the
kernel quirks exist for, are in the `vendor_dlkm` half only.

This host has neither `lpunpack` nor `simg2img`, so `lpunpack.py` in this
directory is a minimal liblp reader (handles sparse input; `debugfs -R rdump`
then gets the files out of the ext4 without root).

## What is still needed

The kernel side is closed. What remains needs the device:

1. **Build the rootfs** (`MACHINE=halium-arm64 bitbake luneos-dev-image`) and the
   Halium 16 arm64 GSI tarball — the same one sargo runs; it already carries
   `com.android.vndk.v31`.
2. **Decide where `rootfs.img` and `android-rootfs.img` live** — flashed
   `userdata`, a microSD partition, or a `linux` partition carved out of
   `userdata` with `mtkclient`. See the install sketch.
3. **Flash and boot**, then work the debugging playbook stage by stage.
4. Re-check `mer_verify_kernel_config` against
   `tmp/deploy/images/q25/kernel-config` once, to confirm what remains is
   deliberate (expect `NET_L3_MASTER_DEV`, `DUMMY`, and now `SYSVIPC`).

Things that will want attention on first boot, in likely order:

- `mtk-load-modules.sh` in meta-android reads `/android/vendor/lib/modules`,
  which on a GKI device is an **absolute** symlink to `/vendor_dlkm/lib/modules`
  and so resolves on the *host*. It assumes the mindphone layout; expect it to
  need a vendor_dlkm-aware path here.
- The square panel: `deviceinfo_display_dpi` and `deviceinfo_device_pixel_ratio`
  are arithmetic, not tuning.
- The keyboard: one input node is the whole QWERTY, the toolbelt keys and the
  trackpad, so whatever decides "is there a hardware keyboard" sees an unusual
  device.

## The install kit

Built 13 Sep 2026: **`/media/herrie/LuneOS/q25-staging/`**, distributable as
`q25_20260913.zip` (1.22 GiB compressed, 4.15 GiB of payload).

| File | |
|---|---|
| `boot-q25-luneos.img` | 27 MB into the 64 MiB `boot` partition |
| `boot-q25-luneos-debug.img` | `enable_adb` variant |
| `userdata-luneos.img` | 4.2 GiB ext4 labelled `userdata`, holding `rootfs.img` (2.9 GiB, halium-arm64 wrynose 20260913) and `android-rootfs.img` (1.0 GiB, Halium 16 GSI `halium-luneos-16.0-20260910-1-halium_arm64`) side by side |
| `vbmeta.img` | Zinwa's own stock vbmeta |
| `install.sh`, `make-userdata.sh`, `README.md`, `SHA256SUMS` | |
| `userdata-src/` | the two images loose, for rebuilds (not zipped) |

Three deliberate differences from the bluejay kit:

1. **No `fastboot boot` anywhere.** MediaTek's lk frequently does not implement
   it, so the debug image is *flashed* rather than booted out of RAM, and the
   install never depends on the debug-boot + `adb push` dance bluejay uses.
2. **A prefilled `userdata` image rather than `fastboot format:ext4` + push.**
   `fastboot flash userdata <img>` is the route the Droidian port proves on this
   exact hardware; `fastboot format` would need lk to cooperate. The image is
   much smaller than the 228 GiB partition and grows on first boot.
3. **A confirmation prompt and a board-name check** (`q20_v12_factory` /
   `q20_v1_factory` / `Q25`), because this kit wipes the phone and nobody has
   ever booted it.

Two things were checked before trusting the shipped-image flow, since it is the
part with no bluejay precedent to lean on:

- `resize_userdata_if_needed()` in the shipped `halium-boot.sh` reads
  `/sys/class/block/<dev>/size` rather than grepping `/proc/partitions` for
  `mmcblk*`/`disk*`. The Q25 is UFS, so its userdata resolves to `/dev/sd*` and
  the old code would have left the filesystem at image size — silently.
- `identify_android_image()` searches `/tmpmnt/android-rootfs.img` first under
  the halium `file_layout`, which is what makes "the GSI sits next to rootfs.img
  on userdata" work.

The initramfs also carries e2fsprogs 1.47.4, so the `orphan_file` /
`metadata_csum_seed` features a modern host `mke2fs` writes are understood by
the `resize2fs` that has to grow the thing.

### Keeping Android

`install.sh` flashes the current slot, so Android there stops booting. The A/B
alternative — Android on A, LuneOS on B, switch with
`fastboot --set-active=other reboot` — is documented in the kit README but not
automated: it is only safe once slot B holds a complete matching firmware, and
getting that wrong leaves neither OS bootable.

## Install sketch (the manual sequence)

A/B, which gives the Droidian port's nicest property: **Android keeps slot A
and LuneOS takes slot B**, so the stock ROM stays bootable and switching is
`fastboot --set-active=other reboot`. Flashing slot B needs the stock firmware
flashed to slot B first (everything except `logo`, `super` and `boot_b`) or the
slot is in an unknown state — the Q25 wiki has the exact list.

```sh
fastboot --disable-verity --disable-verification flash vbmeta_b vbmeta.img
fastboot set_active b
fastboot flash boot_b   boot-q25-luneos.img
```

`rootfs.img` and `android-rootfs.img` then go into a filesystem the initramfs
can find. Three options, all of which the Q25 supports and none of which is
chosen yet:

- flashed `userdata` image (mindphone/sargo style),
- a microSD partition (Droidian's default, and the one that touches nothing),
- a dedicated `linux` partition carved out of `userdata` with `mtkclient` and
  one of the wiki's pre-built GPT blobs.

Anti-rollback: unknown on this device. Assume it exists, never flash older
firmware than what is on it.

## How much of mindphone transfers (both are MediaTek)

Short answer: the *method* transfers, almost none of the *specifics* do. MT6739
and MT6789 are two generations and a different connectivity family apart, and
mindphone is pre-GKI while the Q25 is GKI-shaped.

| | mindphone (MT6739) | q25 (MT6789) |
|---|---|---|
| Android / kernel | 11 / 4.14, 32-bit | 12 / 5.10 mgk, arm64 |
| Partitions | non-dynamic, no vendor_boot | A/B, dynamic `super`, `vendor_dlkm` |
| Connectivity family | WMT (`wmt_drv`, `wlan_drv_gen2`, `bt_drv`, `gps_drv`) | connac1x (`wmt_drv`, `wmt_chrdev_wifi`, `wlan_drv_gen4m_6789`, `bt_drv_connac1x`, `connfem`) |
| Where the modules live | `/vendor/lib/modules` directly | `/vendor/lib/modules` → **absolute symlink** to `/vendor_dlkm/lib/modules` |
| How they are declared | vendor's `modules.load` | vendor's **init rc** `insmod` lines, property-templated |
| Stock module CRCs vs ours | mismatch → `--force` required | **match** → only vermagic differs |

### What transfers unchanged

- The whole `mtk-connectivity` idea: mirror the vendor's `.ko` into
  `/lib/modules`, `depmod`, load them host-side, then poke `/dev/wmtWifi` and
  fix `/dev/stpbt` ownership for the container's BT HAL.
- `mtk-bt-address.sh` — the BT MAC is the first six bytes of
  `/mnt/vendor/nvdata/APCFG/APRDEB/BT_Addr` on both. The Q25's `fstab.mt6789`
  does mount `/mnt/vendor/nvdata`, so the path is right.
- The `/data/nvram` symlink for `wmt_drv`'s kernel-space nvram open.
- The `fstab.<ro.hardware>`-over-`fstab.enableswap` selection fix that mindphone
  forced — already generic, and the Q25 needs it for the same MTK NV partitions.

### The `/vendor_dlkm` symlink is a non-issue (I flagged it wrongly at first)

`/vendor/lib/modules` is an absolute symlink to `/vendor_dlkm/lib/modules`, so
reading it through `/android/vendor/...` resolves against the **host** root.
That is fine, because `mount-android.sh` deliberately mounts `vendor_dlkm` at
host `/vendor_dlkm` — it cannot go under `$ANDROID_ROOT`, since LXC drops
anything mounted on the container rootfs. Checked on the real images:
`/vendor_dlkm/etc/build.prop` exists, so `try_mount_validated` accepts the
mount, and `/vendor_dlkm/lib/modules/modules.load` is there.

### What did NOT transfer, and had to be fixed

Two real bugs, both found by reading the Q25's own vendor partition:

1. **`mtk-load-modules.sh` picked the wrong modules.** It drove off the
   vendor's `modules.load`, which on MT6789 contains only `connadp.ko` and
   `c2k_usb_f_via_gps.ko` of the connectivity family — the real drivers are
   `insmod`ed by the vendor's init rc behind a two-stage gate:

   | trigger | modules |
   |---|---|
   | `on boot` | `wmt_drv.ko`, `connfem.ko` |
   | `on property:vendor.connsys.driver.ready=yes` | `${ro.vendor.wlan.chrdev}`, `wlan_drv_${ro.vendor.wlan.gen}`, `bt_drv_${ro.vendor.bt.platform}`, `${ro.vendor.gps.chrdev}`, `gps_pwr`, `fmradio_drv_${ro.vendor.fm.platform}` |

   That property is set by the container's own connsys daemon after it patches
   the CONSYS firmware — the same class of never-fires gate as the
   `wait_for_prop` problem `start-android-hals.sh` solves. The script now
   **derives** the ordered list from the rc files and expands the property
   templates off the mounted vendor partition, which keeps it device-agnostic.
   Verified offline against the Q25's own rc files and `build.prop`:

   ```
   connfem  wmt_drv  bt_drv_connac1x  fmradio_drv_mt6631_6635
   gps_drv_stp  gps_pwr  wmt_chrdev_wifi  wlan_drv_gen4m_6789
   ```

   with `wmt_drv` correctly ahead of the Wi-Fi pair. The `modules.load` path is
   kept as a fallback for the WMT era.

2. **The Bluetooth unit never ran.** `mtk-connectivity-bt.service` gated on
   `ConditionPathExists=|…/bt_drv.ko` or `…/conninfra.ko`; the Q25 has
   `bt_drv_connac1x.ko` and **no** `conninfra.ko` at all, so neither matched and
   systemd skipped the unit silently. Now `ConditionPathExistsGlob` with
   `bt_drv*.ko` / `conninfra*.ko`.

Also changed: the loader tries plain `modprobe`, then `--force-vermagic`, then
`--force`. On a KMI-preserving port only the vermagic string differs — ours is
`5.10.198-g2a873a3511ee` against stock's `5.10.198-android12-9-gfcab0aff02db`,
with `SMP preempt mod_unload modversions aarch64` identical — so
`--force-modversions` is not wanted, and blanket `--force` would hide a real CRC
regression. The fallback chain keeps mindphone working, where the CRCs genuinely
do disagree.

### Still mindphone-only, and worth revisiting on hardware

- **`mtk-ril-watchdog`** (in `meta-greentouch`, so mindphone-only today).
  The Q25's `mtkrild.rc` declares `vendor.ril-daemon-mtk` with the *identical*
  `oneshot` + `disabled` pair that means init will not respawn it, and it runs
  the same `mtkfusionrild`. If telephony dies once and stays dead, this is the
  fix — but it needs moving to `meta-android` (the Q25 builds no rootfs of its
  own) and it should not be moved blind.
- **`bluebinder`'s `mt6739-le-commands.conf`.** That patches an MT6739
  controller that under-reports its LE supported-commands bitmap. The Q25 is
  connac1x, a different controller; do not copy it. If LE discovery finds
  nothing while classic inquiry works, that file is the known *shape* of the
  fix, with a bitmap derived for this chip.

## Known hazards, inherited from the Droidian port

Worth reading before concluding any of these is a LuneOS bug:

- **The 20-character cmdline.** MediaTek's G99 lk drops the first 20 characters
  of the boot image command line. `ANDROID_BOOTIMG_CMDLINE` pads with `?`
  accordingly. Anything LuneOS really needs goes in `CONFIG_CMDLINE` instead,
  which is where the cgroup-v1 pair lives.
- `/vendor/lib/modules` on a GKI device is an **absolute** symlink to
  `/vendor_dlkm/lib/modules`, which resolves on the *host* when LuneOS reads it
  through `/android/vendor/...`. `mtk-load-modules.sh` in meta-android assumes
  the mindphone layout; expect it to need a vendor_dlkm-aware path here.
- Backlight IC varies between units: `ocp2131` on early ones, `rt4831a` on
  final. `ocp2131_drv.ko` is in the shipped module list.
- Headset: needs replugging if present at boot; mic is always routed from the
  jack. Both are kernel-workaround artefacts on Droidian.
- Hotspot needs `echo A > /dev/wmtWifi` rather than the UI toggle.
- Signal strength is under-reported by the modem stack.

## Sources

- https://github.com/JamiKettunen/droidian-zinwa-q25 (+ its wiki)
- https://gitlab.com/deathmist/halium-gki/-/tree/q25-droidian
- https://gitlab.com/deathmist/kernel-android-common/-/tree/common-android12-5.10-droidian
- https://github.com/LineageOS/android_device_xelex_Q25
- https://github.com/LineageOS/android_kernel_xelex_mt6789
- https://wiki.lineageos.org/devices/Q25/
