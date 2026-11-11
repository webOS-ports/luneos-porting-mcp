# Kernel Config: the LuneOS Delta, Poison Options and the Command Line

What a LuneOS kernel config changes from stock, which changes break a KMI, the debug options, and the kernel command line.

Building the kernel is kernel-build.md; whether the vendor's modules still load is
kmi-crc-matching.md; loading and shipping modules is kernel-modules.md. Each
device's own fragment is in its device-<codename>.md § Kernel.

---

## The config delta (both tiers)

Extract the stock config from the stock kernel (`IKCONFIG`; Android kernels carry
it — kmi-crc-matching.md § Step 1 has the extraction), then run
`mer_verify_kernel_config` (tools.md § mer-kernel-check) on it to size the delta,
and again on your shipped config to confirm every remaining error is deliberate.
Interpret errors as "explain or fix", not "fix". Measured: stock GKI 6.1 (bluejay)
23 errors / 59 warnings — **`gki_defconfig` alone is NOT enough**, but the fragment
is small and known; mindphone's stock 4.14 13 / 58; the shipped bluejay config 5
errors, all accounted for (SYSVIPC, not needed; NET_L3_MASTER_DEV, KMI-poison;
NF_LOG_IPV4/6 and DUMMY, checker quirks listed in tools.md).

**Missing hard requirements** (systemd/LuneOS) in stock GKI:

- `DEVTMPFS` (+ `DEVTMPFS_MOUNT`)
- `FHANDLE`
- `TMPFS_POSIX_ACL`, `TMPFS_XATTR`
- `VT`
- netfilter/PPP/L2TP error items: `NF_LOG_IPV4/6`, `IP_NF_MATCH_RPFILTER`,
  `INET_AH`/`INET6_AH`, `INET_IPCOMP`, `PPP_*`, `L2TP_*`, `NET_L3_MASTER_DEV`,
  `DUMMY`, `QUOTA_NETLINK_INTERFACE`, `STATIC_USERMODEHELPER` off
- `UEVENT_HELPER=y` + `UEVENT_HELPER_PATH=""`: the initramfs's mdev writes
  `/sys/kernel/uevent_helper`, which stock GKI does not provide; without it late
  hotplug events are lost (the initial `mdev -s` covers the normal path, but add
  it if by-partlabel links come up empty). Behavioural and KMI-safe.
- `# CONFIG_MODULE_SIG_PROTECT is not set` on a rebuilt android14-6.1 GKI, or the
  stock vendor modules never load although every CRC matches. Per tree, not
  universal: on mgk android13-5.15 (brax3) its lists are empty and it stays `=y`
  (kmi-crc-matching.md § A failure class invisible to CRC checks)
- Also off in stock: `USER_NS`, `PID_NS`, `AUTOFS_FS`, `SQUASHFS`, `CHECKPOINT_RESTORE`

**Not required:** `SYSVIPC` (and with it `IPC_NS`). LuneOS does not use SysV IPC;
leave `# CONFIG_SYSVIPC is not set`.

**Already good in stock GKI**: `NAMESPACES`, `NET_NS`, `UTS_NS`, `CGROUPS`
(+freezer, memcg, v2), `EXT4`, `F2FS`, `OVERLAY_FS`, `VETH`, `BRIDGE`, `TUN`,
`BLK_DEV_LOOP`, `BLK_DEV_DM`, binder+binderfs, `FUSE`, `SECCOMP`, `IKCONFIG_PROC`.

**On a Tier A kernel some of the delta is KMI-poison** and must stay off. On
`android14-6.1` (bluejay, panther) that is `FANOTIFY` and `NET_L3_MASTER_DEV`;
everything else above is KMI-clean (zero CRC drift). The list is per KMI and
kernel tree — re-derive it, never transplant it (kmi-crc-matching.md § Poison
options). Userland consequences of the android14-6.1 list:

- No fanotify (systemd is fine without it).
- No VRF/l3mdev (ofono is fine).

Independently of any poison list, **LXC must not unshare the IPC namespace**:
`SYSVIPC` is off, so `IPC_NS` is too. Nor the user namespace where `USER_NS` is off
(stock GKI, Q25). `PID_NS` is available. The shipped config carries
`lxc.namespace.keep = ipc user`.

