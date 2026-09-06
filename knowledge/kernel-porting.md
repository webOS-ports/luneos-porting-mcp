# Kernel Porting for LuneOS (GKI Tier A and Legacy Tier B)

This document is the distilled kernel-porting method from the LuneOS GSI/GKI work
(Pixel 6a `bluejay`, Pixel 7 `panther`, MT6739 `mindphone`, Pixel 3a `sargo`).
The core insight: on GKI devices (Android 12+, kernel ≥5.10) you build **one kernel
per KMI, not per device** — the stock vendor modules keep loading because the KMI is
binary-stable — while pre-GKI devices need a per-device kernel built from the vendor
BSP source (Tier B). Both tiers hinge on the same three steps: extract the stock
config, compute the LuneOS delta with `mer_verify_kernel_config`, and (Tier A only)
verify KMI compatibility host-side with CRC tooling *before* flashing anything.

---

## Tier A — GKI devices (Android 12+, kernel ≥5.10)

### Step 1: Extract and audit the stock kernel config

Stock Pixel GKI kernels ship `IKCONFIG` (`CONFIG_IKCONFIG_PROC` is in the good list
below), so the config can be extracted from the stock `boot.img` kernel. On bluejay
this produced `stock-gki-config-6.1.145-bp4a.txt`.

Run `mer_verify_kernel_config` (from `gsigki/mer-kernel-check/`) on the stock config.
Bluejay stock result: **23 errors, 59 warnings** (`mer-check-stock.txt`). This
directly answers the migration plan's open question 2 for a real GKI device:
**`gki_defconfig` alone is NOT enough** — but the fragment is small and known.

**Missing hard requirements** (systemd/LuneOS) in stock GKI:

- `DEVTMPFS` (+ `DEVTMPFS_MOUNT`)
- `FHANDLE`
- `SYSVIPC` (+ `IPC_NS`) — *but see the KMI-poison list below*
- `TMPFS_POSIX_ACL`, `TMPFS_XATTR`
- `VT`
- netfilter/PPP/L2TP error items: `NF_LOG_IPV4/6`, `IP_NF_MATCH_RPFILTER`,
  `INET_AH`/`INET6_AH`, `INET_IPCOMP`, `PPP_*`, `L2TP_*`, `NET_L3_MASTER_DEV`,
  `DUMMY`, `QUOTA_NETLINK_INTERFACE`, `STATIC_USERMODEHELPER` off
- Also off in stock: `USER_NS`, `PID_NS`, `AUTOFS_FS`, `SQUASHFS`, `CHECKPOINT_RESTORE`

**Already good in stock GKI**: `NAMESPACES`, `NET_NS`, `UTS_NS`, `CGROUPS`
(+freezer, memcg, v2), `EXT4`, `F2FS`, `OVERLAY_FS`, `VETH`, `BRIDGE`, `TUN`,
`BLK_DEV_LOOP`, `BLK_DEV_DM`, binder+binderfs, `FUSE`, `SECCOMP`, `IKCONFIG_PROC`.

### Step 2: Understand the KMI/MODVERSIONS constraint

GKI kernels build with `CONFIG_MODVERSIONS=y` (`MODULE_SIG_FORCE` is **not** set on
bluejay). Config options that add fields to core structs (e.g. `CONFIG_SYSVIPC`
adds `task_struct.sysvsem`) change the genksyms CRCs of exported symbols. Under
MODVERSIONS, the stock vendor modules (vendor_boot dlkm fragment + `vendor_dlkm`,
or on A13-launch devices `vendor_kernel_boot` + `vendor_dlkm`) then **refuse to
load** against your rebuilt kernel — and losing them loses the whole Tier A property.

This is checkable **host-side, with no device**: build ACK + fragment, then compare
your `Module.symvers` CRCs against the `__versions` sections of the stock `.ko`s.

### Step 3: The KMI-poison list (empirical, final)

Bisect on bluejay (kernel-only rebuilds, ~5 min each):

```
tools/bazel build --config=use_source_tree_aosp \
  --//build/kernel/kleaf:defconfig_fragment=//luneos:luneos_defconfig \
  //aosp:kernel_aarch64
```

Drift measured with `symvers-drift.py`, load-compatibility with `kmi-crc-check.py`:

| Round | Removed | Drift | Modules failing |
|---|---|---|---|
| full fragment | — | 3145 | 203/203 |
| 1 | SYSVIPC, SYSVIPC_SYSCTL, IPC_NS | (n/a) | 190/203 |
| 2 | + FANOTIFY | 1214 | 162/203 |
| 3 | + PID_NS, NET_L3_MASTER_DEV | **0** | **2/203** |
| 4 | PID_NS back in | **0** | **2/203** |

