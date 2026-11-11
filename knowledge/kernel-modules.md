# Kernel Modules: Loading the Vendor's and Shipping Your Own

How modules get loaded on a LuneOS port: the vendor's two module sets, load order, prebuilt vendor sets, and building and shipping modules of your own.

Whether a given vendor `.ko` *can* load into your kernel (vermagic, CRCs, struct
layouts, force-loading) is kmi-crc-matching.md; building the kernel is
kernel-build.md; the config side (module signing options, poison options) is
kernel-config.md.

---

## The vendor_dlkm set: the vendor's own loader must see it

A GKI-era vendor ships kernel modules in **two** sets:

| Set | Lives in | Loaded by |
|---|---|---|
| vendor_boot ramdisk | `/lib/modules` in the vendor_boot ramdisk | the initramfs, early, to reach storage |
| `vendor_dlkm` | the `vendor_dlkm` logical partition | the vendor's own loader in the container's init (MediaTek: `insmod_sh`) |

The initramfs cannot load the second set (it is a logical partition inside `super`),
so it depends on the container seeing `/vendor_dlkm`. On the MP01 the stock set is
345 modules, 180 of them in the vendor_boot ramdisk (device-mp01.md).

**The vendor's loader.** MediaTek: `init.mtkgki.rc` starts `insmod_sh` at
`early-init`, and `init.insmod.<hw>.cfg` says `modprobe|*`, i.e.
`modprobe -a -d /vendor/lib/modules $(cat /vendor/lib/modules/modules.load)` —
the full, ordered vendor list, exactly as on stock Android. Halium/UBports
(`mount-android-partitions` + `mount --rbind /android` into the container rootfs)
and Droidian (`vendor_dlkm` at the host's `/vendor_dlkm` + an
`lxc.mount.entry = /vendor_dlkm vendor_dlkm bind`) both just make that path work
and keep **no module list of their own**. Their initramfs loads only the
first-stage list from `vendor_boot` (`/lib/modules/modules.load`, with
`/override/modules.load` as a per-device override).

**The trap.** `/vendor/lib/modules` is a symlink to `/vendor_dlkm/lib/modules`. If
the host-side `/vendor_dlkm` is an *empty* directory (the partition was only
mounted under `/android/vendor_dlkm`), the lxc bind puts that empty directory over
the real mount inside the container, and `insmod_sh` silently loads nothing. A
hand-written allowlist in `mount-android.sh` then looked necessary, and every
subsystem missing from it was dead: on the MP01 that was audio (`mtk-btcvsd`), and
the entire camera stack (`imgsensor_isp6s`, `camera_isp`, `camera_mem`, the lens
and flash drivers, `mtk-vcu`/`mtk_jpeg`/vcodec).

**`vendor.all.modules.ready` proves nothing.** MediaTek's `insmod_sh` sets it after
loading nothing at all, and Qualcomm's `init.insmod.<hw>.cfg` sets it
unconditionally after its list (sunfish), so a total module failure is invisible
downstream.