### Fragment traps

- **Check the merged `.config`, not the fragment.** `merge_config.sh` drops a
  symbol that is not in Kconfig **silently**, with no warning in
  `log.do_configure`. `CONFIG_SECURITY_SELINUX_BOOTPARAM_VALUE=0` is standard advice
  for Android kernels and does nothing on CIP 4.19.325: that tree backported the
  5.x SELinux/LSM rework (visible in the built `.config` as `CONFIG_LSM="…"`,
  `CONFIG_SECURITY_SELINUX_SIDTAB_HASH_BITS`, `CONFIG_SECURITY_LOCKDOWN_LSM` on a
  4.19 kernel), which **deleted the symbol** in favour of
  `int selinux_enabled_boot __initdata = 1;` plus `__setup("selinux=", …)`. A
  long-term stable tree (CIP, Android LTS) can have newer infrastructure than its
  version number suggests; grep the Kconfig in the actual source before trusting a
  symbol name.
- **Never start a comment line in a fragment with `# CONFIG_`.**
  `merge_config.sh` matches `^(# )?CONFIG_[A-Za-z0-9_][= ]`, so
  `# CONFIG_DUMMY=y  kept at the stock value` is parsed as a directive and
  silently unsets the symbol (found on athena; see device-athena.md).
- **Kleaf folds comment lines into the expected value.** Kleaf verifies a
  defconfig fragment by grepping it for the symbol token, so a fragment must not
  mention, even in a comment, a symbol it declares (cost one bluejay build).
- **Editing `luneos.cfg` at all, comments included, costs a full kernel rebuild**
  (q25).
- **USB gadget functions can fall back to `m` after `oldconfig`.** On fajita's 4.9
  tree they had to be forced back to `y`, or there was no configfs gadget (no adb,
  no netconsole). Check the merged `.config`.
- **A device defconfig can turn off what an enabled option depends on.**
  `sunfish_defconfig` turns off `BT_BREDR` and `BT_LE`, and RFCOMM/BNEP/HIDP depend on
  `BT_BREDR`: spell both out (found on sunfish; device-sunfish.md).
- **`CONFIG_LOCALVERSION` in a fragment does not survive a `kernel.bbclass` recipe**;
  where to set it instead: kmi-crc-matching.md § Step 5.

---

## Poison options: per KMI, and drift is a max

An option is **KMI-poison** when it changes a struct that exported symbols carry,
moving their genksyms CRCs so the stock modules refuse to load. LuneOS needs a
small delta an Android defconfig omits (kernel-config.md § The config delta); most
of it is CRC-neutral.

**The poison list is a property of the KMI *and* kernel tree.** Re-derive it per
KMI with `kmi-crc-check.py`; never transplant it between KMIs in either direction.
Measured so far:

| Kernel | Poison | Source |
|---|---|---|
| ACK `android14-6.1` (bluejay, panther) | `FANOTIFY`, `NET_L3_MASTER_DEV` | cumulative bisect: 3145 → 0 drift, 203/203 → 2/203 failing (the 2 were ACK-pin skew; kernel-build.md § Vendor-hook modules) |
| sunfish 4.14 (LineageOS tree) | `FANOTIFY`, `CGROUP_DEVICE` | per-option measurement below |
| MediaTek mgk `android12-5.10` (Q25) | `USER_NS` kept off (not measured on its own) | device-q25.md |

Within a KMI it transfers: panther confirmed bluejay's fragment unchanged
(204/204 modules, 0 mismatches). Whether `CGROUP_DEVICE` shows up depends on
whether the vendor config already enables it — check rather than assume.

### What the two sunfish poisoners change

Between them they move the CRC of **8158 of 12823 exported symbols** on sunfish
(measured: diff the two `Module.symvers`), because they reach structs that almost
every prototype reaches:

| Option | Changes | Reached by |
|---|---|---|
| `FANOTIFY` | `atomic_t fanotify_listeners` in `struct user_struct` (`include/linux/sched/user.h`) | `struct cred.user`, and `cred` is reachable from `file`, `sock`, `task_struct`, and from `device` via `class` → `kobj_ns_type_operations` → `sock` |
| `CGROUP_DEVICE` | `SUBSYS(devices)` bumps `CGROUP_SUBSYS_COUNT`, which dimensions `subsys[]`, `e_cset_node[]`, `e_csets[]` in `struct css_set` / `struct cgroup` | `task_struct.cgroups` |

**The poison sets overlap, so the drift is a max and not a sum.** This is the
single most important thing to know before trying to fix drift by removing
options: in the table below `FANOTIFY` alone moves exactly as many sampled CRCs
as the whole delta, and `CGROUP_DEVICE` alone most of the same ones. A change
that removes one poisoner while another stays shows up as zero improvement,
which reads exactly like "the option was innocent" and is not. A cumulative
bisect hides the same thing; attribute one option at a time.

Everything else in the fragment is CRC-free. Measured per option on sunfish, over
164 CRCs sampled from `fs/inode.o`, `drivers/base/{core,platform}.o`,
`kernel/sched/core.o`, `kernel/module.o`:

| Config under test | CRCs moved vs LineageOS-verbatim |
|---|---|
| the whole LuneOS delta | 143 / 164 |
| `FANOTIFY` alone | 143 / 164 |
| `CGROUP_DEVICE` alone | 118 / 164 |
| `PID_NS` + `USER_NS` | 0 |
| `VT` + `VT_CONSOLE` + `HW_CONSOLE` + `DUMMY_CONSOLE*` + `CONSOLE_TRANSLATIONS` | 0 |
| `DEVTMPFS` (+`_MOUNT`) | 0 |
| `FHANDLE` / `AUTOFS4_FS` / `MODULE_FORCE_LOAD` / `MSM_RDBG` | 0 each |
| the 9 `BT_*` options | 0 |
| **the whole delta minus `FANOTIFY` and `CGROUP_DEVICE`** | **0** |

Note what is *not* in that list: the namespace options. `struct nsproxy` is
unconditional and `struct user_namespace`'s members are gated only by
`PERSISTENT_KEYRINGS`/`SYSCTL`, so `PID_NS` and `USER_NS` are KMI-free on this
tree — the opposite of what the shape of the problem suggests, and worth checking
rather than assuming for any option you are about to fight. It is per tree: on
the Q25's MediaTek 5.10 tree `USER_NS` stays off (device-q25.md).

### How to attribute drift in minutes instead of hours

Do not rebuild the kernel once per option. CRCs come out of genksyms on
*preprocessed source*, so they are visible in a handful of objects:

```sh
make -C $src O=$objdir ARCH=arm64 CC=clang LD=ld.lld LLVM_IAS=1      CLANG_TRIPLE=aarch64-linux-gnu- olddefconfig prepare
make ... fs/inode.o drivers/base/core.o kernel/sched/core.o kernel/module.o
llvm-nm $objdir/fs/inode.o | awk '$2 ~ /^[Aa]$/ && $3 ~ /^__crc_/'
```

About three minutes per config instead of an hour, and a private `O=` objdir
never touches the builder's tree. One catch: **turn LTO off for the measurement**
(`CONFIG_LTO_NONE=y`, and `CFI_CLANG`/`SHADOW_CALL_STACK` off with it). With LTO
on, each `.o` is LLVM bitcode, Kbuild's `cmd_modversions_c` sees no `__ksymtab`
in `objdump -h` and skips the CRC step, so `__crc_*` stays an unresolved weak
symbol and every config looks identical. Turning LTO off is safe here precisely
because CRCs do not depend on codegen.

### Does anything actually need `FANOTIFY` or `CGROUP_DEVICE`?

Asked on sunfish, because it is the obvious next question once you know they are
the only two poisoners there.

**`FANOTIFY`: nothing appears to need it. Removable, pending one control test.**

- bluejay boots the *same* halium-arm64 rootfs on a kernel with
  `# CONFIG_FANOTIFY is not set` — meta-android's shared GKI fragment lists it as
  KMI-poison and leaves it out (panther and tangorpro carry the same fragment but
  have not been booted). Same systemd build, no fallout seen. This is the strongest
  evidence available and it costs nothing to look up.