**RESULT — KMI-poison list (final): `SYSVIPC` (+`IPC_NS`), `FANOTIFY`,
`NET_L3_MASTER_DEV`.** Everything else in the fragment — DEVTMPFS(+MOUNT), FHANDLE,
TMPFS_XATTR/POSIX_ACL, AUTOFS_FS, PID_NS, CHECKPOINT_RESTORE, VT,
STATIC_USERMODEHELPER=n, QUOTA_NETLINK, the whole netfilter/PPP/L2TP block — is
KMI-clean: zero CRC drift, 201/203 stock modules load (the 2 failures were
pre-existing ACK-pin skew, not config — see Step 5).

The poison list is a property of **GKI**, not of gs101: those options change *core*
struct layouts under MODVERSIONS. Panther confirmed the same fragment transfers
unchanged (204/204 modules, 0 mismatches).

**Userland consequences of the poison list staying off:**

- No SysV IPC — watch Qt `QSharedMemory`/`QSystemSemaphore` users.
- No fanotify (systemd is fine without it).
- No VRF/l3mdev (ofono is fine).
- **LXC must not unshare the IPC namespace** (PID_NS is available; IPC_NS is not).

Escape hatch stays: rebuild all google-modules from source (option B, below) and
ignore KMI entirely.

Final `mer_verify_kernel_config` on the shipped bluejay config
(`mer-check-luneos.txt`): 5 errors, all accounted for — SYSVIPC +
NET_L3_MASTER_DEV (deliberate), NF_LOG_IPV4/6 (checker predates the 5.13
`NF_LOG_SYSLOG` rename; we set it =y), DUMMY=y (stock Android value; the checker
wants n, contradicting its own stock run).

### Step 4: KMI verification workflow (host-side, no device needed)

1. Extract stock vendor modules from the factory image
   (`tools/extract-vendor-modules.sh` in the build repo reads both the
   `vendor_boot` dlkm fragment and `vendor_kernel_boot.img`).
2. Build the ACK kernel with your fragment (kernel-only target).
3. Run:
   ```
   python3 kmi-crc-check.py <kernel_aarch64_Module.symvers> <dir of stock .kos>
   ```
   It parses `__versions` from the stock `.ko`s with a native ELF parse (host
   `objcopy` can't read aarch64) and resolves module-to-module symbols via the
   stock set's `__crc_*` exports. Target: **0 modules would fail to load**.
4. `symvers-drift.py` quantifies exported-symbol CRC drift between a baseline
   symvers and yours — use it to bisect a config fragment when modules fail.

Bluejay baseline (stock config, from-source build): 201/203 factory
vendor_boot-dlkm modules load-compatible, 0 CRC mismatches. Panther:
`python3 ../bluejay/kmi-crc-check.py .../out-luneos-tierA/Module.symvers
vkb-modules` → 204 modules checked, 0 would fail to load.

### Step 5: The ACK pin bump (vendor hooks)

The only two bluejay failures at baseline were `vh_mm.ko` and `vh_sched.ko`: they
import vendor-hook tracepoints (`android_rvh_setscheduler_prio`,
`android_trigger_vendor_lmk_kill`, `android_vh_calculate_totalreserve_pages`)
absent from the manifest-pinned ACK checkout. Factory modules (ab14305268) were
built against a *newer* android14-6.1 tag than the manifest pin; the factory kernel
itself is yet another build (ab14219743) — Google ships kernel and modules
decoupled, which itself proves the KMI reliance.

Fix: bump `aosp/` from the manifest pin (6.1.124, `a4662a84a`) to tag
**`android14-6.1-2026-06_r7`** (6.1.172), via detached checkout:

```
git fetch --depth=1 <remote> android14-6.1-2026-06_r7 && git checkout FETCH_HEAD
```

(pre-bump sha saved in `aosp-pin-before-bump.txt`). Result: **203/203 factory
modules load, 0 CRC drift, +454 new exports** (add-only KMI growth).

Caveats:
- A future `repo sync` reverts `aosp/` to the manifest pin — re-checkout the tag
  and re-apply the `modules.bzl` ppp/l2tp trim. The checkout reverts
  `aosp/modules.bzl`; the `common/modules.bzl` edit persists.
- The **full dist fails on the bumped pin**: manifest-pinned google-modules
  (6.1.124-era) don't compile against 6.1.172 headers (`DWC3_LLUCTL` redefined
  -Werror in soc/gs dwc3, VLA in s3c2410_wdt). Irrelevant for Tier A — stock
  vendor modules are the whole point. Use the kernel-only build output
  (`out-luneos-tierA/`), not `out/bluejay/dist/`.

### Step 6: Build commands (Bazel/Kleaf, Pixel Tensor example)

Kernel source manifest:

```
repo init -u https://android.googlesource.com/kernel/manifest -b android-gs-bluejay-6.1-android16
```

= `kernel/common` @ android14-6.1 (path `aosp/`) + ~50 `private/google-modules/*`
repos (soc/gs, display/samsung, wlan/bcm*, bluetooth/broadcom, gpu, aoc, …) +
Kleaf/Bazel tooling. Tree synced at `/media/herrie/LuneOS/bluejay-kernel` (10 GB).
The same tree contains `private/devices/google/{gs201,pantah}` and
`build_pantah.sh` — the `android-gs-pantah-6.1-android16` manifest branch has the
same project set (only needed for option B on panther).

- Stock validation build: `./build_bluejay.sh --config=use_source_tree_aosp`
  (~7 min on 64 cores; dist has boot.img, dtbo, vendor_dlkm.img, all modules).
  Prebuilt GKI is the default (`--use_prebuilt_gki=true` in device.bazelrc);
  `use_source_tree_aosp` switches to building `//aosp` from source — required for
  any config change.
- LuneOS fragment: `luneos/luneos_defconfig` (+ a BUILD.bazel filegroup), applied
  via `--//build/kernel/kleaf:defconfig_fragment=//luneos:luneos_defconfig`.
  Archived copy: `gsigki/bluejay/luneos_defconfig`.
- Kernel-only build (what ships):
  ```
  tools/bazel build --config=use_source_tree_aosp \
    --//build/kernel/kleaf:defconfig_fragment=//luneos:luneos_defconfig \
    //aosp:kernel_aarch64
  ```

Add `CONFIG_UEVENT_HELPER=y` + `UEVENT_HELPER_PATH=""` to the fragment: the
initramfs's mdev writes `/sys/kernel/uevent_helper`, which stock GKI doesn't
provide — without it late hotplug events are lost (initial `mdev -s` covers the
normal path, but add it if by-partlabel links come up empty). It is behavioral and
KMI-safe; with it the bluejay kernel is still 203/203 factory-module compatible.

### One kernel per KMI, literally

Panther's stock kernel is **byte-identical** to bluejay's:

```
sha256(panther unpacked-boot/kernel) == sha256(bluejay unpacked-boot/kernel)
= 2be4a595a21371800d989059ae2bb2085ca8df45d44fa86f0d9ab79629ca2ceb
Linux version 6.1.145-android14-11-gc1de4747ac59-ab14219743, clang 17.0.2
```

One GKI per KMI, shipped identically on gs101 and gs201. The LuneOS Tier A kernel
(`out-luneos-tierA/Image.lz4`, ACK 6.1.172 + `luneos_defconfig` incl.
UEVENT_HELPER) is a drop-in for panther with **no rebuild, no second 10 GB sync**.
Re-run `kmi-crc-check.py` against the new device's own `.ko` set to confirm.

### The kernel deliberately stays outside bitbake

In the Yocto machines (`bluejay.conf`, `panther.conf`):
`PREFERRED_PROVIDER_virtual/kernel = "linux-dummy"`, and `GKI_KERNEL_IMAGE` (set
in local.conf) points at the Image that `build-bootimg.sh` produced. Rebuilding
ACK with OE's cross toolchain would move the exported-symbol CRCs under
MODVERSIONS and the stock vendor modules would stop loading — the whole Tier A
property. `do_deploy[file-checksums]` hashes the file so a new kernel really does
rebuild the boot images instead of returning stale sstate.

### Option B escape hatch (own vendor modules)

Pixel kernels are fully open source including all vendor modules, so a full
rebuild (kernel + modules + repacked vendor_boot/vendor_dlkm) is available if KMI
preservation ever fails. Build it at the **manifest-matched** state (6.1.124 on
bluejay), where the full dist succeeded — not on the bumped pin. This is a
device-specific fallback that loses the "one kernel per KMI" property but keeps a
port moving. It also ignores the poison list entirely (everything rebuilds against
the new CRCs).

### Anti-rollback (ARB) — check before flashing

Bluejay's bootloader ARB was bumped by Android 13 (Oct 2022) and again by the May
2025 update. A device on Android 16 cannot boot anything older than the May-2025
A15 build; flashing older factory images risks a permanent brick (including the
inactive-slot fallback trap — keep both slots consistent). On such devices there
is **no downgrade ladder**: the port targets the current kernel + vendor + GSI,
full stop. Same shape on panther: never flash older than the installed build; if
the device arrives on a newer build (e.g. Android 17), redo the factory-image
analysis against that build.

---

## Tier B — legacy devices (pre-GKI, vendor BSP kernel)

Case study: **mindphone** (MediaTek MT6739, Android 11, kernel 4.14.186).

### Identify the platform precisely first

