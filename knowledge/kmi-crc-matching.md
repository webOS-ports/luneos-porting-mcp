# Matching a Vendor's Kernel: Vermagic, CRCs and Struct Layouts

Whether a vendor `.ko` loads into your kernel, Tier A or Tier B: vermagic, CRCs, struct layouts and force-loading.

The rule this all serves: **on any device that keeps its vendor's kernel
modules — Tier A GKI or Tier B — the vendor's kernel is the specification and
your kernel is the implementation**, and the authority is the vendor whose modules
the device loads, not the OEM whose logo is on the case (device-sunfish.md).
Everything below is about finding out what that specification actually is, rather
than what a repository suggests it might be. Distilled mostly from bramble (218
modules, 0 failing) and sunfish, where the same problem took eight builds; each
wrong turn is written down as a "don't".

Order of business: Step −1 (can you build the modules instead?), then Steps 0–6
for matching, then force-loading and struct layouts. The poison options are in
kernel-config.md; building, loading and shipping modules in kernel-modules.md.

---

## Step −1 — first ask whether you need to match at all

**Everything about CRCs is about making *their* module binaries load into *your*
kernel. Before spending a day on it, ask whether you can build the modules
instead.**

If the kernel source is available — and on a LineageOS-supported device it is,
since that is how the ROM was built — then the modules are in it too. Build them
from the same tree and the same config as your kernel and they match **by
construction**:

```
vermagic=4.14.357-openela-g28f9290ae067     LineageOS's modules
vermagic=4.14.357-openela-g28f9290ae067     ours, from the same revision
```

**Count what your kernel already builds against what the vendor ships**, in one
command, before believing any of it:

```sh
ls vendor-modules/*.ko | sed 's|.*/||' | sort  > theirs
find <kernel build> -name '*.ko' | sed 's|.*/||' | sort > ours
comm -12 theirs ours | wc -l
```

On sunfish that was 40 of 41, and the gap was an option the port had switched off
itself; it now builds all 41 and loads no prebuilt vendor module at all
(device-sunfish.md).

It is not merely easier but often *necessary*: the CRC route has a hard ceiling.
On sunfish the LuneOS delta moves **8158 of 12823 exported symbols** (§ Poison
options), and even a CRC-verbatim build — LineageOS's config exactly, no LuneOS
delta — still fails 5 of the 41 modules, `wlan.ko` among them. "Drop the poison
options and load the vendor's modules" does not buy a working device there. Once
you ship your own, treat the gate's "would fail to load" count for the vendor set
as informational: it describes modules that are never loaded.

Keep matching when the source is genuinely unavailable — a GPL-incomplete vendor
drop, an out-of-tree combo driver (mindphone's MTK WMT stack), or a Tier A GKI
device where preserving the *stock* KMI is the whole point (bluejay, panther).
"The ROM ships modules" is not one of them. Shipping your own is § Building and
shipping your own modules.

## Step 0 — ask the modules, they know

A module states the kernel it was built for. Do this before reading any
defconfig, any manifest, or any wiki:

```sh
strings vendor/lib/modules/apr_dlkm.ko | grep -m1 '^vermagic='
# vermagic=4.14.336-gfe61ffb52659 SMP preempt mod_unload modversions aarch64
```

That string answers four questions at once:

| Field | Means |
|---|---|
| `4.14.336` | `VERSION.PATCHLEVEL.SUBLEVEL` of the tree, plus `EXTRAVERSION` (`-openela`) |
| `-g<sha>` | **the git HEAD the kernel was built from** — an exact, searchable commit |
| absence of `+` or `-dirty` | the tree was clean: no local patches on top |
| `modversions` | `CONFIG_MODVERSIONS` is on, so CRCs are checked and matter |

Then confirm they are one coherent set, not a mixture:

```sh
for m in */*.ko; do strings "$m" | grep -m1 '^vermagic='; done | sort | uniq -c
#   42 vermagic=4.14.336-gfe61ffb52659 ...        <- one build, good
```

**DO** search the `-g<sha>` on the vendor's kernel repo. On sunfish
`fe61ffb52659` was the head of `lineage-20`, which identified the ROM
generation (/e/OS 13, a LineageOS 20 derivative) more reliably than the owner's
recollection did — and matched the `api=33` the device reported.

**DON'T** infer the kernel from the Android version. "Android 13, so
lineage-20-ish" is necessary, not sufficient: the vendor must match the *kernel*
version. athena's port turned on exactly this (its `KGSL_PROP_IB_TIMEOUT` failure
came from a 4.4-era vendor against a 4.19 kernel, both nominally "Android 15";
device-athena.md).