The symptoms do not look like "missing kernel modules":

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
# how big is the second set?
wc -l < <vendor-modules>/dlkm/modules/modules.load
# is a driver you are missing in it rather than in the early set?
grep -iE 'touch|efuse|nvmem' <vendor-modules>/dlkm/modules/modules.load
# on the device
dmesg | grep -- -517
ls /vendor/lib/modules/modules.load    # inside the container
```

**What `mount-android.sh` does** (meta-android, `load_vendor_dlkm_modules`): it
tries `dynpart-<p>_a`/`_b` as well (the device-mapper name comes from the super
metadata, not the booted slot — the MP01 boots b and gets `_a`), binds
`/android/vendor_dlkm` and `/android/odm` onto the host paths if needed, and
defaults to `VENDOR_DLKM_MODULES=none`, leaving loading to the vendor. With the
vendor loader working, 332 modules load on the MP01 and audio, camera, WiFi and
cellular all came up in one boot. `=all` or an explicit list loads from the host
for bring-up or a vendor without its own loader; the host path expands each module
through `modules.dep` (§ `modules.load` is a list, not a dependency order). Our own
builds of vendor modules go in `/usr/lib/modules/vendor_dlkm-override/` under the
vendor's file name: they are loaded first, and the vendor's `modprobe -a` skips a
module that is already loaded.

**How an override module reaches the device.** It is machine-specific (built
against that machine's kernel), so it goes in a `<kernel recipe>-vendor-dlkm-override`
package added with `MACHINE_EXTRA_RRECOMMENDS` in the machine conf (q25, brax3). That
reaches the device because the install is `MACHINE=<device> bitbake
luneos-dev-fastboot-package`, whose `luneos-dev-image` is built for the device
machine and wrapped in the `userdata` image (the 9 Nov 2026 q25 rootfs manifest lists
`linux-zinwa-q25-vendor-dlkm-override`). It does **not** reach a rootfs built
separately as `MACHINE=halium-arm64`, which never reads the device's machine conf.
The initramfs is not an alternative for a large module on an `init_boot` device:
brax3's Mali is ~595 KiB LZ4-compressed against ~364 KiB of `init_boot` headroom.

**Who is affected:** any Android 12+ / GKI device with a `vendor_dlkm`
partition (MP01, Q25, bluejay). **Not** affected: pre-dynamic-partition devices,
which have only one module set (mindphone, sargo).

Known hazards of the full list, still worth watching on a new device: the
connsys family (soc-mediatek.md § Connectivity combo) and `ccci_md_all`, which once
wedged PID 1 on the MP01 (it did not with the vendor's own order).

---

## `modules.load` is a list, not a dependency order

`modules.load` names what a set loads; it does not order it. Stock Android's init
resolves `modules.dep` per entry (libmodprobe, `load_modules_parallel=true`), so a
vendor never had to list exporters first, and does not. Measured with
`module-order.py` (tools.md): bluejay lists 335 hard-dependency pairs backwards
across 99 of 203 modules, panther 332 across 107 of 204, plus 14–15 `softdep pre:`
edges each.

Loading the list in order breaks: on bluejay `clk_exynos_gs` (line 15) needs its
exporter `cmupmucal` (line 45), one-pass insmod left it out, there were no clocks,
power domains deferred into the `deferred probe timeout` wall and the MCT timer
panicked at 11.5 s. Anything that loads a whole set must resolve the order first:
the LuneOS initramfs makes repeated passes until one makes no progress
(boot-images.md § Init patch history), and `mount-android.sh`'s host path expands
each entry through `modules.dep`. Never silence `insmod` errors with `2>/dev/null`:
that hid the `Unknown symbol cal_clk_* (err -2)` diagnosis.

---

## Loading a prebuilt vendor set from the host

When the vendor's own loader cannot be used and its modules are loaded from the
host (forced or not; kmi-crc-matching.md § Force-loading prebuilt modules):

**Do not stage a vendor set in `/lib/modules/$(uname -r)`.** udev's coldplug
autoloads by modalias out of that directory, so a depmod'd copy of a whole vendor
set there makes the *next* boot insmod every matching vendor module before
anything is ready. On the MP01 that pulled in `mtk_lpm` within a second of udevd
starting, froze the SoC, and left the hardware watchdog bootlooping the device on
every boot after the first. Symlink the vendor `.ko` into a private tree under
`/run` instead, out of udev's sight and off persistent storage, and point
`depmod -b` and `modprobe -d` at it (`mtk-load-modules.sh` does this). Modules
built with your own kernel are different: they belong in `/usr/lib/modules/<kver>`,
where coldplug autoloading is what you want.

Easy to get wrong once the loading itself works:

- **The vendor's cfg does more than load modules.** Qualcomm's
  `init.insmod.<hw>.cfg` interleaves `enable|<sysfs path>` lines that start the
  DSPs, and the node one of them writes is created by a module earlier on the same
  list. Walk the file, do not grep the module names out of it (on sunfish a
  missing `adsp_loader_dlkm.ko` meant no ADSP, fastrpc "Transport endpoint is not
  connected", and no sensors).
- **A module that is shipped but not listed gets no chance to be forced.** Android
  loads some itself with `finit_module`, a path with no force option
  (`incrementalfs.ko` on sunfish: `Exec format error`, and vold could not prepare
  user 0). Name those separately.
- **Reason from the vendor partition, not from the defconfig**: what matters is
  which `.ko` files the phone carries, not which symbols are `=m` in the tree's
  defconfig (guessing from the latter predicted working audio on a sunfish with no
  ALSA card). `debugfs -R "ls -l /lib/modules" vendor.img` answers it without root
  or a loop mount.

---

## Building and shipping your own modules

**Which route when.** The generic `halium-arm64` rootfs is built once for every
machine, so no machine's module package lands in it, and the tissot/mido pattern
(`MACHINE_EXTRA_RDEPENDS = " … kernel-module-wlan … "`) cannot be copied: those
machines build their own complete image (sargo carries an unresolved
`# kernel-module-wlan` comment in its machine conf for this reason). Two routes
work, both for modules built with your own kernel:

- **The initramfs route** (sunfish, bramble): ship the modules in the machine
  initramfs, next to the kernel they were built against — the only arrangement
  in which the two cannot drift apart — and put them where the vendor's loader
  looks. Use it when the vendor's own init or the initramfs loads the modules.
- **The rootfs.img injection route** (athena): write the module tree into the
  built `rootfs.img` with debugfs and let `systemd-modules-load` load it. Use it
  when nothing vendor-side loads the module (athena: `CONFIG_QCA_CLD_WLAN=m` is the
  only module, and the vendor's `wlan.ko` will not load).

A prebuilt vendor set is neither: it stays on the vendor partition (kmi-crc-matching.md § Force-loading prebuilt modules).

### The initramfs route

Ship them in the initramfs, unsplit:

```bitbake
KERNEL_SPLIT_MODULES = "0"
ANDROID_EXTRA_INITRAMFS_IMAGE_INSTALL = "kernel-modules"
```

Where they have to *land* differs, and getting it wrong fails silently — the build
is green and the device behaves exactly as if nothing changed.

**Shape A - modules live on /vendor (sunfish, most Tier B Qualcomm).** The
vendor's `init.insmod.sh` modprobes from `/vendor/lib/modules` inside the
container. Stage the modules into the rootfs from the initramfs (it is freed at
`switch_root`): `init.sh`'s `mount_kernel_modules()` hook, called after
`mountroot` and before `switch_root`, idempotent with a marker file. Then bind
them over the vendor's directory in `mount-android.sh`, so the container's own
`init.insmod.sh` does the loading:

```sh
cp -a "$ANDROID_ROOT/vendor/lib/modules/." "$stage/"   # vendor's index files
cp -f <our .ko>                            "$stage/"   # our binaries on top
mount --bind "$stage" "$ANDROID_ROOT/vendor/lib/modules"
```

**Shape B - modules live in the vendor_boot ramdisk (bramble, Tensor GKI).** The
bootloader merges vendor_boot's ramdisk and then ours, and `init.sh`'s
`load_kernel_modules()` modprobes whatever is at `/lib/modules`.

1. **cpio layering will not do the substitution for you.** A later archive
   replaces an earlier entry only at the *same path*. The vendor keeps a real
   `/lib/modules` directory; our rootfs is usrmerge so our modules are packaged
   at `/usr/lib/modules`; and our `/lib -> usr/lib` symlink cannot be created
   over the directory the vendor already made. Result: two separate directories
   and no override, so the vendor's binaries get loaded against your kernel.
2. So copy explicitly, before anything is modprobed - `init.sh`'s
   `stage_our_kernel_modules()` does this, logs the count, and no-ops when both
   paths already resolve to the same place (Shape A).

**DO keep the vendor's `modules.load`, `modules.dep`, `modules.softdep` and
`modules.alias` in both shapes.** They address modules by name, so they stay
correct for your binaries, and `modules.load` preserves a load order the vendor
tuned. Anything you do not build keeps the vendor's copy and fails as it would
have anyway.

**DO match the layout and the names exactly.** LineageOS keeps bramble's 221
modules flat at `/lib/modules/*.ko` while `modules_install` writes
`/lib/modules/<version>/kernel/...`; flatten in `do_install` or the override never
happens. A module whose name comes out different is skipped just as silently:
MediaTek's Mali tree names `mali_mgm_$(MTK_PLATFORM_VERSION).ko` from a variable
it does not export, so kbuild produced `mali_mgm_.ko` until the recipe passed
`MTK_PLATFORM_VERSION=<soc>` (device-q25.md).

### Packaging traps

**`KERNEL_SPLIT_MODULES = "0"` is not optional on an LTO build.** With OE's
default per-module packaging, each module's `depends=` field becomes package
RDEPENDS — and under `CONFIG_LTO_CLANG` that field names the LTO intermediates:

```
q6_dlkm.ko:  depends=apr_dlkm.lto,snd_event_dlkm.lto
```

No package provides `kernel-module-apr-dlkm.lto`, so `do_rootfs` fails with
"none of the providers can be installed". This is **not** a defect in your
build: LineageOS's own shipped `mpq-dmx-hw-plugin.ko` carries the identical
`depends=mpq-adapter.lto`, and it is harmless on-device because `modprobe`
resolves against `modules.dep`, not that field. Unsplit, there are no
inter-module RDEPENDS to be unsatisfiable.

**Depend on the kernel's package, never on its deploy.** `MODULE_TARBALL_DEPLOY`
cannot be used: the tarball is created inside `kernel_do_deploy`, and where the
kernel's own `do_deploy` assembles the boot image (`kernel_android`) it is the task
that *consumes* the initramfs — a dependency loop, `1705 unbuildable tasks`.
Depending on a kernel's `do_deploy` is only safe when a *different* recipe
assembles the boot image. On a GKI machine `virtual/kernel` is `linux-dummy`, so
`ANDROID_INITRAMFS_KERNEL_MODULES` must name the recipe that really deploys the
tarball: use `GKI_KERNEL_PROVIDER`.

### A standalone kernel recipe: the packaging shape that works

A recipe that builds with the vendor's own Clang cannot `inherit kernel`, so it
gets none of `kernel.bbclass`'s packaging arrangements. Five failures came out of
adding a working `do_install` to one (bramble) - all of them downstream of
`do_install` having been `noexec` for the recipe's whole life, and none of them
in the kernel itself:

```bitbake
# 1. usrmerge: modules must be under /usr, and kbuild always writes lib/modules
install -d ${D}${nonarch_base_libdir}
${KERNEL_MAKE} INSTALL_MOD_PATH=${WORKDIR}/modinst INSTALL_MOD_STRIP=1 modules_install
mv ${WORKDIR}/modinst/lib/modules ${D}${nonarch_base_libdir}/modules

# 2. ownership: pseudo records only what it is asked to. Files kbuild copies in
#    keep the builder's uid, and do_package then refuses them with
#    "getpwuid(): uid not found: 1000". An explicit chown IS intercepted.
do_install[fakeroot] = "1"
chown -R root:root ${D}${nonarch_base_libdir}/modules

# 3. ...but do NOT make do_deploy fakeroot: bitbake creates sstate-build-deploy
#    outside pseudo, and the sstate hashing then trips over its ownership.
#    Set ownership in the archive instead.
tar --owner=0 --group=0 --numeric-owner -czf ${DEPLOYDIR}/modules-${MACHINE}.tgz ...

# 4. no debug splitting: there is no ${HOST_PREFIX}objcopy under
#    INHIBIT_DEFAULT_DEPS, and INSTALL_MOD_STRIP already stripped them
INHIBIT_PACKAGE_STRIP = "1"
INHIBIT_PACKAGE_DEBUG_SPLIT = "1"
FILES:${PN} += "${nonarch_base_libdir}/modules"

# 5. packaging must still RUN. PACKAGES = "" breaks buildhistory's postfunc, and
#    do_package*[noexec] breaks image builds: oe.package_manager walks
#    do_rootfs's dependencies for do_package_write_ipk edges and demands an
#    sstate manifest for each.
```

### The rootfs.img injection route: debugfs, no root, no loop mount

The trick `android-system-image-tissot.bb` and `-mido-halium.bb` use to patch
images at build time works for a whole module tree:

- Write to **`/usr/lib/modules/<kver>`**, not `/lib/modules`. The rootfs is
  usrmerged - `/lib` is a *symlink* - and debugfs does not resolve paths through
  symlinks.
- debugfs has no `mkdir -p` and no recursive put: walk the tree and emit one
  `mkdir` per directory, parents first.
- `write` refuses to overwrite, so emit `rm` before each `write` to stay
  idempotent.
- debugfs stamps the invoking uid/gid; follow each write with
  `sif <path> uid 0`, `gid 0`, `mode 0100644`.
- Run `depmod -b <staging>` on the host so the image gets a real `modules.dep`
  and `modprobe` works on device.
- Drop a `/etc/modules-load.d/<device>.conf` in as well - the generic rootfs
  already has `systemd-modules-load.service`, so no unit is needed.
- Expected noise to filter: `File not found` from the pre-emptive `rm` on a
  first run, `already exists` from `mkdir` on a re-run, and (below 5.2)
  `depmod: could not open modules.builtin.modinfo`, which landed in 5.2.

### The deployed modules tarball is not stripped

Do not feed `modules-<machine>.tgz` from `tmp/deploy` into the injector. `kernel.bbclass`
builds it with

```
tar $TAR_ARGS -cv -C ${D}${root_prefix} lib | gzip -9n > $deployDir/modules-….tgz
```

from **`${D}`**, the pre-strip install tree. OE's stripping happens later in
`do_package` against `${PKGD}`, so the split package `kernel-module-<name>-<kver>`
has the stripped copy while the deploy tarball keeps full debug info. On athena
that is **330,879,592 B vs 9,115,216 B** for the same `wlan.ko`, against ~700 MB
free in the rootfs.

This is upstream behaviour on every machine, not a recipe bug. Repack from
`packages-split/kernel-module-*` instead, and guard the injector with a
`readelf -S … | grep .debug_info` check - a host `strip` cannot help you
(`Unable to recognise the architecture of the input file`).


### Module signing

- **Prebuilt vendor modules on a `MODULE_SIG_FORCE` kernel** fail with
  `Required key not found`: the kernel was not built with the key that signed them.
  Turn `CONFIG_MODULE_SIG_FORCE` off when the port loads the vendor's binaries.
- **Ports that build their own modules keep `MODULE_SIG_FORCE=y`** and pin the
  signing key in the layer, so a kernel rebuild and an out-of-tree module recipe
  still agree: sargo commits `module-signing/luneos-module-signing-key.pem`, fajita
  carries the same key byte for byte, vince keeps `MODULE_SIG_FORCE=y`.
- **On a rebuilt android14-6.1 GKI**, `CONFIG_MODULE_SIG_PROTECT` must be off or the
  stock vendor modules count as unsigned; on a tree whose protected lists are empty
  (mgk android13-5.15, brax3) it stays at stock (kmi-crc-matching.md § A failure
  class invisible to CRC checks).