From the stock boot.img: 32-bit ARM zImage (gzip inside), Linux
4.14.186-gbba62e33f-dirty, clang 11.0.1 (Android r383902). The SoC is 64-bit but
runs a **32-bit kernel + 32-bit userland** (`bootopt=64S3,32S1,32S1`). The port
was originally set up arm64 (arch-arm64.inc, Image.gz-dtb, qcom cmdline, arm64
defconfig, halium_arm64 GSI) — wrong on every count. Get TARGET_ARCH, the kernel
image type (`zImage`, armv7 build — not Image.gz/arm64), the serial console
(ttyMT0) and the tune right in the machine conf before anything else
(mindphone uses tune-cortexa8, sharing halium sstate with hammerhead/tenderloin).

### Find the stock defconfig via IKCONFIG

Stock IKCONFIG names the BSP project: `k39tv1_bsp_1g` → defconfig is
`arch/arm/configs/k39tv1_bsp_1g_defconfig` in the vendor GPL drop. The LuneOS
delta is a `file://luneos.cfg` fragment next to the recipe
(`recipes-kernel/linux/linux-greentouch-mindphone_git.bb`), ported from the arm64
`k39tv1_64_bsp_defconfig_luneos` with `CONFIG_DUMMY` kept =y. Run
`mer_verify_kernel_config` on the stock config too (mindphone stock: 13 errors /
58 warnings, `mer-check-stock-mindphone.txt`).

### Old BSP vs modern toolchain: expect a patch series

Building a 4.14 MTK BSP with gcc 14 / binutils 2.4x took six rounds of fixes, all
as layer patches next to the recipe:

1. `0001` — obsolete `#alloc` section-flag syntax in 28 arm32 asm files
   (backport of upstream 790756c7e022).
2. `0002` — `%llx` vs 32-bit `phys_addr_t` in mrdump.
3. `0003` — drop `-Werror` from 30 MTK vendor Makefiles.
4. `0004` — re-enable the commented-out Silead gslX680 point-id algorithm object
   (vmlinux link failure otherwise).
5. `0005` — disable `GSL_GESTURE` (only the no_gesture algorithm ships) + fix one
   unguarded u64 division in eccci.
6. `0006` — `constexpr` is a C23 keyword: rename it in `unifdef.c`.

Plus `CONFIG_FRAME_WARN=2048` in luneos.cfg.

The `unifdef.c` fix recurs on every old tree: sargo's 4.9 host tooling stopped
compiling because `unifdef.c` declares `static bool constexpr;` and modern host
GCC defaults to `-std=gnu23`. Pinning the host C standard (or renaming) is enough.

### Stock vendor modules on a rebuilt Tier B kernel

The MTK WMT combo driver (wifi/BT/GPS/FM core) is not in the GPL kernel drop —
only built-in adapter shims. The real drivers are stock vendor modules
(`/vendor/lib/modules`: wmt_drv, wmt_chrdev_wifi, wlan_drv_gen2, bt_drv,
gps_drv). Their CRCs disagree with the rebuilt kernel (module_layout — expected,
from the LuneOS config fragment), so:

- set `CONFIG_MODULE_FORCE_LOAD=y` in luneos.cfg,
- copy the modules to `/lib/modules/4.14.186/` + depmod,
- `modprobe --force -a` them (firmware_class path → `/android/vendor/firmware`).

Force-loading stock modules **proved safe in practice** on mindphone (wifi, BT,
GPS all came up). This is the Tier B analogue of the Tier A KMI discipline.

Caveat noted: luneos.cfg flips `FW_LOADER_USER_HELPER` off (halium default) while
stock has it on — if MTK wifi/firmware loading misbehaves, revisit.

### Build and deploy

```
cd webos-ports && . ./setup-env
MACHINE=mindphone bitbake linux-greentouch-mindphone
```

deploys `zImage-mindphone.fastboot` (= boot.img) under
`tmp/deploy/images/mindphone/`. Verify against stock by unpacking and diffing the
header fields (see boot-images.md). Kernel changes should eventually land on
shr-distribution `dnim/4.14.186` instead of living as layer files.

---

## mer-kernel-check usage (both tiers)

Location: `gsigki/mer-kernel-check/` (Makefile, `mer_verify_kernel_config`,
`mer_verify_kernel_spec`). Run `mer_verify_kernel_config` against any kernel
config — stock (to size the delta) and your shipped config (to confirm what
remains is deliberate). Known checker quirks to not chase:

- It predates the 5.13 `NF_LOG_SYSLOG` rename, so `NF_LOG_IPV4/6` errors persist
  even when the functionality is set (=y).
- It wants `DUMMY=n` while its own stock-config run shows Android ships =y — keep
  the stock Android value.

Interpret errors as "explain or fix", not "fix": on bluejay the final config ships
with 5 errors, every one accounted for.
