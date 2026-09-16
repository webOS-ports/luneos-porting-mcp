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

### Step 3: The KMI-poison list (empirical, per-KMI)

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

The poison list transfers within a KMI — panther (same `android14-6.1` KMI)
confirmed the same fragment unchanged (204/204 modules, 0 mismatches) — but it is
**a property of the specific KMI/kernel tree, not of GKI universally**. Q25
(MT6789, `android12-5.10`) proved the counter-case: the Droidian kernel fork it
builds from (`gitlab.com/deathmist/kernel-android-common`, branch
`common-android12-5.10-droidian`) carries *"GKI: use Android ABI padding for
SYSVIPC task_struct fields"* — the SYSVIPC fields go into the reserved ABI
padding instead of growing `task_struct`, the CRCs do not move, and **SYSVIPC is
safe on that KMI**. The difference is that patch, not the kernel version. (The
same fork hooks `find_get_pid` for `mali_kbase`/`mali_kbase_mt6789` and
`snd_soc_jack_report` for `mt6358_accdet` — quirks needed once `PID_NS=y` puts
the Mali driver's pid lookups in a namespace, and for headset detection.)

The Q25 also has its own, different poison list, confirmed ABI-breaking for
MT6789 on 5.10: `FANOTIFY`, `NF_TABLES`, `HUGETLBFS`,
`NETFILTER_XT_MATCH_NFACCT`, plus `CGROUP_PIDS` and `POSIX_MQUEUE` per the
Droidian wiki. deathmist's `droidian.config` enables them anyway and leans on the
fork's force-load patch; **LuneOS turns all six off instead** — a force-loaded
module that disagrees about a struct layout corrupts memory rather than failing
cleanly, and "the stock vendor modules load legitimately" is the entire Tier A
property.

**The working rule: re-derive the poison list per KMI with `kmi-crc-check.py`;
never transplant it between KMIs in either direction.**

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

### Step 4b: `CONFIG_MODULE_SIG_PROTECT` must be OFF — a failure class invisible to CRC checks

Found on bluejay (12 Sep 2026), and it is a **new "invisible to CRC" failure
class**: `kmi-crc-check.py` passes, yet the stock vendor modules still never
load. A GKI kernel with `CONFIG_MODULE_SIG_PROTECT=y` refuses (`-EACCES`) to let
a module it did not sign resolve *protected* symbols. A self-rebuilt GKI is not
signed with Google's key, so the phone's **own stock vendor modules count as
unsigned** — Wi-Fi/BT modules silently never loaded in the earlier bluejay kit,
and a CRC-only check cannot see it because the CRCs are fine.

Fix is one config line — `# CONFIG_MODULE_SIG_PROTECT is not set` — while
`MODULE_SIG`/`MODULE_SIG_ALL` stay `=y`; `internal.h` stubs both helpers when the
option is off, so no kernel source patch is needed (found via achunt2143's
bootimg PR, which patched the source instead). Verified KMI-clean, not assumed:
with it off, 203/203 factory vendor modules load, 0 CRC mismatches, and the
option confirmed off by reading the built kernel's IKCONFIG back.

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

**Kleaf fragment-comment trap** (cost one failed build, 12 Sep 2026): Kleaf
verifies a defconfig fragment by grepping it for the symbol token and **folds
comment lines into the expected value** — so a fragment must not mention, even
in a comment, a symbol it declares. The KMI-poison comment block in the bluejay
fragment is safe only because it names symbols the fragment never declares.

**Second KMI in the Yocto tree** (added for Q25, 12 Sep 2026): a
`linux-halium-gki_5.10.bb` recipe now sits beside the 6.1 one; boot-image
machines gate on `GKI_BOOTIMG = "1"` in their own machine conf (the recipe moved
out of a meta-google `^(bluejay|panther)$` regex); `GKI_KERNEL_IMAGE_NAME` lets a
machine ask for `Image.gz` instead of `Image.lz4`; and `GKI_CLANG_DIR` /
`GKI_BUILD_TOOLS_DIR` are machine-scoped in local.conf because android12-5.10
wants clang **r416183b** while android14-6.1 wants **r487747c**. bluejay/panther
now declare `GKI_BOOTIMG = "1"` + `PREFERRED_VERSION_linux-halium-gki = "6.1%"`
explicitly. See device-zinwa-q25.md for the 5.10 case study.

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

### Recurring vendor-kernel patch classes (from the other distros' Tier B experience)

Before inventing fixes, check whether the failure matches a documented class.
UBports' porting-notes GSI wiki
(https://github.com/ubports/porting-notes/wiki/Generic-system-image-(GSI))
catalogues recurring *code* patches for vendor kernels:

- **Samsung Qualcomm devices:** disable RKP (control-flow protection) configs and
  Samsung's file-integrity verifier — otherwise early crashes **with no logs at
  all**.
- **Revert tty workqueue changes** to avoid fastboot bootloops.
- **Revert binder security-context patches** for hwbinder HAL stability.
- **Module "magic mismatch ignore" patches** to load vendor-partition kernel
  modules — their cousin of our `CONFIG_MODULE_FORCE_LOAD=y` route on mindphone.
- **synx driver PID overflow** on msm-4.19+ kernels.
- **`skip_initramfs` revert** on A8–A10 kernels — without it a repacked boot.img
  never runs your init at all; see boot-images.md for the full trap.

Two calibration tricks worth trying before a mindphone-style six-round source-patch
series:

- **Match the toolchain to the Android generation** (Droidian docs): Droidian
  packages clang for Android 6.0/9.0/10.0/12.0/14.0 with a gcc-4.9 fallback, and
  their rule of thumb is that 4.4+ kernels should compile with clang. An era-matched
  compiler sidesteps most of the -Werror/new-keyword breakage that a modern host
  toolchain provokes (our `constexpr`/`#alloc`/`-Werror` rounds were all
  new-toolchain artifacts).
- **`ARCH=<arch> make savedefconfig`** (UBports docs) minimizes a full extracted
  config (IKCONFIG or `/proc/config.gz`) back into a defconfig — useful when the
  BSP drop doesn't name its defconfig as conveniently as mindphone's IKCONFIG did.

---

## Cross-distro config lists — use with care

Both UBports and Droidian publish "required kernel config" lists for Halium-style
ports. They are good references — **and both directly contradict our Tier A
KMI-poison list.** Know why before copying anything.

UBports' minimal `halium.config`
(https://docs.ubports.com/en/latest/porting/build_and_boot/standalone_kernel_build.html):

```
CONFIG_DEVTMPFS=y
CONFIG_FHANDLE=y
CONFIG_SYSVIPC=y
CONFIG_IPC_NS=y
CONFIG_NET_NS=y
CONFIG_PID_NS=y
CONFIG_USER_NS=y
CONFIG_UTS_NS=y
CONFIG_VT=y
```

Droidian's requirements (docs + their 5.10 fragments) likewise mandate
`SYSVIPC`, `IPC_NS`, `PID_NS`, `NET_NS`, `UTS_NS` (FANOTIFY commented out).

**`SYSVIPC` + `IPC_NS` are on our KMI-poison list.** The conflict is
architectural, not an error on either side: UBports and Droidian build a
**per-device kernel package** and do not reload the *stock* vendor modules
against it, so KMI preservation is not a constraint they have. LuneOS Tier A
depends on exactly that property. The rule:

> Cross-distro fragments are good **Tier B** starting points. They must never be
> applied to a **Tier A** GKI kernel without re-running `kmi-crc-check.py` —
> they will break the "stock vendor_dlkm still loads" property.

Maintained fragment source worth watching: **`droidian-devices/common_fragments`**
(https://github.com/droidian-devices/common_fragments) — branches
`4.14-android`, `4.19-android`, `5.10-android-common` (shared 5.10/5.15), each
with `halium.config`, `droidian.config`, `container.config` (Docker/cgroup set)
and `debug.config`, plus `5.10-android12.config`/`5.10-android13.config` deltas.

### Config facts from the other distros (fold into your fragment thinking)

Each item marked (KMI-check) must go through `kmi-crc-check.py` before use on a
Tier A kernel; the rest are behavioral.

- **`CONFIG_ANDROID_PARANOID_NETWORK` must stay ON** — disabling it for normal
  Linux networking breaks rild on hybris-12.1+ bases. SFOS wraps the capability
  checks in `#ifdef CONFIG_ANDROID_PARANOID_NETWORK` instead of removing the
  option (SFOS hadk-faq).
- **`CONFIG_BT_HCIVHCI=y` is bluebinder's kernel prerequisite** — bluebinder
  feeds the Android BT HAL into a virtual HCI. mindphone's working hci0 (vhci)
  depended on this; we never recorded the config until now (SFOS hadk-hot).
  The bluejay fragment now carries it as `=m`, with `hci_vhci` added to the
  Kleaf GKI module lists in `build-bootimg.sh` (12 Sep 2026). Legacy Qualcomm
  `hci_smd` is `CONFIG_BT_HCISMD` — already flagged elsewhere as copy-paste to
  delete.
- **`CONFIG_USB_CONFIGFS_RNDIS=y`** enables the RNDIS USB-networking debug
  channel (SSH into a half-booted device — see debugging.md). Droidian's symptom
  mapping: "stuck at the glowing logo and RNDIS is not working → check
  CONFIG_USB_CONFIGFS_RNDIS" (Droidian docs). Measured device split: stock GKI
  6.1 (bluejay/panther) has RNDIS **off** but `CONFIG_USB_CONFIGFS_ECM=y`;
  mindphone's 4.14 has RNDIS **on** and ECM off; athena's 4.19 defconfig has
  RNDIS on. The LuneOS initramfs debug network tries both gadget functions, so
  neither needs adding to a fragment just for telnet — but a host talking to
  an ECM gadget must be Linux/macOS (no native Windows driver).
- **`CONFIG_NETCONSOLE=y` + `CONFIG_NETCONSOLE_DYNAMIC=y` — Tier B only.**
  Streams kmsg to the host over UDP (the initramfs attaches a dynamic target
  after the gadget network is up; listen with `nc -ul 6666`), surviving
  switch_root. In the athena and mindphone fragments. **KMI-poison on Tier A:
  NETCONSOLE selects NETPOLL, which adds `npinfo` to `struct net_device` —
  the same genksyms-CRC class as SYSVIPC, and net_device is touched by every
  vendor wifi module.** The tenderloin mainline port instead bakes
  `netconsole=6665@172.16.42.2/usb0,6666@172.16.42.1/` into `CONFIG_CMDLINE`
  for true pre-userspace logging — possible only because it also sets
  `CONFIG_USB_ETH=y` (built-in `g_ether` creates `usb0` at kernel boot).
  **Never put `netconsole=` on the cmdline of a configfs-gadget kernel:**
  verified in the athena 4.19 source, a target whose device doesn't exist at
  init makes `init_netconsole()` unwind entirely, taking the dynamic configfs
  interface down with it. Use dynamic attach from the initramfs plus the
  dmesg replay instead (see debugging.md), and put `printk.devkmsg=on` on the
  cmdline so the replay isn't ratelimited.
- **pstore/ramoops needs config to exist**: `CONFIG_PSTORE=y`,
  `CONFIG_PSTORE_CONSOLE=y`, `CONFIG_PSTORE_RAM=y`,
  `CONFIG_PSTORE_RAM_ANNOTATION_APPEND=y` (Droidian `debug.config`). Our
  playbook's first debug step assumes ramoops works — on a device that lacks it,
  these options (KMI-check on Tier A) are what create it.
- **Binder device models differ**: Droidian's baseline wants
  `CONFIG_ANDROID_BINDERFS=n` with a static
  `CONFIG_ANDROID_BINDER_DEVICES="binder,hwbinder,vndbinder,anbox-binder,anbox-hwbinder,anbox-vndbinder"`
  — the `anbox-*` triple exists for Waydroid. LuneOS instead mounts **binderfs on
  the host** and binds it into the container. Either model works, but Waydroid
  needs its own binder trio whichever way the nodes are created, plus
  `CONFIG_VETH=y` and `CONFIG_NETFILTER_XT_TARGET_CHECKSUM=y` for its networking
  (Droidian common_fragments).
- **Recent-kernel toggles** seen in Droidian's 5.10 fragments (each KMI-check
  before Tier A use): `CONFIG_LTO_CLANG_FULL=n` + `CONFIG_LTO_CLANG_THIN=y`,
  `CONFIG_ARM64_BTI=n`, `CONFIG_NULL_TTY=y`.
- **Their GKI cmdline example** (in-fragment `CONFIG_CMDLINE`, Droidian):
  `stack_depot_disable=on kasan.stacktrace=off kvm-arm.mode=protected
  cgroup_disable=pressure cgroup.memory=nokmem selinux=0 droidian.lvm.prefer
  console=tty0` — notably `selinux=0` and `cgroup_disable=pressure`; `console=tty0`
  also doubles as a boot-hang fix (see boot-images.md/debugging.md).

### Vendor floor for the oldest GSI generation

The Halium 9 GSI requires an **Android 9 vendor** as its base — Android 8.0/8.1
vendors are only "experimental" (UBports porting-notes). Record this next to the
vendor-API-level table when triaging very old devices.

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

## CONFIG_SYSVIPC is not optional on LuneOS (and GKI defaults it off)

Android does not use SysV IPC, so GKI configs ship `# CONFIG_SYSVIPC is not set`.
LuneOS **does** need it: `libPmLogLib.so` calls `shmget()`/`shmat()`. Without
SysV IPC every `PmLogCtl` invocation blocks forever waiting for
`com.webos.pmlogd` to answer, and PmLog is wired into far more than logging —
`luna-service2` itself depends on `pmloglib`.

Measured on MP01 (MT6789), 15 Sep 2026. Five units died on 90s timeouts with
**no output of their own**:

```
surface-manager-daemon   db8-maindb   db8-mediadb   bluebinder   camera-droid-heal
```

`surface-manager.sh` calls `PmLogCtl def surface-manager` on its *first line*,
above every log statement — so the compositor never starts and the screen never
comes on, with nothing whatsoever in the journal to say why. `sh -x` as the
ExecStart wrapper is what exposed it.

**How to recognise it in two commands:**

```
$ ls -d /proc/sysvipc                       # absent  -> SYSVIPC is off
$ strings /usr/lib/libPmLogLib.so.3 | grep -E 'shmget|shmat'
```

### Enabling it without destroying the KMI

Turning `CONFIG_SYSVIPC=y` on normally appends `sysvsem`/`sysvshm` to the middle
of `task_struct`, shifting every field after them. That moves `module_layout`
and every other CRC: measured as **344 of 344 stock modules refusing to load**
on this SoC. Do not just flip it.

Park the two members in the reserved Android KABI padding instead. The whole
trick is one line in `include/linux/android_kabi.h`:

```c
#ifdef __GENKSYMS__
#define _ANDROID_KABI_REPLACE(_orig, _new)	_orig
```

genksyms computes CRCs from the `_orig` arm, so it still sees
`u64 android_kabi_reservedN` exactly as the stock `CONFIG_SYSVIPC=n` kernel did,
while the compiler sees a union carrying the real fields. Sizes pick the slots:
`sysv_sem` is one pointer and fits one slot via `ANDROID_KABI_USE(6, ...)`;
`sysv_shm` is a `list_head` (16 bytes) and no USE macro spans two slots, so
write that union longhand across slots 7 and 8.

Check before writing the patch: `CONFIG_ANDROID_KABI_RESERVE=y`,
`CONFIG_MODVERSIONS=y`, which reserve slots are still free (slot 1 is usually
`pf_io_worker`), and that `init/init_task.c` has no `.sysvsem` initializer.

Result on MP01: `/proc/sysvipc` present, all 159 vendor modules loading,
**0 "disagrees about version"**. Leave `CONFIG_IPC_NS` off — `shmget()` does not
need it, it touches other structures, and LXC can be told not to unshare it with
`lxc.namespace.keep = ipc user`.

**Counting warnings correctly:** `dmesg | grep -c "Unknown symbol"` returned
**400** on a perfectly healthy boot — that is dependency-ordering noise from the
module load retry loop (`tcpc_class: Unknown symbol pd_dbg_info`), resolved on a
later pass. The CRC message is **"disagrees about version"**. Count that one.

## The vendor_dlkm module set is never loaded on Halium (Tier A only)

A GKI-era vendor ships kernel modules in **two** sets, and Halium only ever loads
the first:

| Set | Lives in | Loaded by | On Halium |
|---|---|---|---|
| vendor_boot ramdisk | `/lib/modules` in the vendor_boot ramdisk | the initramfs, early, to reach storage | **yes** |
| `vendor_dlkm` | the `vendor_dlkm` logical partition | Android's init, later | **no** |

Halium curtails the container's init on a `wait_for_prop` gate long before it
reaches the second set, and the initramfs cannot load it either (it is a logical
partition inside `super`, needing dm-linear that the initramfs has no tooling
for). So those modules simply never load, on any Tier A device.

On the MP01 that is **164 modules — more than the 159 the initramfs loads.**

The reason this is worth its own section is that the symptoms do not look
remotely like "missing kernel modules":

- `nvmem-mt635x-efuse.ko` lives in `vendor_dlkm`, while `mt635x-auxadc.ko` is in
  the early set and depends on it. The auxadc probe returns **-517**
  (`EPROBE_DEFER`) forever, the fuel gauge never comes up, and healthd reports
  `battery l=-1`. lk then paints a **battery icon with a question mark**, decides
  the device is in charger mode, starts Android's `charger` binary, and reboots
  in a loop. This reads exactly like a flat battery and is not one — the same
  device reported `v=4429` (4.43 V, essentially full) while showing it.
- The **touchscreen** drivers (`gt9886.ko`, `gt9896s.ko`, `focaltech_touch.ko`)
  are in `vendor_dlkm` too, so the panel has no touch at all, nothing advertises
  `ID_INPUT_TOUCHSCREEN`, and `luneos-device-config` leaves the compositor
  pointed at `evdevtouch:/dev/input/PLACEHOLDER`.

**Check for it on any new Tier A port, before blaming anything else:**

```
# how big is the set nobody loads?
wc -l < <vendor-modules>/dlkm/modules/modules.load
# is a driver you are missing in it rather than in the early set?
grep -iE 'touch|efuse|nvmem' <vendor-modules>/dlkm/modules/modules.load
# on the device
ls -d /proc/sysvipc; dmesg | grep -- -517
```

**Fix:** load them from `mount-android.sh`, after `vendor_dlkm` is mounted and
before the container's init starts (meta-android, `load_vendor_dlkm_modules`).
Guarded on `[ -d /vendor_dlkm/lib/modules ]`, so it is a no-op on devices
without the partition. Note `modules.load` is a **list, not a dependency
order** — the same trap as in the initramfs — so make repeated passes and stop
when a pass loads nothing new, rather than trusting the file's order.

**Who is affected:** any Android 12+ / GKI device with a `vendor_dlkm`
partition — MP01, and bluejay and panther when they start. **Not** affected:
pre-dynamic-partition devices, which have only one module set. mindphone
(MT6739, Android 11, kernel 4.14, no super/vendor_boot) is the clearest example
and is exactly why the same SoC vendor shows no such problem there. sargo has no
vendor_dlkm either.

## Rebuilding one kernel module without a full kernel build

Bitbake's kernel `do_compile` and plain `make modules` both take ~10 minutes on
a tree this size, because LTO relinks every module. When you only changed one
`.c`, neither is necessary. What does **not** work:

- `make ... drivers/foo/` - builds the objects but never links the `.ko`
- `make ... M=drivers/foo modules` - treats an in-tree dir as an external
  module directory and tries to rebuild unrelated files in it, which fails

What works, in seconds: build the object with the directory target, then link
the module by hand exactly as kbuild would:

```sh
export PATH=<clang-prebuilt>/bin:$PATH
make -C $S O=$B LLVM=1 LLVM_IAS=1 ARCH=arm64 \
     CROSS_COMPILE=aarch64-linux-gnu- -j64 drivers/regulator/

cd $B && ld.lld -r --build-id=sha1 -T scripts/module.lds \
    -o drivers/regulator/foo.ko \
       drivers/regulator/foo.o drivers/regulator/foo.mod.o
```

The `.mod.o`/`.mod.c` from the previous full build stay valid as long as the
module's exported symbols have not changed. Get the exact flags from bitbake's
own `temp/run.do_compile.*`, which records the make line verbatim.

Verify before flashing: `strings foo.ko | grep <a string from your change>`.

Combined with the fact that **our modules load fine next to the vendor's**
(same vermagic, KMI verified), this makes single-driver experiments a
sub-minute loop with `adb push` + `rmmod`/`insmod`, instead of a
build-flash-reboot cycle.