- Scanning every regular file in the shipped rootfs for `fanotify` finds only
  syscall *name tables*: `strace`, the valgrind tools, gdb's `syscalls/*.xml`,
  `libseccomp`, `enosys`, perfetto's trace processor, and glibc's own wrapper.
  The one real library reference is `libsystemd-shared-257.so`, which does not need
  the kernel side present. No LuneOS component calls it.

- **Provenance, which is the part worth knowing:** it comes from the Mer/SFOS kernel
  config checker, which lists `CONFIG_FANOTIFY  y,!  # optional, required for
  systemd readahead.` — and whose own header defines `!` as *"Failure will be warned,
  not errored"*. So it was never a requirement even there, and its stated reason,
  `systemd-readahead`, was **removed from systemd in v217 (2014)**. The LuneOS rootfs
  ships systemd 257, with no readahead unit or binary. If a Tier B fragment carries
  an option justified only by a Mer-checker line, check the notation and the date
  before paying a KMI price for it.

It was in sunfish's fragment under a "systemd's mount/automount machinery" comment
— an assumption inherited from that checker, never a measurement, and the most
expensive one in the file.

**Open:** bluejay shows systemd *starts* without fanotify, not that a
full LuneOS stack is unaffected; the control test on sargo
(`LUNEOS_TEST_NO_FANOTIFY=1` in `linux-google-sargo`, or counting live fanotify
fds on a booted device) has no recorded result, and sunfish keeps
`CONFIG_FANOTIFY=y` until it does.

**`CGROUP_DEVICE`: kept, because it does something.** 7 units in the shipped rootfs
carry `DeviceAllow=`/`DevicePolicy=` (`systemd-logind`, both `systemd-journald`
units, `systemd-hostnamed`, `bluebinder`, both `openvpn@` templates). Without the
controller systemd logs a warning and skips the restriction rather than failing the
unit, so it is confinement, not a boot dependency — and the Android container does
not need it either (`/var/lib/lxc/android/config` has zero `lxc.cgroup` directives).
It is worth knowing it *can* go if a port ever needs the CRCs; the GKI devices run
without it.

### The genksyms trick: last resort for one member

If an option genuinely cannot go, the `#ifndef __GENKSYMS__` trick (declare the
member at the end of the struct, hidden from genksyms) applies to `FANOTIFY` — it is one member
(`atomic_t fanotify_listeners`) and moving it to the end of `struct user_struct`
keeps every pre-existing offset. It does **not** apply to `CGROUP_DEVICE`: that
changes an array *dimension* in the middle of `css_set`/`cgroup`, so hiding it from
genksyms would publish a CRC for an offset layout the kernel does not have — a
silent wrong answer instead of a loud refusal. It works for **one** struct at a time; it does not scale to `user_struct` plus a
config-sized array dimension in `css_set`, and a patch series hiding several
would be a permanent maintenance burden on the most churn-prone headers in the
tree.

---

## Debug options

What turns on the kernel-side debug channels, and what each costs. Using them is
debugging.md § Debug channels.

- **`CONFIG_NETCONSOLE=y` + `CONFIG_NETCONSOLE_DYNAMIC=y`** streams kmsg to the
  host over UDP, surviving switch_root (usage: debugging.md). It changes
  `struct net_device`/`net_device_ops`, so it is only safe on a kernel that loads
  no prebuilt vendor network module (kmi-crc-matching.md § NETCONSOLE). The
  tenderloin mainline port instead bakes
  `netconsole=6665@172.16.42.2/usb0,6666@172.16.42.1/` into `CONFIG_CMDLINE`
  for true pre-userspace logging — possible only because it also sets
  `CONFIG_USB_ETH=y` (built-in `g_ether` creates `usb0` at kernel boot); see the
  cmdline rule above for configfs-gadget kernels. **Unresolved:** whether a built-in
  NETCONSOLE is safe for early boot: on radon it was added together with
  `FRAMEBUFFER_CONSOLE` and the pair broke the boot (debugging.md § Method); which of
  the two did it was not isolated.
