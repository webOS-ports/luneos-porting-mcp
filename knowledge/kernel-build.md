# Kernel Build: GKI Tier A and Vendor-BSP Tier B

How a LuneOS kernel is built: one ACK-based kernel per KMI on Tier A devices, the vendor's BSP tree per device on Tier B, and the traps of each.

On GKI devices (Android 12+, kernel ≥5.10) you build **one kernel per KMI, not per
device** — the stock vendor modules keep loading because the KMI is binary-stable —
while pre-GKI devices need a per-device kernel built from the vendor BSP source
(Tier B; the tiers are defined in architecture.md § Tier A vs Tier B kernels). Both
tiers hinge on the same three steps: extract the stock config, compute the LuneOS
delta (kernel-config.md § The config delta), and verify host-side, *before*
flashing anything, that the vendor's modules will still load
(kmi-crc-matching.md). Loading and shipping modules is kernel-modules.md; tool
usage is tools.md; SoC-family specifics are soc-mediatek.md and soc-qualcomm.md.

---

## Tier A — GKI devices (Android 12+, kernel ≥5.10)

### Step 1: Check that the stock kernel really is GKI

A GKI boot image and `android12-5.10` in the version string do not imply that an
ACK build will do. MediaTek ships its *mgk* derivative on MT6789: an ACK kernel
failed 344 of 344 stock modules on the Q25, `module_layout` included, and the
port builds the device's own tree instead (found on the Q25; see device-q25.md).
Run `kmi-crc-check.py` against a first ACK build before assuming the
one-kernel-per-KMI property holds.

### Step 2: The KMI/MODVERSIONS constraint

GKI kernels build with `CONFIG_MODVERSIONS=y` (`MODULE_SIG_FORCE` is **not** set on
bluejay). Config options that add fields to core structs (e.g.
`CONFIG_NET_L3_MASTER_DEV` adds `l3mdev_ops` to `struct net_device`) change the
genksyms CRCs of exported symbols. The stock vendor modules (vendor_boot dlkm
fragment + `vendor_dlkm`, or on A13-launch devices `vendor_kernel_boot` +
`vendor_dlkm`) then **refuse to load** against your rebuilt kernel — and losing
them loses the whole Tier A property.

### Step 3: Verify host-side, before any flash

1. Extract the stock vendor modules from the factory image
   (`extract-vendor-modules.sh`, tools.md; it reads both the `vendor_boot` dlkm
   fragment and `vendor_kernel_boot.img`).
2. Build ACK with your fragment (kernel-only target, Step 4).
3. Run `kmi-crc-check.py <Module.symvers> <dir of stock .kos>` (tools.md).
   Target: **0 modules would fail to load**.
4. If modules fail, bisect the fragment one option at a time with
   `symvers-drift.py` (kernel-config.md § Poison options has the method and the
   three-minute per-object harness). On bluejay the full fragment drifted 3145
   exported-symbol CRCs and failed 203/203 modules; with `FANOTIFY` and
   `NET_L3_MASTER_DEV` out, drift was 0.

### Step 4: Build ACK

Two routes produce the same kernel:

- **Yocto** (what LuneOS ships):
  `meta-android/recipes-kernel/linux-halium-gki/linux-halium-gki_6.1.bb` builds
  ACK android14-6.1 with the LuneOS fragment using Google's prebuilt clang 17
  (**r487747c**, the clang the KMI was frozen with) and plain kbuild — no Bazel,
  and not OE's cross toolchain: the compiler does not move CRCs, but clang-only
  options (`LTO_CLANG`, `CFI_CLANG`, `SHADOW_CALL_STACK`) switch off under GCC and
  change the kernel (kmi-crc-matching.md § Step 4), so the KMI's own clang is what
  keeps the stock `vendor_boot`/`vendor_dlkm` modules loading. `luneos-bootimg-gki`
  (with `meta-android/classes/gki_bootimg.bbclass`) consumes it by default via
  `GKI_KERNEL_PROVIDER ?= "linux-halium-gki"`; setting `GKI_KERNEL_IMAGE` overrides
  that with an out-of-tree Image (e.g. one built by `build-bootimg.sh` in
  github.com/Herrie82/luneos-bootimg-bluejay), which
  `do_deploy[file-checksums]` hashes so a new kernel really does rebuild the boot
  images instead of returning stale sstate. Machines opt in with
  `GKI_BOOTIMG = "1"` in their own machine conf; `GKI_KERNEL_IMAGE_NAME` asks for
  `Image.gz` instead of `Image.lz4`; `GKI_CLANG_DIR` / `GKI_BUILD_TOOLS_DIR` are
  machine-scoped in local.conf because a 5.10 kernel wants clang **r416183b**
  while android14-6.1 wants **r487747c**. bluejay, panther and tangorpro use the
  6.1 recipe (`PREFERRED_VERSION_linux-halium-gki = "6.1%"`); there is no
  `linux-halium-gki_5.10.bb`, and a device whose stock kernel is a vendor GKI
  derivative builds its own tree and names it (`GKI_KERNEL_PROVIDER =
  "linux-zinwa-q25"`). `PREFERRED_PROVIDER_virtual/kernel = "linux-dummy"` only
  means the rootfs carries no kernel. The recipe files: yocto.md § GKI device
  machines.