**DO** make the vermagic match exactly when the initramfs has to load vendor
modules. Storage and USB controllers are often vendor modules in the
`vendor_boot` ramdisk, the initramfs carries only **busybox** insmod/modprobe
(no `--force-vermagic`), and the stock config rarely sets
`CONFIG_MODULE_FORCE_LOAD` — so a vermagic that is off by one character means no
userdata, no adb and no console, while every CRC check passes. Set
`CONFIG_LOCALVERSION` to the vendor's suffix with `LOCALVERSION_AUTO` off, and
write an empty `.scmversion` before configure, or `scripts/setlocalversion`
appends a `+` (found on the Q25; see device-q25.md):

```
CONFIG_LOCALVERSION="-android12-9-gfcab0aff02db"     # vermagic.cfg, the Q25's value
# CONFIG_LOCALVERSION_AUTO is not set
: > .scmversion          # in do_configure:prepend; else setlocalversion appends "+"
```

Deploy `include/config/kernel.release` so the string is checkable before flashing.
When the tree's own sublevel differs from the vendor's, faking `SUBLEVEL` in the
Makefile (which dirties the tree, hence the empty `.scmversion`) is defensible **only**
because the ABI is separately verified (0 of N stock modules failing the CRC check);
the MP01 tried it on a 5.10.198 tree and moved to the vendor's genuine 5.10.233 source
instead (device-mp01.md § Kernel).

---

## Step 1 — get the vendor's real config, not its defconfig

**DO** extract the config out of the shipped kernel. Android kernels are built
with `CONFIG_IKCONFIG`, so the answer is inside the boot image:

```sh
# boot.img -> kernel -> the gzipped .config between IKCFG_ST and IKCFG_ED
python3 - <<'PY'
import struct, gzip
b = open('boot.img','rb').read()
k = struct.unpack_from('<I', b, 8)[0]           # header v2/v3: kernel_size at +8
open('kernel.lz4','wb').write(b[4096:4096+k])
PY
lz4 -d kernel.lz4 kernel.img
python3 - <<'PY'
import gzip
b = open('kernel.img','rb').read()
st = b.index(b'IKCFG_ST') + 8
open('vendor.config','w').write(gzip.decompress(b[st:b.index(b'IKCFG_ED', st)]).decode())
PY
```

**DON'T** trust `arch/arm64/configs/<device>_defconfig`. It is what the ROM
maintainer feeds kbuild, not what came out, and on both devices measured it
differed from the shipped kernel in ways that moved CRCs:

| Device | Public defconfig | What actually shipped |
|---|---|---|
| bramble | `DEBUG_FS=y`, `CORESIGHT=y` | both **off** (Google's user build) |
| sunfish (LOS 23.2) | — | `DEBUG_FS=n` *with* `TRACING=y` |

On bramble those two symbols alone cost **170 of 218 modules**, from a build
whose config was otherwise the published defconfig and which carried no LuneOS
options at all.

**DO** then use that extracted config as the build's base and put your delta on
top, so the only differences are the ones you chose:

```bitbake
cat ${UNPACKDIR}/vendor-config ${UNPACKDIR}/luneos.cfg > ${WORKDIR}/defconfig
```

**DO** also get the vendor's modules themselves, so the gate has something to
check against. A LineageOS-style OTA has them in `vendor.img` inside
`payload.bin`:

```sh
unzip -o rom.zip payload.bin
python3 payload_extract.py payload.bin . vendor          # -> vendor.img
for f in $(debugfs -R "ls /lib/modules" vendor.img | tr -s ' \n' '\n' | grep '\.ko$'); do
    debugfs -R "dump /lib/modules/$f mods/$f" vendor.img
done
```

And a LineageOS build publishes its own `build-manifest.xml` next to the zip,
which names the kernel revision outright — worth fetching first, it is 285 KB
against the ROM's 1.2 GB.

---

## Step 2 — read the failure correctly

Two module-load failures look similar in a log and mean completely different
things. Getting this wrong wastes a flash cycle.

| Message | Means | Force-loadable? |
|---|---|---|
| `X: disagrees about version of symbol Y` | CRC mismatch: the symbol exists, its type changed | **yes** — `MODULE_INIT_IGNORE_MODVERSIONS` |
| `X: Unknown symbol Y (err 0)` | the kernel does not export Y **at all** | **no, ever** |

`kernel/module.c` returns `-ENOENT` for an unresolved symbol unconditionally;
the force flags only skip the vermagic and CRC comparisons. So:

**DON'T** answer `Unknown symbol` with `CONFIG_MODULE_FORCE_LOAD` or
`modprobe --force`. It cannot work. On sunfish a revision shipped that did
exactly this and the modules failed identically — the symbol was
`__cfi_slowpath`, i.e. *the kernel had been built without CFI while the modules
had not*. An `Unknown symbol` naming a feature's helper is telling you a whole
config option is missing, not that a check is in the way.

**DO** count the right message on the device. `dmesg | grep -c "Unknown symbol"`
returned **400** on a healthy MP01 boot — dependency-ordering noise from the
module-load retry loop (`tcpc_class: Unknown symbol pd_dbg_info`), resolved on a
later pass. The CRC message is **"disagrees about version"**. Count that one.

**DON'T** trust the absence of a "version magic" complaint as proof the versions
match. Under `CONFIG_MODVERSIONS` the comparison deliberately skips the release
string:

```c
static inline int same_magic(const char *amagic, const char *bmagic, bool has_crcs)
{
	if (has_crcs) {                       /* skip the version, compare flags only */
		amagic += strcspn(amagic, " ");
		bmagic += strcspn(bmagic, " ");
	}
	return strcmp(amagic, bmagic) == 0;
}
```

### A failure class invisible to CRC checks: `MODULE_SIG_PROTECT`

`kmi-crc-check.py` can pass and the stock vendor modules still never load. A GKI
kernel with `CONFIG_MODULE_SIG_PROTECT=y` refuses (`-EACCES`) to let a module it
did not sign resolve *protected* symbols. A self-rebuilt GKI is not signed with
Google's key, so the phone's **own stock vendor modules count as unsigned**, and
a CRC-only check cannot see it because the CRCs are fine (Wi-Fi/BT never loaded
in an early bluejay kit; see device-bluejay.md).

Fix: `# CONFIG_MODULE_SIG_PROTECT is not set`, while `MODULE_SIG`/`MODULE_SIG_ALL`
stay `=y`; `internal.h` stubs both helpers when the option is off, so no source
patch is needed. Measured KMI-clean on bluejay, host-side: 203/203 factory modules
load-compatible, 0 CRC mismatches, and the option confirmed off by reading the built
kernel's IKCONFIG back. Whether it brings Wi-Fi/BT up on the phone is unrecorded
(device-bluejay.md).

**What the option does depends on the tree; read it before turning it off.** On
MediaTek mgk android13-5.15 (brax3) it works the other way round, and stays at the
stock `=y`:

- the two lists are fixed in-tree files, `android/abi_gki_modules_protected` and
  `android/abi_gki_modules_exports`, and both hold nothing but the
  `[abi_symbol_list]` header, so no symbol is protected and no export is reserved;
- `module_sig_check()` in `kernel/module.c` returns 0 for an unsigned module when
  the option is on ("Do not prevent loading of unsigned modules; as all modules
  except GKI modules are not signed"), and asks lockdown when it is off;
- every stock module is unsigned anyway (0 of 774 BaseOS and 0 of 377 iodéOS carry
  `~Module signature appended~`), and they load on the stock kernel, which has
  the same `=y`.

So check three things in the device's own tree: whether `kernel/Makefile` builds
`gki_module.o` from generated or fixed lists, whether those lists are empty, and
whether the stock modules are signed at all.

---

## Step 3 — measure the CRCs yourself, host-side

`kmi-crc-check.py` (tools.md) is the gate, and it should be run before every
flash. But **DO** also be able to read the raw numbers, because a display filter
in a tool once hid `module_layout` from a summary and sent this port chasing the
wrong thing for two builds:

```python
# __versions is an array of { u64 crc; char name[56]; }
import struct, subprocess
out = subprocess.run(["llvm-objcopy","-O","binary","--only-section=__versions",
                      "mod.ko","/dev/stdout"], capture_output=True).stdout
want = {}
for off in range(0, len(out), 64):
    rec = out[off:off+64]
    if len(rec) < 64: break
    want[rec[8:].split(b"\0")[0].decode()] = struct.unpack_from("<Q", rec, 0)[0]
# compare against column 1 of the build's Module.symvers
```

### The pattern of mismatches is the diagnosis

**DO** look at *which* symbols differ before changing anything:

| Observation | Means |
|---|---|
| **everything** differs, `printk` and `kfree` included | wrong source revision — go back to Step 0 |
| `module_layout` differs | `struct module` changed: tracing, CFI, sig, livepatch-class options |
| simple symbols match, only struct-carrying ones differ (`dev_err`, `devm_kmalloc`, `bus_register`) | a shared struct changed — config, and a small one |
| a handful of subsystem symbols differ | that subsystem's options |

On sunfish `printk`, `kfree`, `mutex_lock` and `__const_udelay` matched while
`dev_err` and `module_layout` did not — 31 of 50. That is a config difference in
`struct device` and `struct module`, and it ruled out the source and the
compiler in one look.

---

## Step 4 — the compiler: what it does and does not affect

**DON'T** chase the vendor's exact clang release to fix CRCs. genksyms computes
CRCs from *preprocessed source plus config*; it is not a codegen property.
Measured twice on sunfish:

| Our clang | Vendor clang | Simple symbols |
|---|---|---|
| 12.0.5 (r416183b) | 14.0.6 (r450784d) | 34 of 55 matched |
| 12.0.5 (r416183b) | 21.0.0 (r563880c) | 31 of 50 matched |

If the compiler decided CRCs, *nothing* would match. It does not.

**DO**, however, build with the vendor's toolchain **family** when the tree is a
Qualcomm/Android one, for a different and much sharper reason: **the SCM
(TrustZone) entry is register-pinned inline assembly, and GCC gets it wrong.**
This was the single root cause of sunfish looking dead while booting fine:

```
scm_call failed with error code -1                    (x44, GCC build)
QSEECOM: qseecom_probe: Failed to get QSEE version info -19
QSEECOM: qseecom.qsee_version = 0x0
subsys-pil-tz ...: modem/cdsp/venus: Initializing image failed(rc:-5)
```

With no SCM there is no PIL, so **no peripheral image authenticates at all** —
and because the Adreno zap shader loads through that same path, `kgsl` never
binds, `/dev/kgsl-3d0` never appears, EGL cannot initialise and the compositor
aborts in a loop (3983 restarts observed). One cause, an entire device's worth
of symptoms. Rebuilt with the clang the tree names in its own
`build.config.common`, every one of those went to zero.

**DO** expect clang-only options to switch themselves **on** when you move a
recipe from GCC to clang. `LTO_CLANG`, `CFI_CLANG` and `SHADOW_CALL_STACK`
depend on clang, so kconfig force-disables them under GCC and nobody notices
they were requested. On sunfish that produced a kernel 5 MB larger that
overlapped its own initramfs — caught only by the boot-window check
(boot-images.md), which is the first time that check earned its keep.

**DON'T** try to build a CFI/SCS kernel with GCC at all: it stops at
`cc1: error: '-fsanitize=shadow-call-stack' requires '-ffixed-x18'`.

---

## Step 5 — kconfig will ignore you, in four specific ways

Each of these cost a full rebuild before being understood.

**A choice member cannot be unset.** `# CONFIG_LTO_CLANG is not set` does
nothing when `LTO_CLANG` is one arm of a `choice`; kconfig re-selects the
previous member. Select the other arm:

```
CONFIG_LTO_NONE=y                 # not "# CONFIG_LTO_CLANG is not set"
```

**A selected symbol cannot be unset.** `DEBUG_FS` stayed `=y` through two
attempts because something else selects it. Find the chain before touching it:

```sh
# every enabled symbol that selects X
grep -rn "select X" $S --include=Kconfig\* | while IFS=: read f ln rest; do
    sym=$(awk -v n=$ln 'NR<=n && /^(menu)?config /{c=$2} NR==n{print c}' "$f")
    grep -qE "^CONFIG_$sym=y" $B/.config && echo "$sym"
done | sort -u
```

On sunfish (against the /e/OS 13 vendor) that walked `DEBUG_FS ← TRACING ←
GENERIC_TRACER ← IPC_LOGGING` — and `IPC_LOGGING` is in that vendor's defconfig too,
meaning **that vendor had DEBUG_FS on as well and the whole hunt was misdirected.** Which leads to the
most important don't in this file:

> **DON'T disable a feature without checking whether the vendor's modules
> import it.** One command settles it:
>
> ```sh
> for m in mods/*.ko; do strings "$m" | grep -qE '^debugfs_(create|remove)' && echo "$m"; done
> ```
>
> 11 of the /e/OS 13 vendor's 42 sunfish modules import `debugfs_*`. A module
> cannot import what the kernel does not export, so DEBUG_FS was *provably* on in
> that vendor kernel (LineageOS 23.2's, with 41 modules, ships `DEBUG_FS=n`; § Step 1), and turning it off would have reproduced the `Unknown symbol` class
> of failure — the unfixable one.

**`CONFIG_LOCALVERSION` in a fragment does not survive a `kernel.bbclass` recipe**
(sunfish, through `linux.inc`), which owns it. Recipes that run plain kbuild without
`kernel.bbclass` (q25, mp01, bramble: `inherit deploy`) set it in a `vermagic.cfg`
fragment instead. To add the `-g<sha>` half of a vermagic, use OE's knob, which exports
`LOCALVERSION` for `scripts/setlocalversion` to append:

```bitbake
KERNEL_LOCALVERSION = "-g28f9290ae067"
```

**A toolchain-probed symbol drops out with no warning.** `DEBUG_INFO_BTF`
depends on `PAHOLE_VERSION`, which kconfig computes by running `pahole`; with
none on `PATH` olddefconfig quietly unsets `DEBUG_INFO_BTF` and
`DEBUG_INFO_BTF_MODULES`. The second adds `btf_data_size`/`btf_data` to
`struct module`, so `module_layout` and every CRC reaching a `struct module`
move: on the BraX3 a config identical to stock scored 774 of 774 failing. Check
whether the vendor's IKCONFIG has BTF on (MT6789 does not, MT6835 and Tensor
do), put `pahole` on `PATH` (`pahole-native`, or `GKI_BUILD_TOOLS_DIR`), and
make the recipe fail when the option is missing (device-brax3.md § Kernel). In Yocto,
`pahole-native` drags in `libbpf-native`, whose `linux/bpf.h` shadows the tree's
`tools/include` and breaks the host build of `resolve_btfids` ("redefinition of
'bpf_core_relo'"): pass the native sysroot as `-idirafter`, not `-I`, in `HOSTCFLAGS`.
Diff the resulting `.config` against IKCONFIG every time, not the defconfig you
asked for.

---

## Step 6 — always have a baseline switch

**DO** put this in every per-device kernel recipe, from the first commit:

```bitbake
LUNEOS_KERNEL_FRAGMENT ?= "1"      # "0" = the vendor's config verbatim
```

It is the control experiment, and it is what splits the only two possibilities
apart:

- **verbatim build passes the gate** → tree, toolchain and config reproduce the
  vendor; every remaining mismatch is in your own delta, and can be bisected
  with `symvers-drift.py`.
- **verbatim build still fails** → the cause is outside your config entirely,
  and no amount of fragment editing will help.

bramble had this switch and reached 0/218 in three measured steps. On sunfish a
run *believed* to be a baseline silently carried the whole delta (`bitbake -R`
with a variable the recipe never reads changes nothing). **DON'T** report a
baseline number without checking the recipe actually honours the switch.

---

## Poison options

Which config options move CRCs (KMI-poison), per KMI and tree, how to attribute
drift in minutes, and the genksyms last resort: kernel-config.md § Poison options.

---

## Force-loading prebuilt modules, and when it is safe

Force-loading is for modules you cannot build (Step −1). It works — wifi, BT and
GPS came up this way on mindphone — and the recipe is:

- set `CONFIG_MODULE_FORCE_LOAD=y` in luneos.cfg — this only makes forcing
  *possible*; something still has to ask for it,
- **derive the list and the order from the vendor's own init**, never hand-write
  one (see hal-userspace.md, "let the vendor's init load them"): `insmod` lines in
  `/vendor/etc/init/*.rc` for the connac era, `/vendor/etc/init.insmod.<hw>.cfg`
  for Qualcomm and the MTK GKI devices, `modules.load` as the fallback,
- escalate per module — plain `modprobe`, then `--force-vermagic`, then `--force`.
  Starting at `--force` hides a real KMI break on a port where only the vermagic
  string differs; if vermagic is the only difference, match it instead (Step 0),
  and a struct change then fails loudly at insmod instead of corrupting memory,
- point `firmware_class.path` at `/android/vendor/firmware` first. The kernel
  resolves `request_firmware()` against the *host* filesystem, not the
  container's.

**It is only safe while every struct those modules touch has the stock layout.**
`--force` skips the CRC check that would have caught a layout change, so a
mismatch shows up as memory corruption, not as a load error. Tier B has an ABI to
keep after all: not a KMI in the GKI sense, but the stock kernel's layout as seen
by every prebuilt `.ko` on the vendor partition. Check it (§ Struct layouts)
before the first forced load. `Unknown symbol` is never force-loadable (Step 2).

Where a forced set may and may not be staged on the device, and what the vendor's
own load list does besides loading: kernel-modules.md § Loading a prebuilt vendor
set from the host.

---

## Struct layouts: the ABI a forced load depends on

A panic in the first vendor network driver to register a netdev (Titan Pocket:
`Unable to handle kernel paging request`, `lr : __dev_xdp_attached`, under
`register_netdev <- [wlan_drv_gen3]`) is the signature of a layout change the
force skipped (device-titanpocket.md). Check before flashing.

### The config diff

1. Get the stock config from the stock kernel itself (Step 1). MediaTek stock
   kernels carry IKCONFIG: unpack `boot.img`, gunzip the kernel, then
   `scripts/extract-ikconfig Image > stock.config`.
2. Diff it against your `.config`, including options that are absent on one
   side (treat absent as `n`).
3. For every differing symbol, check whether it appears inside the struct
   bodies prebuilt modules use: `task_struct`, `net_device`,
   `net_device_ops`, `sk_buff`, `sock`, `inode`, `file`, `device`,
   `dev_pm_info`, `wiphy`, `wireless_dev`, `mm_struct`, `cred`, `user_struct`,
   `css_set`, `cgroup`, `perf_event`. A regex over
   `struct X { ... };` in the tree's headers is enough to list the candidates.
4. Anything that hits gets reverted to stock unless you build every module that
   uses that struct yourself.

### Better: compare the real layouts, using the stock kernel's own headers

The config diff is a heuristic. If the vendor partition carries **`kheaders.ko`**
(`CONFIG_IKHEADERS`, common on Android 11 MTK vendors), it holds the stock
kernel's complete header tree *with its generated `autoconf.h`*, which makes an
exact check possible:

1. Extract it: the module's data is an xz-compressed tar; find `\xfd7zXZ\0` in
   the `.ko`, decompress from there, untar. Stock MTK headers reach into
   `drivers/misc/mediatek/include` by relative path, which kheaders does not
   carry; symlinking your tree's copy in is fine (platform helpers, not the
   structs under test).
2. Write a probe `.c` that only `#include`s every header family the vendor
   modules use (netdevice, skbuff, cfg80211, sched, fs, device, platform,
   sdio, tty, genetlink, perf_event, ...).
3. Compile it twice with the kernel's own flags plus `-g
   -fno-eliminate-unused-debug-types`: once against your tree and generated
   headers, once against kheaders. Same compiler both times, so only the
   headers and config differ.
4. Diff `sizeof` and every member offset of every struct/union from DWARF
   (pyelftools; flatten anonymous members).

On the Pocket: 1439 structs compared. Validation: compiling the stock side with
`-DCONFIG_NET_POLL_CONTROLLER=1 -DCONFIG_NETPOLL=1` reproduces the crash's
layout exactly (`net_device_ops` 512 → 536 bytes, first difference at
`ndo_set_vf_mac`; `net_device` gains `npinfo`). With the fixed config, 4
differ, all harmless: `cgroup`, `cgroup_root`, `css_set` (extra cgroup
controllers such as CGROUP_DEVICE, which systemd's `DeviceAllow=` uses;
cgroup-core internals) and
`user_struct` (FANOTIFY adds a field in tail padding: same size, same offsets).
It also caught one the heuristic missed: CGROUP_PERF adds fields to
`perf_event` and `perf_cpu_context`, which the vendor `met.ko` profiler uses,
so it went off too.

Also check that every symbol a vendor module imports and your kernel does not
export is exported by another vendor module (`__ksymtab_strings`). On the
Pocket all `mtk_wcn_*` imports resolve to `wmt_drv.ko`.

**Do not use MODVERSIONS CRCs for this on a reconstructed tree.** Comparing the
modules' `__versions` against your `Module.symvers` flagged 15-90 symbols per
module, including `printk` (ours 0x27e1a049, stock 0x985558a1) and
`__stack_chk_fail`, whose declarations involve no structs at all. The stock
kernel was built from Unihertz's real source with Android clang, ours from
TheKit's reverse-engineered tree with GCC, so the CRCs carry noise from
declaration differences that matter to genksyms but not to the ABI. CRC
attribution (kernel-config.md § Poison options) works when you build the vendor's own
source; against a reconstruction, compare layouts instead.

Found by the config diff and the layout probe on the Titan Pocket, and what was done:

| Option (luneos.cfg) | Struct changed | Fix |
|---|---|---|
| NETCONSOLE → NETPOLL, NET_POLL_CONTROLLER | `net_device`, `net_device_ops` | off; the panic above |
| CGROUP_NET_PRIO | `net_device` (`priomap`, which changes `sizeof`, so `netdev_priv()` of every vendor netdev points at the wrong place) | off |
| BLK_CGROUP (+ MEMCG, already on) → CGROUP_WRITEBACK | `inode` | BLK_CGROUP off, as stock. CGROUP_WRITEBACK has no prompt, so it cannot be turned off on its own |
| CGROUP_PERF (found by the layout probe, not the heuristic) | `perf_event`, `perf_cpu_context` | off, as stock |

What changed no struct the vendor modules use and stayed on: FHANDLE, the
namespaces except IPC_NS, CGROUP_FREEZER, NET_CLS_CGROUP, BT, RFKILL, VT,
DEVTMPFS, CHECKPOINT_RESTORE, SQUASHFS, AUTOFS4. FANOTIFY (`user_struct`) and
CGROUP_DEVICE (`css_set`, `cgroup`) do change listed structs and also stayed on,
because the layout probe showed the change harmless on this kernel: FANOTIFY's
field lands in `user_struct`'s tail padding (same size, same offsets) and the
cgroup structs are cgroup-core internals. Options that change *built-in* code
only (e.g. the BT stack) are invisible to vendor modules unless they call into it.

Struct bodies are not the whole ABI: inline helpers and macros also bake offsets
into the module. The struct list is a practical filter, not a proof.

### NETCONSOLE and `NET_POLL_CONTROLLER`

`CONFIG_NETCONSOLE` selects NETPOLL, which turns on `NET_POLL_CONTROLLER`, which
adds `npinfo` to `struct net_device` and inserts
`ndo_poll_controller`/`ndo_netpoll_setup`/`ndo_netpoll_cleanup` into the middle
of `struct net_device_ops`. A prebuilt wifi driver's ops table laid out for stock
then has the kernel read `ndo_bpf` from the wrong slot and jump to whatever is
there. On Tier A it is KMI-poison; on Tier B it is a panic whenever a stock
network module is force-loaded, unless the stock config already had
`NET_POLL_CONTROLLER`. Safe only where the network drivers are built with the
kernel (athena builds its own `wlan.ko`). Usage of netconsole as a debug channel:
debugging.md.

---

## Building and shipping your own modules

Which route when (initramfs or rootfs injection), where the modules must land, and
the packaging traps: kernel-modules.md § Building and shipping your own modules.

---

## Checklist before flashing a rebuilt kernel that keeps vendor modules

0. **asked whether the modules can be built instead** (Step −1) — if the ROM's
   kernel source exists, they almost certainly can, and steps 3 and 5 then stop
   applying
1. `vermagic` of the vendor's modules identified, and the `-g<sha>` commit pinned;
   matched exactly if the initramfs must load vendor modules
2. vendor's real config extracted from `IKCONFIG` and used as the build base
3. vendor's modules extracted, `kmi-crc-check.py` run → **0 would fail to load**
   *(only when loading their binaries; skip if shipping your own)*
4. baseline (`LUNEOS_KERNEL_FRAGMENT = "0"`) also gated at least once
5. no feature disabled that the modules import (`strings`-check it)
   *(likewise)*
6. if anything is force-loaded: struct layouts checked against stock
   (§ Struct layouts), and no NETCONSOLE unless stock had `NET_POLL_CONTROLLER`
7. on a rebuilt GKI: `CONFIG_MODULE_SIG_PROTECT` off where its symbol lists are
   populated (android14-6.1); on a tree whose lists are empty it stays at stock
   (§ A failure class invisible to CRC checks)
8. boot-window check passes (kernel end < ramdisk load address) — and remember
   the initramfs grew if it now carries modules
9. built with the toolchain family the tree's own `build.config.common` names
10. if shipping your own modules: they are in the boot image (or the injected
    rootfs), `lsmod` on the device shows roughly the count the vendor's
    `modules.load` names, and `dmesg` shows neither "disagrees about version"
    nor "Unknown symbol"