- **pstore/ramoops needs config to exist**: `CONFIG_PSTORE=y`,
  `CONFIG_PSTORE_CONSOLE=y`, `CONFIG_PSTORE_RAM=y`,
  `CONFIG_PSTORE_RAM_ANNOTATION_APPEND=y` (Droidian `debug.config`). Our
  playbook's first debug step assumes ramoops works — on a device that lacks it,
  these options (KMI-check on Tier A) are what create it.

### Framebuffer console as a Tier B debug channel — often does NOT work

Most phones expose no usable UART without a jig, so an early hang shows only as a frozen
bootloader splash, and netconsole / `printk.devkmsg=on` cannot help — they need the
kernel running and the USB gadget up. The obvious idea is to put the kernel log on the
panel:

```
CONFIG_FRAMEBUFFER_CONSOLE=y
CONFIG_FRAMEBUFFER_CONSOLE_DETECT_PRIMARY=y
CONFIG_FONT_SUPPORT=y   CONFIG_FONT_8x16=y
```

plus `CONFIG_VT` and `console=tty0`.

**Treat this as unproven until you see `Console: switching to colour frame buffer device`
in dmesg.** On athena (msm mdss fbdev, 4.19) it was built exactly as above and fbcon
never took over from the dummy console, although `deferred_takeover` was off,
`register_framebuffer()` is used and the fbcon notifier is registered at
`subsys_initcall` (device-athena.md). Two lessons worth more than the technique:

- Several vendor/community kernels ship `console=tty0` on the cmdline with fbcon
  disabled. That is *not* evidence they simply forgot to enable it — enabling it may not
  be sufficient, and assuming it is leads to a wrong conclusion about why their log is
  silent.