- **Kleaf** (Pixel kernel manifests, `repo init -u
  https://android.googlesource.com/kernel/manifest -b
  android-gs-<device>-6.1-android16`, about 10 GB). Prebuilt GKI is the default;
  `--config=use_source_tree_aosp` builds `//aosp` from source, which any config
  change needs. Put the fragment in a package with a `BUILD.bazel` filegroup and
  build the kernel alone:

  ```
  tools/bazel build --config=use_source_tree_aosp \
    --//build/kernel/kleaf:defconfig_fragment=//luneos:luneos_defconfig \
    //aosp:kernel_aarch64
  ```

### 5.10 kbuild gotchas

A 5.10 tree built with clang has traps a 6.1 one does not; expect them on any 5.10
port, each costs a build cycle (found on the Q25; see device-q25.md):

| Symptom | Cause | Fix |
|---|---|---|
| `register 'sp' unsuitable for global register variables on this target` in `asm-offsets.c` | 5.10 derives clang's `--target` from `CROSS_COMPILE`; `LLVM=1` alone does not imply one (6.1 works it out from `ARCH`), so clang built for the x86_64 host | `CROSS_COMPILE=aarch64-linux-gnu-` — only the triple is used |
| wants an external assembler | 5.10 defaults to `-fno-integrated-as` | `LLVM_IAS=1` |
| `link-vmlinux.sh: python: not found` after a full compile | 5.10 spells `PYTHON` as `python` and calls `scripts/jobserver-exec` | `PYTHON=python3` (Droidian's CI symlinks `python`→`python2`, host-wide and the wrong interpreter) |

Plus `CROSS_COMPILE_COMPAT=arm-linux-gnueabi-` wherever `CONFIG_COMPAT_VDSO=y`.

### Vendor-hook modules and the ACK tag

Factory vendor modules can be built against a **newer** ACK tag than the kernel
manifest pins, and Google ships kernel and modules decoupled. Modules that import
vendor-hook tracepoints (`android_rvh_*`, `android_vh_*`, `android_trigger_*`)
then fail against a build from the pinned checkout. Fix: check out an
`android14-6.1-<yyyy>-<mm>_r<n>` release tag new enough to carry them
(add-only KMI growth, no CRC drift). A later `repo sync` reverts the checkout,
and the manifest-pinned vendor-module sources may no longer compile against the
bumped headers — irrelevant for Tier A, where the stock modules are the point
(found on bluejay: `vh_mm.ko`/`vh_sched.ko`; see device-bluejay.md).

### One kernel per KMI

Panther's stock kernel is byte-identical to bluejay's (device-panther.md): one GKI
per KMI, shipped identically on gs101 and gs201. A LuneOS Tier A kernel built for
one device of a KMI is a drop-in for the others — re-run `kmi-crc-check.py`
against the new device's own `.ko` set to confirm.

### Option B escape hatch (own vendor modules)

Pixel kernels are fully open source including all vendor modules, so a full
rebuild (kernel + modules + repacked vendor_boot/vendor_dlkm) is available if KMI
preservation ever fails. Build it at the **manifest-matched** state, where the full
dist succeeds. It loses the "one kernel per KMI" property but keeps a port moving,
and it ignores the poison list entirely (kmi-crc-matching.md § Step −1).

Before flashing anything on a Pixel, check anti-rollback: installing.md §
Anti-rollback.

The vendor_dlkm module set and how the vendor's own loader gets to it: kernel-modules.md § The vendor_dlkm set.

---

## Tier B — legacy devices (pre-GKI, vendor BSP kernel)

### Identify the platform precisely first

Read it off the stock boot.img before writing a machine conf: kernel architecture
(a 64-bit SoC can run a **32-bit kernel + 32-bit userland**, as mindphone does
with `bootopt=64S3,32S1,32S1`), image type (`zImage` vs `Image.gz(-dtb)`), the
compiler in the version string, the serial console, and the tune. Get
TARGET_ARCH, the image type, the console and the tune right first (found on
mindphone, set up arm64 and wrong on every count; see device-mindphone.md).

### Find the stock defconfig via IKCONFIG

Stock IKCONFIG usually names the BSP project, and with it the defconfig in the
vendor GPL drop (mindphone: `k39tv1_bsp_1g` → `k39tv1_bsp_1g_defconfig`). Put the
LuneOS delta in a `file://luneos.cfg` fragment next to the recipe. When the drop
does not name its defconfig, `ARCH=<arch> make savedefconfig` (UBports docs)
minimises a full extracted config back into one.

### Old BSP vs modern toolchain: expect a patch series

A 4.14 MTK BSP took six rounds of layer patches with gcc 14 / binutils 2.4x
(device-mindphone.md has the series). The classes recur on any old tree:
obsolete asm syntax (`#alloc` section flags, upstream 790756c7e022), format
widths against 32-bit `phys_addr_t`, `-Werror` in vendor Makefiles, objects
commented out of a Makefile that the link still needs, and
`CONFIG_FRAME_WARN=2048`.

Host-tool and build-system traps that recur on old trees:

- **`unifdef.c` declares `static bool constexpr;`**, and `constexpr` is a keyword
  in C23, which modern host GCC defaults to (`-std=gnu23`). Seen on mindphone 4.14,
  sargo 4.9, fajita 4.9 and surya 4.14: pin the host C standard
  (`BUILD_CFLAGS:append = " -std=gnu17"`) or rename the identifier (mindphone's
  patch 0006).
- **Outside bitbake, OE's `gcc-cross` picks the host `as`** from `PATH` and dies with
  `as: unrecognized option '-EL'`. Pass `-B` at a directory of unprefixed symlinks
  via `KCFLAGS`/`KAFLAGS`, and keep that directory **out of `PATH`**, or the host
  tools (`fixdep`) link against the target `ld` (surya; bitbake handles both).
- **No `ifeq ($(KBUILD_EXTMOD),)` guard around `vdso_prepare`** in `arch/arm64/Makefile`
  makes every out-of-tree module stop with "No rule to make target 'prepare0'"
  (vince's patch 0010).

Before a long patch series, **match the toolchain to the Android generation**
(Droidian docs): Droidian packages clang for Android 6.0/9.0/10.0/12.0/14.0 with a
gcc-4.9 fallback, and its rule of thumb is that 4.4+ kernels should compile with
clang. An era-matched compiler sidesteps most of the -Werror/new-keyword breakage
a modern host toolchain provokes. Qualcomm trees: which toolchain (GCC miscompiled sunfish's SCM call) is in soc-qualcomm.md § Kernel.

### The phone's own modules

A rebuilt Tier B kernel refuses the phone's own modules
(`disagrees about version of symbol module_layout`): the stock defconfigs set
`CONFIG_MODVERSIONS`, and the LuneOS fragment changes the config. Where the kernel
source includes the modules, build them; force-load only what you cannot build,
and only after checking struct layouts. Tier B has an ABI to keep too: the stock
kernel's layout as seen by every prebuilt `.ko` on the vendor partition. Matching
is kmi-crc-matching.md (§ Step −1, § Force-loading prebuilt modules, § Struct
layouts); building and shipping your own is kernel-modules.md § Building and
shipping your own modules.

### Build and deploy

A Tier B kernel recipe (e.g. `MACHINE=mindphone bitbake linux-greentouch-mindphone`)
builds the kernel and the boot image in one, under `tmp/deploy/images/<machine>/`.
Verify the image against stock by unpacking and diffing the header fields (see
boot-images.md). Kernel changes belong on a shr-distribution kernel branch rather
than living as layer patches. The exception is a tree the project does not fork, kept as
recipe patches (vince: a third-party repository). **Unresolved:** mindphone, surya and
fajita also carry recipe patches on trees that could be forked; whether to move them is
not decided.

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
  modules — their cousin of `CONFIG_MODULE_FORCE_LOAD=y`.
- **synx driver PID overflow** on msm-4.19+ kernels.
- **`skip_initramfs` revert** (or `CONFIG_INITRAMFS_IGNORE_SKIP_FLAG`) on A8–A10
  kernels — without it a repacked boot.img never runs your init at all
  (boot-images.md § The `skip_initramfs` trap).

### `pidfd_open()` without `waitid(P_PIDFD)`: GLib reaps nothing (SM-T220, athena, mindphone)

Android's 4.14/4.19 trees carry the 5.3 pidfd work (`pidfd_open()`,
`pidfd_send_signal()`, `CLONE_PIDFD`) but not `waitid(P_PIDFD)`, which is 5.4. Upstream
those are one release apart, so userspace does not probe for the combination:
GLib ≥ 2.74 switches its `GChildWatchSource` to pidfds as soon as `pidfd_open()`
succeeds, then every child reap fails with
`waitid(pid:N, pidfd=M) failed: Invalid argument (22)` and the callback gets a wait
status of -1. Symptoms are in whatever spawns children through GLib: the webOS
media server's pipelines ("exited with status -1"), appinstalld2's package unpack
("Failed to extract package"), anything using `g_spawn` with a child watch.

Check a tree in seconds: `grep -n P_PIDFD include/uapi/linux/wait.h kernel/exit.c`
(absent = broken), or on a running device
`python3 -c "import os,subprocess,time; p=subprocess.Popen(['sleep','0.2']);
fd=os.pidfd_open(p.pid); time.sleep(.5); print(os.waitid(os.P_PIDFD,fd,os.WEXITED))"`.
The fix is upstream commit `3695eae5fee0605f316fbaad0b9e3de791d7dfaf` ("pidfd: add
P_PIDFD to waitid()"); shr-distribution/linux carries a working backport on its
`key2/4.19` and `dnim/4.14.186` branches, and it applied to Samsung's 4.19.191 with
only line-number offsets (five files: `pid.h`, `wait.h`, `exit.c`, `fork.c`,
`signal.c`). On 4.14 it needs one follow-up, "fork: CLONE_PIDFD: do not require a
zeroed *parent_tidptr", because Qt's `QProcess::startDetached()` otherwise fails
with EINVAL; **read `copy_process()` first**, the later 4.19 stable trees do not
have the check and do not need it.

### Vendor trees that stub out `net/bluetooth/hci_sock.c` (Samsung)

Samsung's MediaTek kernels comment out most of `hci_sock.c` and reduce
`hci_sock_create()` to `return 0`. Android never opens an HCI socket. Halium's
bluebinder does (`socket(AF_BLUETOOTH, SOCK_RAW, BTPROTO_HCI)`), `bt_sock_create()`
gets success with `sock->sk == NULL`, and `bt_sock_reclassify_lock()` hits
`BUG_ON(!sk)`; MediaTek's `ipanic_die()` then resets the device, which is a
boot loop of a fixed period (77 s on the SM-T220, 57 s of it in the kernel). Find it
in the ramoops console (`/sys/fs/pstore/console-ramoops-0`, readable in TWRP right
after a loop reset). The fix is to make the file identical to the tag again; on
this tree `net/bluetooth/` differed from v4.19.191 in that one file only, so check
with `diff -r` before writing anything clever.

### Legacy 3.x kernels: what the 16.0 GSI and LuneOS assume

Found on a 3.10 MSM8916 kernel (Galaxy A3 (2015); see device-a3-2015-halium.md);
check each on any pre-4.x Tier B port.

- **`COMMAND_LINE_SIZE` 1024 (arch/arm).** CONFIG_CMDLINE, the boot image's command
  line and a Samsung SBL's 775 bytes (passed on by lk2nd) overflow it, and
  everything past the cut is gone without a warning: `androidboot.baseband` (so
  `ro.baseband=unknown` and rmt_storage refuses to run), `androidboot.mode`,
  `androidboot.serialno`, `mdss_mdp.panel`. `wc -c /proc/cmdline` = 1024 is the
  tell. Raise it to 2048 (arm64 has always used 2048).
- **No `MemAvailable` in /proc/meminfo** before 3.14: memorymanager counts 0 MiB
  available and every app launch ends in "Failed to reclaim required memory. All
  apps were closed". The tenderloin commit "mm: add MemAvailable to
  /proc/meminfo" (si_mem_available()) applies unchanged to 3.4 and 3.10 trees;
  hammerhead, mako and bullhead have it.
- **Paranoid networking off breaks vendor daemons that rely on group net_raw**
  (see `ANDROID_PARANOID_NETWORK` below).
- **No `CONFIG_BT_HCIVHCI` / `CONFIG_RFKILL`** in an old defconfig: bluebinder
  exits "No such device".

Found on a 3.10 Spreadtrum kernel (SM-T113, sc8830; device-goyavewifi.md), one remote test round each:

- **Syscalls the GSI's bionic issues:** `seccomp` (383) and `getrandom` (384) unwired, so the
  container's init exits 127; `memfd_create` with sealing.
- **The 64-bit binder ABI.** `ANDROID_BINDER_IPC_32BIT` promptless and on gives `Binder driver
  protocol(7) does not match user space protocol(8)`; make it selectable and off, and backport
  `get_user()` of 8-byte types (ARM 8091/2).
- **Ambient capabilities:** init warns, and apexd-bootstrap fails on the loop devices (EACCES).
- **`O_TMPFILE` (3.11):** `tombstoned` exits 1 on `openat(".", O_TMPFILE) = -EISDIR`; it needs the
  backport series plus ext3/ext4 `->tmpfile()`.

**Audit the whole list before the first boot, not one gap per log.** Those four cost four rounds and
were all in sibling trees already. One pass finds them: list every syscall number the GSI's arm32
`libc.so` issues (`mov r7,#N ... svc`) and diff it against the target's and the nearest working port's
`arch/arm/kernel/calls.S`; then make a feature matrix over the sibling kernel trees (O_TMPFILE, ambient
capabilities, memfd, binder ABI, `PR_SET_VMA`, binder scatter-gather...). Copy each feature from the
sibling with the same base version rather than re-porting it from an older tree.

Found on a 3.10 **arm64** kernel (Nexus 5X, msm8992; device-bullhead.md):

- **arm64 glibc assumes 4.9.** The arm64 Halium glibc is built with `OLDEST_KERNEL` 4.9, so
  `fexecve`, `renameat2` and `mlock2` have no fallback on an older kernel; bullhead needed
  `execveat` and `renameat2` in the kernel. Check this on every pre-4.9 arm64 port.
- **cpuset with `nr_cpus=`.** Limiting CPUs on the command line left the root cpuset's
  `cpus_requested` at all possible CPUs, and LXC could not create its cgroups (`EINVAL`): the container
  never started. Clamp `cpus_requested` to the possible CPUs.
- **Unimplemented syscalls.** glibc and systemd probe `statx`, `rseq`, `clone3`, … on every boot; a
  3.10 arm64 kernel printed a register dump for each and filled most of the journal. Drop that print.
- **qcacld-2.0 and PMF.** connman sets `ieee80211w=1` (MFP optional) on every PSK network, so
  wpa_supplicant puts MFPC in its RSN IE; it upgrades to MFP *required* for an AP with MFPC only when
  the driver does not select the BSS itself. qcacld sets `WIPHY_FLAG_SUPPORTS_FW_ROAM` whenever
  FastRoam/ESE/11r are on in `WCNSS_qcom_cfg.ini` (nl80211 then reports `ROAM_SUPPORT`), and a 3.10
  nl80211 has no `MFP_OPTIONAL`. The driver sees an MFP-capable IE with MFP not enabled and
  `csrIsPMFCapabilitiesInRSNMatch()` drops every AP that advertises MFPC: scans list the networks,
  each connect fails after 5 s with `result:70 and Status:9`. Stop setting the flag in
  `wlan_hdd_cfg80211.c` (it only informs user space; firmware roaming does not need it). The UBports
  and Halium bullhead kernels have the same code; Sailfish's connman 1.40 sets the same
  `ieee80211w=1`. NetworkManager's and Batocera's global `Pmf` route does not help here: it only drops
  PMF for drivers without BIP, and qcacld advertises `AES_CMAC`.
- **Adreno 4xx kgsl SVM below 3 GB** breaks Chromium: soc-qualcomm.md § Adreno 4xx on a 3.10 kgsl.

---

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