- **On a device whose bootloader splash is never cleared, the splash is not a symptom.**
  It looks identical for a dead kernel and for a fully working boot with a live debug
  shell. Never reason from "stuck on the logo"; get a USB-side signal (adb, the
  initramfs gadget's `iSerial`, or any enumeration at all) before concluding anything
  about where boot stopped.

---

## The kernel command line

- **What a bootloader does with the boot-image header cmdline is per bootloader**;
  measure it (a canary such as `zz.marker=1`, then read `/proc/cmdline`):

  | Bootloader | Header cmdline | Devices |
  |---|---|---|
  | Pixel ABL (SDM670, SM7150) | unrecognised arguments dropped | sargo, sunfish |
  | MediaTek lk, MT6789 (G99) | first 20 characters lost (pad the front) | q25, mp01 |
  | MediaTek lk, MT6877 / MT6771 | passed through intact | radon, titanpocket |
  | Samsung `sboot` (SC7730S) | dropped entirely; only `CONFIG_CMDLINE` arrives | goyavewifi |
  | Samsung SBL + lk2nd (MSM8916) | passed on, plus 775 B of its own (overflows a 1024-byte `COMMAND_LINE_SIZE`) | a3-2015-halium |

  Where the header is unreliable, put what LuneOS needs (`enable_adb` included) in
  `CONFIG_CMDLINE`; where it passes through, the header is the cheaper place.
- **Set `CMDLINE` in any recipe that requires meta-oe's `linux.inc`.** It
  unconditionally writes `CONFIG_CMDLINE="${CMDLINE} ${CMDLINE_DEBUG}"`, so with
  `CMDLINE` unset the vendor's built-in string (`root=`, `vmalloc=`, …) is silently
  replaced (found on radon; see device-radon.md).
- **`cgroup_disable=net_prio`** on MediaTek `ccmni` modems: soc-mediatek.md § Kernel.
- **Never put `netconsole=` on the cmdline of a configfs-gadget kernel**: a
  target whose device does not exist at init makes `init_netconsole()` unwind
  entirely, taking the dynamic configfs interface down with it (verified in the
  athena 4.19 source). Attach dynamically from the initramfs instead (debugging.md)
  and put `printk.devkmsg=on` on the cmdline so the dmesg replay isn't ratelimited.

### selinux=0: do not pass it on a Halium port

The rule is `androidboot.selinux=permissive` and nothing else (the Q25's
`CONFIG_CMDLINE` still carries `selinux=0`; an open issue in device-q25.md). That is
an **Android-init property, not a kernel parameter** — the kernel ignores it, and
the kernel's own SELinux stays enabled. Two reasons:

- **The token is half of a pair where it is copied from.** UBports' SDM660
  `deviceinfo` carries `selinux=0 … apparmor=1 security=apparmor` with
  `CONFIG_DEFAULT_SECURITY="apparmor"`: Ubuntu Touch is swapping the LSM for
  AppArmor, not disabling it. Copying only `selinux=0` puts nothing in the slot, and
  the Android container wants the `security.selinux` xattr handler live. Droidian's
  GKI `CONFIG_CMDLINE` example carries it too.
- **It broke mounting on athena.** With `selinux=0` on a CIP 4.19 tree (the one with
  the backported 5.x LSM framework, § Fragment traps), `mount(2)` returned
  **ENOENT** for every block-backed filesystem while tmpfs mounted; the same kernel
  under Android's recovery ramdisk, without the token, logged
  `SELinux: Initializing.` and mounted ext4. No mechanism is confirmed
  (device-athena.md).

When two boots of *identical kernel bytes* differ, diff the two
`Kernel command line:` lines first — one grep, and often the whole answer. Check
what the rest of your ports do before adding a kernel-side token that only one
device has.

---

## Cross-distro config lists — use with care

Both UBports and Droidian publish "required kernel config" lists for Halium-style
ports. They are good references — **but both enable options LuneOS leaves off,
some of them KMI-poison on a Tier A kernel.** Know why before copying anything.

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

LuneOS does not need `SYSVIPC`/`IPC_NS`, and `USER_NS` stays off on the Q25's
tree for KMI reasons (device-q25.md). The difference is architectural, not an
error on either side: UBports and Droidian build a **per-device kernel package**
and do not reload the *stock* vendor modules against it, so KMI preservation is
not a constraint they have. LuneOS Tier A depends on exactly that property. The
rule:

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

- **`CONFIG_ANDROID_PARANOID_NETWORK` stays ON** — disabling it for normal
  Linux networking breaks rild on hybris-12.1+ bases. SFOS wraps the capability
  checks in `#ifdef CONFIG_ANDROID_PARANOID_NETWORK` instead of removing the
  option (SFOS hadk-faq). Vendor daemons rely on it too: Qualcomm's
  `rmt_storage` drops to group `net_raw` and fails the IPC router's bind check
  without it, and the modem resets the phone (found on the Galaxy A3 (2015); see
  device-a3-2015-halium.md). **Unresolved:** a3-2015-halium and bullhead keep it off
  (copied from sm-t520) and instead patch `ipc_router_security.c` to accept group
  `net_raw`; vince keeps it on. Which is the policy for new legacy ports is not decided.
- **`CONFIG_BT_HCIVHCI=y` is bluebinder's kernel prerequisite** — bluebinder
  feeds the Android BT HAL into a virtual HCI (SFOS hadk-hot). The android14-6.1
  fragment carries it as `=m` (the Kleaf route in `build-bootimg.sh` adds
  `hci_vhci` to the GKI module lists).
  Legacy Qualcomm `hci_smd` is `CONFIG_BT_HCISMD` — copy-paste to delete.
- **`CONFIG_USB_CONFIGFS_RNDIS=y`** enables the RNDIS USB-networking debug
  channel (SSH into a half-booted device — see debugging.md). Droidian's symptom
  mapping: "stuck at the glowing logo and RNDIS is not working → check
  CONFIG_USB_CONFIGFS_RNDIS" (Droidian docs). Measured device split: stock GKI
  6.1 (bluejay/panther) has RNDIS **off** but `CONFIG_USB_CONFIGFS_ECM=y`;
  mindphone's 4.14 has RNDIS **on** and ECM off; athena's 4.19 defconfig has
  RNDIS on. The LuneOS initramfs debug network tries both gadget functions, so
  neither needs adding to a fragment just for telnet — but a host talking to
  an ECM gadget must be Linux/macOS (no native Windows driver).
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
  console=tty0` — notably `cgroup_disable=pressure`; `console=tty0` also doubles
  as a boot-hang fix (debugging.md § 1.5 Cmdline-level fixes). Do not copy its
  `selinux=0` (§ selinux=0).
