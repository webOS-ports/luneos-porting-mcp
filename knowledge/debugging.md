# LuneOS GSI/GKI Bring-up Debugging Playbook

Stage-by-stage playbook for a LuneOS GSI/GKI port that does not come up, distilled from failures hit and diagnosed on real hardware.

Devices behind it: Pixel 3a (sargo), Pixel 6a (bluejay), Pixel 7 (panther), the MediaTek ports (mindphone, MP01, radon, Titan Pocket, SM-T220), BlackBerry KEY2 (athena) and Galaxy A3 (2015). Every failure mode in the core text was hit on hardware and diagnosed; the fixes named are the ones that shipped. Material from the UBports, Droidian and SFOS porting guides is attributed inline — that is other distros' documented experience, not LuneOS-verified, and SFOS-derived command spellings were extracted from summarized pages, so check the cited source if one fails. Work through the stages in order: each stage's failures are only visible once the previous one is cleared, and several of these bugs hide behind one another. HAL and subsystem detail lives in hal-userspace.md; kernel config, build and module-loading rules in kernel-config.md, kernel-build.md, kernel-modules.md and kmi-crc-matching.md; boot-image construction and the initramfs init patches in boot-images.md.

**The model these stages assume** (installing.md § The general model; architecture.md § On-device layout): our boot image, the vendor's partitions where the port keeps them, and `rootfs.img` + `android-rootfs.img` (the GSI) as files on an unencrypted ext4 `userdata`. The initramfs loop-mounts `rootfs.img` as `/`; the Android container mounts the GSI at `/android` with the device's real `/vendor` bound in.

## Method

**Collect evidence before changing anything** (SFOS hadk-hot, <https://sailfishos.wiki/books/hardware/page/hadk-hot>). `dmesg -w` live; boot with `audit=0` (kills audit spam) and `printk.devkmsg=on` (unthrottled userspace → kmsg — the stock bluejay cmdline already carries it); `journalctl -b-1` reads the previous boot once the journal is persistent (tooling appendix); logcat output differs run as root vs user.

**Diff your built `.config` against the vendor's before adding a single debugging aid.** If the vendor publishes a working config — a stock defconfig, `/proc/config.gz`, a factory image's `merged/.config` — this costs two minutes, needs no hardware, and is the highest information-per-effort step on a port that fails to boot:

```sh
grep -v '^#' built.config    | grep -v '^$' | LC_ALL=C sort > ours.cfg
grep -v '^#' stock_defconfig | grep -v '^$' | LC_ALL=C sort > stock.cfg
LC_ALL=C comm -23 ours.cfg stock.cfg     # what we added
LC_ALL=C comm -13 ours.cfg stock.cfg     # what we changed or dropped
```

Anything in the first list that touches **early boot** — console drivers, netconsole built in rather than modular, memory parameters, LSM or cgroup changes — is a boot-failure suspect before any of your porting work is. A splash hang with no console, gadget, pstore or initramfs trace came down to two lines of an eight-line diff, `CONFIG_FRAMEBUFFER_CONSOLE=y` and a built-in `CONFIG_NETCONSOLE=y`, both added as bring-up instrumentation (found on radon; see device-radon.md).

**Instrumentation is a change to the thing under test.** That fbcon/netconsole block made the first boot fail, then made the failure unobservable: no adb even in an `enable_adb` image, empty pstore despite `PSTORE_CONSOLE=y`, nothing from the initramfs trace — one symptom, misread as evidence about userspace. Prefer instrumentation that does not alter the kernel, such as `initrd_log_fail` (Stage 0).

**Substitute in both directions, and hold the cmdline fixed.** Hybrid boot images split kernel from ramdisk, but one direction is not a result:

| test | reading |
|---|---|
| vendor kernel + your ramdisk → hangs | "the ramdisk is at fault" — **wrong on its own** |
| your kernel + vendor ramdisk → hangs | both hang ⇒ the common factor is *your* kernel |

The cheapest kernel-vs-userspace separator is to take the stock (or LineageOS recovery) boot image and replace only the kernel. That is **not** a single-variable test: the donor brings its own command line, load addresses and page size. **Diff the two `Kernel command line:` lines before concluding anything.** A swap once "proved the kernel fine" only because the donor's cmdline lacked the `selinux=0` that was the whole bug (found on athena; see device-athena.md, and kernel-config.md § selinux=0: do not pass it on a Halium port). Caveats:

- A passing swap shows only that the kernel is not *unconditionally* broken under the donor's cmdline; only a failing swap is conclusive on its own.
- Strip cmdline tokens fatal to your kernel version (`swiotlb=1` is harmless on a 4.4 stock kernel and hangs a 4.19 before any console exists).
- A recovery that never comes up is inconclusive, not a result.
- The kernel's SELinux state is visible to the mount path: keep the donor's SELinux tokens, or change them as a separate variable.
- Check the logs you already have first — the experiment may already be in a log archive.

**Slice a multi-boot journal by boot before you count anything.** A journal from a bring-up session spans every boot since the last wipe; whole-file `grep -c` mostly counts the first, longest, most broken boot. Hundreds of compositor and keymaster crashes all turned out to sit in boots 1 and 4 and were already fixed, while the one live defect fired once per boot in all thirteen and was invisible in the totals (found on athena; see device-athena.md).

```sh
grep -an "Booting Linux on physical CPU" journal.txt | cut -d: -f1   # boundaries
LAST=$(grep -an "Booting Linux on physical CPU" journal.txt | tail -1 | cut -d: -f1)
tail -n +$LAST journal.txt > lastboot.txt                            # then grep this
```

A defect that appears once in every boot is stable, reproducible and usually the one worth chasing; a huge count confined to one boot is usually already fixed. Co-occurrence inside the boot where everything was broken is not evidence of causation. A freshly flashed device's RTC starts wrong, so one boot can carry several timestamp bases — slice by the boot marker, never by timestamp.

**A kernel `dev_err` is not a failure — read the return path.** Drivers log optional and non-fatal conditions at error level. Grep the exact string, open the driver and check whether that path sets a non-zero `ret`. `nq-nci`'s `nfc_ldo_config: regulator entry not present` returns 0 by design, and `nfcc_hw_check: - NFCC HW not Supported` is the `default:` arm of a switch on a chip ID *read back from the part* — positive evidence the chip answered; the real failure is `NFCC HW not available`/`-ENXIO` (found on athena; see device-athena.md).

**Check every measurement against uptime.** On a device that may reset under you, run `cut -d. -f1 /proc/uptime` in the *same* command as any measurement; a low uptime invalidates the sample. A suspiciously empty `journalctl -b` usually means the device rebooted, not that nothing happened.

## Stage 0 — Does the kernel even boot?

Nothing on the screen, no adb, device reboots or sits dead.

### Ramoops / pstore console

On a kernel panic the console log survives the reboot in pstore (`/sys/fs/pstore/`). The bluejay MCT clock panic — the `deferred probe timeout` wall and `Kernel panic: exynos4_timer_resources: unable to determine tick clock rate` — was read from the ramoops dump. If the device panics and resets, pull pstore before touching anything else. Not every kernel has it: athena's defconfig and DT carry no ramoops at all, so a panic before the initramfs is invisible there.

**A reset at the same second of every boot is a subsystem crash, not power.** A modem that lost its EFS (rmt_storage) with restart level SYSTEM reset the SoC ~10 s after "Brought out of reset". Read the battery before suspecting it: a RAM-booted initramfs holding a telnet shell showed 99 % (found on a3-2015-halium; see device-a3-2015-halium.md).

### MediaTek: expdb, DRAM ramoops and the hardware watchdog

MediaTek kernels often have no pstore console and, with USB as a vendor module, no gadget either. Read `expdb` and DRAM over the preloader, and feed or stop the preloader's hardware watchdog: soc-mediatek.md § Debugging a mute device.

### Recording the initramfs to a spare partition: `initrd_log_fail`

`initramfs-scripts-halium` (meta-android) can write its own dmesg to flash, for devices where nothing else survives:

- `initrd_log_fail` on the kernel command line turns it on. A background loop writes dmesg, mounts and the current stage every 3 s, and `panic()` writes a failure record. With it set, a failing initramfs **holds** (gadget and adbd up) instead of returning, so the device stops rebooting and the record stays the last thing written. Without the hold, `/bin/sh` with no console returns at once, init exits, and the kernel panics into another loop.
- default targets are `init_boot_a` (failure) and `init_boot_b` (progress), spare on the MT6789. **`initrd_log_part=<partname>`** names one partition instead: progress at 0 MiB, failure at 64 MiB. `cache` works where LuneOS bind-mounts over it from userdata (stock Android reformats it if it ever boots again).
- with `initrd_log_part=` the logger starts right after `/proc`, `/sys` and devtmpfs, retrying for 10 s until the partition appears — which only works with built-in storage. Without it, logging starts after module load and mdev, and a boot that dies earlier writes nothing.
- the boot-image header command line is the cheap way to set it on MediaTek: lk prints the cmdline it hands the kernel, so expdb confirms the flags arrived. Repacking the header needs no kernel rebuild, but a boot image with an AVB footer needs a fresh footer (meta-android `lib/halium/avb.py`).

Instrumentation traps (found on radon; device-radon.md): panic-only dumping writes nothing on a device that hangs rather than panics — use the periodic logger; heavy logging (`systemd.log_level=debug`, a large `log_buf_len`, the ring written every 2 s) changed how far the boot got; zero the log partitions before each boot and require a header in the reader; run one mtkclient process at a time.

Absence is informative: if the image demonstrably booted (lk shows the flags) and the partition holds no record, the boot died before the logger started or somewhere the initramfs never sees — e.g. the Android container's module loading after switch_root.

## Debug channels

### The debug boot image (`fastboot boot`, no flashing)

Every device kit ships a `boot-<device>-luneos-debug.img`: the same kernel + initramfs with `enable_adb` on the cmdline (construction: boot-images.md § Debug images). With `enable_adb`, init panics into the initramfs debug shell and the gadget's product string reads **"Failed to boot"**. The initramfs default is `USB_FUNCTIONS=rndis` (kept minimal: on the MP01 `"adb rndis ecm acm"` made the UDC vanish), so the shell is telnet, not adb, unless the machine overrides it:

```
telnet 192.168.2.15  # or `adb shell` where the machine adds adb
cat /dev/kmsg        # live kernel log, includes every initramfs message
```

The same shell appears without the debug image when the initramfs itself fails (e.g. `rootfs.img` not found). If you get the gadget, kernel and initramfs core are fine. "luneos initramfs failed:" with an empty reason is not a failure: `panic()` doubles as the debug-mode entry point and the reason is the *next* kmsg line (`Initramfs Debug Mode`).

**A debug image cannot observe a full boot.** The drop-to-shell is unconditional, so it never reaches systemd and can never show a userspace problem, and you cannot finish the boot by hand (`switch_root` requires PID 1). The normal image often has no network (the gadget is set up inside `panic()`), so the loop is: boot normal → let it run → `fastboot boot` the debug image → mount the data partition → read the journal the normal boot left behind. That only works if journald was syncing (tooling appendix).

### The telnet / USB-networking ladder

The Halium-family initramfs exposes a telnet path that works when adb doesn't, and the gadget tells you how far boot got (UBports: <https://docs.halium.org/en/latest/porting/debug-build/early-init.html>, <https://docs.ubports.com/en/latest/porting/build_and_boot/Boot_debug.html>; SFOS: <https://github.com/mer-hybris/hybris-boot>):

- **Watch the boot stage from the host** via the iSerial string:

  ```
  while : ; do lsusb -v 2>/dev/null | grep -Ee 'iSerial +[0-9]+ +[^ ]' ; done | uniq
  ```

  In hybris-boot: `"Mer Debug setting up (DONE_SWITCH=no)"` → `"Mer Debug telnet on port 23 on usb0 192.168.2.15"` (failed in the initrd) or `"GNU/Linux device on rndis0 10.15.19.82"` (booted).
- **telnet `192.168.2.15`:** port 23 = still in the initrd; port 2323 = post-switch_root debug in the hybris-boot scheme. Host side: take `192.168.2.1`, and give the interface a MAC if it shows `00:00:00:00:00:00`. First commands: `cat diagnosis.log` and check `/init.log`.
- **Reading the silence:** no USB device at all = kernel or initramfs never ran (unpack and inspect the flashed image; on A8–A10 Tier B suspect `skip_initramfs`, 1.6); port 23 answering = kernel + initrd fine, the rootfs transition failed.
- **Halting boot deliberately:** hybris-boot honours `init_enter_debug`/`init_enter_debug2` marker files and `fastboot boot boot.img -c bootmode=debug`; UBports' recovery flow waits until `echo continue > /init-ctl/stdin`. LuneOS has no halt-boot flag file; `enable_adb` is the analogue.

**LuneOS's own initramfs** starts `telnetd` at **`192.168.2.15` port 23** on its panic/debug path, with `udhcpd` serving the host `192.168.2.20–90` (no host-side configuration), and announces itself in iSerial (`LuneOS initrd telnet 192.168.2.15: <reason>`). It creates the functions named in `USB_FUNCTIONS` — default `rndis`; `ecm`, `acm` and `adb` only when a machine lists them — and links whichever the kernel supports. **Stock GKI 6.1 (bluejay/panther) ships ECM only; MTK 4.14 (mindphone) and athena's 4.19 RNDIS only**, so an ECM-only kernel needs `ecm` in `USB_FUNCTIONS`. Fixed gadget MACs (`FA:75:7F:BB:F4:E6`/`:E7`, first byte even) avoid the all-zeros-MAC refusal. ECM has no native Windows driver: use a Linux or macOS host on GKI Pixels (adb comes up alongside). All tools are busybox applets already in the initramfs. Two more channels ride along:

- **ACM serial console** — `acm.usb0` with a shell on `/dev/ttyGS0`; host `screen /dev/ttyACM0 115200`. Needs `CONFIG_USB_CONFIGFS_ACM=y` (stock GKI 6.1 and mindphone's 4.14 have it; athena's defconfig does not, and the function silently doesn't appear).
- **netconsole** — after the debug network is up, init attaches a dynamic netconsole target streaming kmsg to UDP broadcast port 6666 (`nc -ul 6666` on the host); it **survives switch_root into the full boot**. Init then **replays the early printk buffer** into it (`dmesg` re-injected into `/dev/kmsg`, prefixed `replay:`), since dynamic targets don't get `CON_PRINTBUFFER`; that needs `printk.devkmsg=on`. The config it needs, and why it is unsafe wherever a prebuilt vendor network module loads (the athena and mindphone fragments carry it): kernel-config.md § Debug options. Never put `netconsole=` on the cmdline of a configfs-gadget kernel (kernel-config.md § The kernel command line).

### The debug gadget is not necessarily adb

The gadget carries only the functions `USB_FUNCTIONS` names that the kernel supports, and the default (`rndis`) includes no adb: a gadget can come up as RNDIS, or ECM + ACM, with `adb devices` empty and the device perfectly reachable. Check all of these before concluding the device is dead:

```sh
adb devices
ls /dev/ttyACM*                  # screen /dev/ttyACM0 115200
ip -br link | grep -E "usb|enx"  # then: telnet 192.168.2.15
lsusb | grep -iE "18d1|0e8d"     # raw enumeration
```

### Two UDCs: never bind the gadget to `$(ls /sys/class/udc)`

Both `android-gadget-setup` (meta-android, `write $GADGET_DIR/g1/UDC "$(ls /sys/class/udc)"`) and the initramfs (`ls /sys/class/udc | grep -v dummy | head -1`) assumed exactly one USB device controller. A stock config with `CONFIG_USB_DUMMY_HCD=y` registers a fake `dummy_udc.0` beside the real one (MP01: `musb-hdrc`). The first script wrote both names into `UDC`, the kernel rejected it and the normal image had **no adb at all**; the only trace is easy to read past:

```
android-gadget-setup: === Writing dummy_udc.0
musb-hdrc into /sys/kernel/config/usb_gadget/g1/UDC
```

The second failed because busybox `ls` emits `dummy_udc.0  musb-hdrc` as **one line** into a pipe, so `grep -v dummy` discarded both. `dummy_udc.0` is no help even alone: it accepts the bind and does nothing. Fix both with:

```sh
first_real_udc() {
    for _u in /sys/class/udc/*; do
        [ -e "$_u" ] || continue
        _n=${_u##*/}
        case "$_n" in *dummy*) continue ;; esac
        echo "$_n"; return 0
    done
    return 1
}
```

and grep the tree for the other copy (`grep -rn "class/udc" <layers>`). Single-UDC devices only ever got lucky; check `CONFIG_USB_DUMMY_HCD` in a new device's stock config.

### RNDIS + SSH past the initramfs (Droidian)

Our `enable_adb` shell ends when the initramfs hands over; Droidian's primary channel is RNDIS + SSH into the booted rootfs (<https://docs.droidian.org/porting-guide/debugging-tips/>):

- Kernel needs `CONFIG_USB_CONFIGFS_RNDIS=y` ("stuck at the glowing logo and RNDIS is not working → check CONFIG_USB_CONFIGFS_RNDIS").
- Device at `10.15.19.82`, host `10.15.19.100/24`, then `ssh <user>@10.15.19.82`. Nothing on screen ≠ boot failure.
- Forward internet over the USB link:

  ```sh
  sudo sysctl net.ipv4.ip_forward=1
  sudo iptables -t nat -A POSTROUTING -o $INTERNET -j MASQUERADE
  sudo iptables -A FORWARD -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
  sudo iptables -A FORWARD -i $USB -o $INTERNET -j ACCEPT
  # on device:  ip route add default via 10.15.19.100 ; nameserver 8.8.8.8
  ```

- UBports' flag files `/userdata/.force-ssh` and `/userdata/.force-adb` enable SSH/ADB at boot regardless of config (<https://docs.ubports.com/en/latest/porting/configure_test_fix/USBModed.html>) — writable from recovery or fastboot when nothing else is.

### Logging a boot that dies before adb

Start a loop from the initramfs (chrooted into the rootfs, before switch_root) that the next boot can read: `while :; do dmesg > F.new && mv F.new F; sync; sleep 0.5; done`. Keep slow commands such as `logcat -d` out of it (it blocks until logd is up) and remove it afterwards — the half-second sync makes the UI sluggish.

### The device does not charge while you debug it

Neither fastboot nor the initramfs runs a charging policy (`get_charger_charging_current: ... failed: -95`). Hours of reflash cycles flatten the battery, and "rebooted to a battery symbol after some minutes" looks exactly like a crash or watchdog reset. Charge it powered-off on a real charger.

### Remote bring-up through a tester

When someone else holds the device, every round is a kit, a flash and a log archive, and a round lost
to the tooling costs as much as one lost to the port (found on goyavewifi; see device-goyavewifi.md).

- **Never let a collector wait on something that can stay alive.** An `strace -p` of a service that
  stopped crashing hung the tester's script. Bound every wait by time.
- **Check where the tester's tools look.** Two rounds went to an update script that wrote to
  `/data/luneos-data` while the installed rootfs was `/data/luneos`. Have the collector list the real
  paths first, and end with a result block the tester can paste.
- **The recovery's BusyBox is not GNU:** no `ls --full-time`, no `head -N`, no `timeout`, maybe no
  `sha256sum`. Test the scripts against it.
- **Debug patches go in the kernel recipe, not on the branch,** marked remove-me, with the kernel
  otherwise unchanged so the next round compares. A debug patch that prints nothing is an answer too.
- **Collect the container's logcat from the first round** (§ 2.4 Read the container's logcat).

## Stage 1 — Initramfs failures

The init fixes below are described in full in boot-images.md § Init patch history; this stage is how to recognise them.

### 1.1 Module load order — `modules.load` is not dependency-ordered

On GKI devices the vendor's early modules (from `vendor_boot` or `vendor_kernel_boot`) land in `lib/modules` of the merged initramfs, and our init must load them (fatal where even UFS is a module). Symptom of loading them in list order: no clocks, power domains deferred into the `deferred probe timeout` wall, MCT timer panic at 11.5 s (bluejay). Cause and rule: kernel-modules.md § `modules.load` is a list, not a dependency order; check any device's set host-side with `module-order.py` (tools.md).

### 1.2 Module cmdline parameters are not passed to loadable modules

`ufs-pixel-fips140: Invalid module params: first_lba=0 last_lba=0` → `Kernel panic: FMP self test failed` at 2.3 s: **`module.param=` cmdline options apply only to built-ins**, and plain `insmod` does not parse `/proc/cmdline`. The init passes them itself (boot-images.md § Init patch history, v3).

### 1.3 Async storage probe and userdata

- UFS probes asynchronously and `mountroot` has no retry: init polls for `userdata*` (boot-images.md § Init patch history, v2).
- **userdata never grows on UFS** if the resize computes the size from the device path: `readlink -f` yields `/dev/sd*`, matching neither `mmcblk*` nor `disk*` (boot-images.md § The userdata-resize-on-UFS bug). Harmless after `fastboot format:ext4 userdata`; fatal to the shipped-userdata-image flow.
- **mdev creates kernel names, not partition names.** `mountroot`'s `find /dev -name userdata` finds nothing when mdev only made `/dev/sdc59` → "Couldn't find data partition" although the partition mounts fine by hand. Synthesise the by-name links from sysfs:

  ```sh
  for blk in /sys/class/block/*; do
      pn=$(sed -n 's/^PARTNAME=//p' "$blk/uevent" 2>/dev/null)
      [ -n "$pn" ] || continue
      [ -e "/dev/$pn" ] || ln -sf "/dev/${blk##*/}" "/dev/$pn"
  done
  ```

### 1.4 Missing tools, file layout, hotplug

- The initramfs lacked `udevadm` and `dumpe2fs` (`halium-boot.sh` calls both): settle is skipped and the resize check degrades — add them to `initramfs-android-image`.
- **`android-rootfs.img` must sit next to `rootfs.img` on userdata** (`halium-boot.sh` checks `/tmpmnt/android-rootfs.img`). `0001-halium-find-the-Android-image-instead-of-assuming-whe.patch` fixes the "userdata image with only rootfs.img in it does not boot" case.
- mdev hotplug writes `/sys/kernel/uevent_helper`, which needs `CONFIG_UEVENT_HELPER=y` — not in stock GKI configs (added to the LuneOS fragment; KMI-safe). Empty by-partlabel links are the symptom.
- Hardcoded `mmcblk0p*` numbers in old forked `machine.conf` files are stale (the initramfs discovers partitions by name); delete them.

### 1.5 Cmdline-level fixes (Droidian)

| Symptom | Fix |
|---|---|
| Device reboots immediately after flashing boot | remove a stale `systempart=` from the cmdline |
| Initramfs stuck / can't find data | add `datapart=/dev/disk/by-partlabel/userdata` |
| Initramfs refuses to exec `/init` | replace `console=ttyMSM0,115200n8` with `console=tty0` |

A serial console on a dead UART can hang init's stdio; Droidian appends `console=tty0` as standard (<https://docs.droidian.org/porting-guide/debugging-tips/>).

### 1.6 Your init never ran: `skip_initramfs`

On many A8–A10 vendor kernels the bootloader passes `skip_initramfs` and the kernel bypasses the packed ramdisk — a repacked boot.img flashes fine and your init never executes (no gadget, no logs, stock-looking behaviour). First suspect when a Tier B device ignores a repacked ramdisk; the kernel fix is in boot-images.md § The `skip_initramfs` trap.

### 1.7 Recovery as a debug environment (Droidian)

On devices with TWRP/recovery the rootfs can be inspected and repaired without booting it:

```sh
mkdir /tmp/mpoint
mount /data/rootfs.img /tmp/mpoint
chroot /tmp/mpoint /bin/bash
export PATH=/usr/bin:/usr/sbin
```

Grow it offline with `e2fsck -fy /data/rootfs.img && resize2fs -f /data/rootfs.img 8G`. Recovery is also where you read `/sys/fs/pstore/` after a panic and mask broken units before the next attempt.

### 1.8 The vendor modules may not be in the merged ramdisk at all

1.1 assumes the bootloader concatenated `vendor_boot`'s ramdisk with ours, as AOSP specifies. Verify it: when it does not happen, `load_kernel_modules()` returns silently (`[ -f /lib/modules/modules.load ] || return 0`), and a device whose storage *and* USB are modules cannot find its root filesystem and cannot tell you so.

The fix is to ship a **minimal** set of the vendor's modules (storage, USB, watchdog)
inside the LuneOS initramfs, not the whole set:

```
ANDROID_EXTRA_INITRAMFS_IMAGE_INSTALL = "<machine>-vendor-modules"
IMAGE_ROOTFS_SIZE:pn-initramfs-android-image = "65536"   # default 8 MB is too small
```

with a recipe installing the extracted `.ko` plus `modules.load`/`.dep`/`.softdep` to
`/lib/modules`. Keep the boot image near stock size: embedding all 180 MP01 modules
(+5.5 MB) made MediaTek lk stop starting our init at all, silently (found on mp01; see
device-mp01.md). If the concatenation does happen, the same files land in the same
place. Use `install`, not `cp -a`, in `do_install`, or `do_package` dies with
`KeyError: 'getpwuid(): uid not found: 1000'` (kernel-modules.md § A standalone kernel
recipe: the packaging shape that works).

### 1.9 Debug mode must come *after* module loading

An init that checks `enable_adb` and panics into the debug shell before `load_kernel_modules` is fine where UFS and the gadget are `=y`, and fatal where USB, storage or the watchdog are vendor modules: the shell has no block devices, and on MediaTek no `mtk_wdt.ko`, so the watchdog shoots a perfectly working debug mode within seconds ("the debug image bootloops"). `load_kernel_modules` + `start_mdev` now run before the `enable_adb` check; the loader is bounded and returns at once when `modules.load` is absent.

### 1.10 Ramdisk compression must match across the concatenation

The kernel unpacks `vendor_boot`'s ramdisk and ours as one stream, and AOSP requires the **same compression** (GKI: lz4). With a gzip ramdisk behind an lz4 vendor ramdisk ours was never unpacked, the vendor's `/init` symlink survived, Android's init ran and the device landed in **Android Recovery** ("Try again / Factory data reset") — which reads like a userdata problem and is not (found on mp01).

```sh
xxd -l 4 ramdisk     # 02 21 4c 18 = LZ4 *legacy*, 1f 8b = gzip
```

`GKI_RAMDISK_COMPRESSION = "lz4-legacy"` in the machine conf repacks it. It must be **legacy** lz4 (`lz4 -l`), not the frame format (`04 22 4d 18`) — `lib/decompress_unlz4.c` only knows the legacy magic.

### 1.11 Vermagic: match it rather than force it

Stock storage/USB modules in the ramdisk refuse to load while every CRC check passes: the
initramfs has only busybox `insmod` (no `--force-vermagic`), so the vermagic must match
exactly, down to a trailing `+`. Recipe (LOCALVERSION, empty `.scmversion`, SUBLEVEL) in
kmi-crc-matching.md § Step 0.

## Stage 2 — Android container failures

The rootfs is up, systemd runs, but HALs / display / radio are dead.

### 2.1 Init "stuck" vs "curtailed" — look for `wait_for_prop` first

Halium patches Android init so the framework never starts, and `on nonencrypted` is dead on a GSI (no fstab, so `mount_all` never runs). It is tempting to conclude init stopping after `post-fs-data` is by design; **it usually isn't**. On sargo, `init.<board>.rc` gates `post-fs-data` on `wait_for_prop vendor.qcom.time.set true`, set by Android's `time_daemon`, which Halium doesn't run. `wait_for_prop` blocks init's state machine outright — `early-boot`, `boot`, every `class_start` and every `chown`/`chmod` the HALs need is never reached. Setting that one property brought up the modem subsystem (`per_mgr`, `per_proxy`, `pd_mapper`, `qcrild`), fixed the vibrator restart loop, zeroed the sensors' QMI errors and cut EACCES failures from 50 to 1.

`start-android-hals.sh` generalises this: parse every `wait_for_prop` from the container's rc files, grant a grace period, force only the stragglers, and replay `class_start`/`chown` as a safety net (hal-userspace.md § Derive, don't ship). SFOS mitigates from the other end by disabling `time_daemon`/`vendor.time_daemon` via a `disabled_services.rc` in the container's init dirs (stops "RTC initialization failed" loops).

### 2.2 The quoted-property trap

mt6739's vendor rc writes `wait_for_prop hwservicemanager.ready "true"` — quotes that init's parser strips. The awk harvest kept them, so the gate never looked satisfied, and after the grace period the script forced the literal `"true"` (quotes included) — **wedging every libhidl `WaitForProperty`, i.e. every HIDL `getService`, on host and container**. It was the root cause of the mindphone boot-splash hang under several real-but-secondary bugs; fixed with a gsub in the awk. sargo's gates carry no quotes — "works on device A" proves nothing about the parser.

### 2.3 Container init dies with no trace

Inside the LXC container init often has no usable `/dev/kmsg`, so KernelLogger discards every line; init is built with `REBOOT_BOOTLOADER_ON_PANIC`, so a fatal signal becomes a handled `reboot()` that a pid namespace delivers as SIGHUP. All the container manager says is `Child <pid> ended on signal Hangup(1)`. Two AOSP init patches (the halium-16 init-logging patches) close the hole: **tee every log line to `/dev/socket/init.log`** (bind-mounted from the host, so it outlives the container) and **breadcrumbs before `InitKernelLogging`** at `FirstStageMain` entry and after `/dev` setup. That is how the Android 16 GSI's PropertyInit failure was found: `prop_area::map_prop_area_rw` with the host's **4M `/dev` tmpfs out of pages** while mapping one 128K `prop_area` per property context (~557 on a 16 GSI).

### 2.4 Read the container's logcat, not just journalctl — the ashmem case

`systemctl is-system-running = running`, 0 failed units, 32 audio sinks, working nyx/ofono — and the bootloader splash forever, with nothing in journalctl. Only the **container's logcat** showed it: from Android 12, libcutils opens `/dev/ashmem<boot_id>`, not `/dev/ashmem`; the container's init creates that node inside the container, but hybris runs on the host, so every `ashmem_create_region()` failed, libfmq could not allocate, the HIDL composer's command queue was never created and the compositor sent no display commands. Fix: create `/dev/ashmem<boot_id>` on the host (`mount-android.sh`). Applies to any A12+ GSI.

Collect it from the first boot, not after the journal runs dry: `lxc-attach -n android -- logcat -d -b all`.
HAL services log through logd only; a service that exits 1 at every start may say nothing in dmesg or
the journal and say why in one logcat line (goyavewifi: gralloc and the composer, gsi-building.md
§ Before deriving, item 5).

### 2.5 The property service: enabled, but not running

`setprop` from a host process failing (`libc: Unable to set property "vendor.debug.sf.hwc_pid" ... connection failed`) looked like a permissions problem; `android-property-service` was simply `inactive` with **no journal entries at all** — enabled, `After=android-system.service`, never started. Reads keep working (the property area is mapped read-only), which is what makes it confusing. MediaTek's hwcomposer sets properties during init, so this is not cosmetic. The unit being *enabled* is not evidence it ran: `systemctl is-active` plus an empty `journalctl -u <unit> -b` is the tell.

### 2.6 Other container-side failure modes

| Failure | Cause / fix |
|---|---|
| vndservicemanager aborted, every vendor HAL blocks on `/dev/vndbinder` | A stock vndservicemanager aborts without selinuxfs — preload `libselinux_stubs` (halium device-tree patch; on 32-bit the GSI preloaded it from a hardcoded `/system/lib64/` path and died — fixed in `device/halium/halium_arm`) |
| Boot queue hangs on one bad HAL | `lshal` hangs forever on an unresponsive HAL — `luneos-device-config` runs it under a per-call watchdog |
| Dynamic-partition mounts racy/missing nodes | dmsetup/udev race — `dmsetup mknodes` in `mount-android.sh` |
| Binder calls fail on host | Host needs `/dev/{binder,hwbinder,vndbinder}` symlinks into binderfs |
| `.capex` APEXes silently skipped on a 16 GSI | `mount-apexes.py` cannot mount compressed APEXes — `PRODUCT_COMPRESSED_APEX := false` |
| `/init` aborts instantly on a 4.9 kernel | `MADV_WIPEONFORK` needs Linux ≥ 4.14 — made non-fatal in hybris-patches |
| getprop/setprop TLS abort on the Android 16 GSI | Needs the Android 16 libhybris adaptation (graphics.md § libhybris fixes) |
| Container "service not found" for zygote/netd/update_verifier | By design — the Halium GSI strips them |
| `init: Processed ctl.start for 'X' from pid: 0` for a "disabled" service | `start-android-hals.sh` starts everything init skipped; exclude with `deviceinfo_android_skip_services` |
| "add_service Permission denied" / "Unknown class service_manager" | SELinux config files must be real files, not symlinks; "Unknown class" in permissive wants stub services. dmesg shows `SELinux: Disabled at boot` (hybris ≤16) vs `SELinux: Initializing` (≥17) (SFOS hadk-hot) |
| `libandroidicu.so not found` (libicui18n/libicuuc) | Symlink from the runtime APEX, e.g. `/odm/lib64/libandroidicu.so → /apex/com.android.runtime/lib64/…` (SFOS hadk-hot) |
| apexd/loop-device failures | `loop.max_part=7`, the loop block-size patch, or the "linkerconfig: switch no-updatable-apex" hybris-patch; check `/proc/device-tree/firmware/android/fstab/` for early-mounted partitions (SFOS hadk-hot) |
| Early crash-loop on Exynos 9810/9820 | `systemd-journald` crashes the device — mask it; on broken-namespace kernels mask `systemd-resolved` and `systemd-timesyncd` too (Droidian) |
| A setting in a unit's `EnvironmentFile=` has no effect | `export VAR=…` lines are ignored (`Ignoring invalid environment assignment 'export …'`); confirm with `tr '\0' '\n' < /proc/<pid>/environ` |

### 2.7 Working the container by hand

- `lxc-checkconfig` checks the running kernel for every namespace/cgroup option LXC needs; `lxc-ls --fancy` shows container state.
- Start the container manually with full logging: `lxc-start -n android --logfile=/tmp/lxclog --logpriority=DEBUG`. To debug the host side alone, override the service with `ExecStart=/bin/true` (Droidian).
- Logs from inside: `lxc-attach -n android -- /system/bin/logcat` (`-b radio` for RIL). `logcat -b all -c` right before a restart you want to observe when one tag floods the buffer.
- **The container's init cannot be started twice** (SFOS hadk-hot): a second start fails on leftover state, so a restart-looping container init hides the *first* failure. No logcat before Android init is up ≠ broken logging.
- **Native backtraces of a hung HAL:** `lxc-attach -n android -- /system/bin/debuggerd -b <container pid>` (the container has its own pid namespace; take the pid from logcat or `lxc-attach ... pidof`).
- **strace a vendor daemon** by editing its rc service line: `mkdir -m777 /data/strace`, then `service tad /usr/bin/strace -ff -o /data/strace/tad.strace /vendor/bin/tad …` (SFOS hadk-hot).
- **Do not `nsenter` into the container's mount namespace on a 3.x kernel**: copying a vendor dir through `/proc/<pid>/root` and bind-mounting it hung the phone twice. Fix the image instead.

### 2.8 Userspace resets that are not crashes

A device going down every few minutes with a *clean* shutdown in `journalctl -b -1` ("Reached target System Power Off") is being shut down on purpose; `journalctl --list-boots` shows the rhythm. Suspects: `sleepd` (mask it during bring-up) and batteryd's critical-percent check fed by a gauge reporting `capacity=-1` (`CHG_LOGIC: Battery at -1%, at or below the critical level of 2%`).

## Stage 3 — Display and UI

Two black-screen shapes:
- **Stuck on the bootloader splash** with a healthy system underneath → the compositor never sent display commands: ashmem/composer (2.4), init gates (2.1), or DRM master (below).
- **Screen dark but everything runs** → check the backlight first: on mindphone nothing drove `/sys/class/leds/lcd-backlight` and the panel booted at 0 (`echo 200 >` from a compositor drop-in as a bring-up hack; the real fix belongs in the display service). Many Qualcomm panels take a max of **2047**, not 255 (Droidian).

The libhybris smoke-test ladder, charger-mode DRM master and measuring a cropped window: graphics.md.

### Other display/UI failure modes

| Symptom | Cause / fix |
|---|---|
| Compositor blocks forever before starting | `product.env` DRM probe loops on DRM-less devices — guard the probe |
| Wrong/unknown panel geometry | Read `/sys/class/graphics/fb0/modes`, **not `mode`**, which empties once the compositor owns the panel; never trust copy-pasted display constants (mindphone's conf claimed 1080x2340 for a 480x800 panel) |
| Every `eglCreateContext` → `EGL_BAD_ALLOC`, webapps never render | GPU node permissions: `/dev/pvr_sync` and `/dev/ion` needed 0666 (the vendor ueventd.rc values) for the WAM user — a udev rule; hal-userspace.md § udev rules from the container's own ueventd files derives these |
| QML apps die with "Failed to create wl_display" | XDG_RUNTIME_DIR split — graphics.md § Wayland socket |
| Compositor races the vendor HAL | Wait for `IComposer` to register on hwbinder; Droidian's `ExecStartPre=sleep 5` drop-in is the weaker version |
| Compositor spins on "failed to get drm master" | Device booted in charger mode (below), or the HWC was opened twice (`deviceinfo_force_hwc2`) |
| Hardware keys ignored by Qt | udev tags the keypad `ID_INPUT_KEY` only; Qt evdevkeyboard needs `ID_INPUT_KEYBOARD` — promote with a udev rule (mindphone `mtk-kpd`) |
| Compositor picks `Writeback1`, hangs ~90 s and restarts forever (MediaTek) | MediaTek DRM reports its writeback connectors as permanently connected; exclude `Writeback` connectors in `product.env` as well as `Virtual` (device-radon.md) |
| Healthy LuneOS behind a foreign boot logo | A vendor/distro initramfs started plymouthd, which survives `switch_root` holding the framebuffer; boot with `plymouth.enable=0` (device-radon.md) |
| `library "libpq_cust.so" not found` from MTK HWC | Benign — the vendor ships `libpq_cust_base.so` and the HAL falls back |

## Stage 4 — Subsystems

### First question for any subsystem: is the HAL registered at all?

```
binder-list -d /dev/hwbinder | grep IRadio      # modem
binder-list -d /dev/hwbinder | grep ISensors    # sensors
```

If the interface is absent, middleware config is irrelevant — go back to Stage 2. If `binder-list -d /dev/binder` shows **nothing at all**, or AIDL HALs the vendor publishes are "missing", check libgbinder's `ApiLevel` first (hal-userspace.md § Before blaming AIDL); ofono-binder-plugin, bluebinder, sensorfw and nfcd all sit on libgbinder. libhybris' smoke binaries (`test_egl`, `test_hwcomposer`, `test_vibrator`, `test_gps`, `test_audio`; `test_sensors` is legacy-HAL only) answer "does the blob respond at all?" before any middleware exists (SFOS hadk-faq).

**Is the subsystem's module even loaded?** Compare against the vendor's list:

```sh
M=/android/vendor_dlkm/lib/modules; L=$(lsmod | cut -d" " -f1 | tr - _)
while read m; do b=$(basename $m .ko | tr - _); echo "$L" | grep -qx "$b" || echo "$m"; done < $M/modules.load
```

A whole subsystem missing (camera, audio) points at module loading, not the HAL — kernel-modules.md § The vendor_dlkm set.

### Wi-Fi, Bluetooth, modem and audio

Bring-up and debugging detail per radio is in connectivity.md (Wi-Fi incl. the regulatory db and the TCP-hang matrix, Bluetooth incl. `btmon`, modem fstabs) and audio-media.md § Debugging audio.

### Misc

- **Network-time toggle fails:** LunaSysService's `enableNetworkTimeSync()` runs `timedatectl set-ntp`, and there is no `timedatectl` on a device — meta-luneos removes `timedated` and `timesyncd` on purpose, since LunaSysService's own sntp path owns time (nyx-modules.md). Do not add them back.
- **Waydroid** stops the host's nfcd, and needs the IPC/USER namespaces kept: hal-userspace.md § Waydroid.
- **`appinstalld2`: `Failed to execute child process "ar"`** — the standard image has no `ar`. Installer failures are explained in the journal: `LunaAppManager`, `appinstalld` and `ApplicationInstallerUtility` log the exact `opkg` command line.

## Stage 5 — Idle health: the port "works" but burns CPU, flash or battery

**Metrics to collect on any idle device:** per-process *cumulative* CPU vs uptime (`ps -o time` against `uptime` — 2 h used in 10 h is 20% of a core however calm it looks now), journal *and* container-logcat lines/s, GB/h whole-disk flash writes, `SUnreclaim` slope over **at least a day** (minutes cannot separate a slow leak from churn), and the suspend entry count (check it before trusting wake-from-suspend). Five proven patterns, from the sargo/tissot/bullhead idle triage:

1. **A bypassed vendor helper daemon busy-spins.** tissot's `wcnss_filter` sat at 96% of a core logging ~62,000 lines/s (and `logd` another 36% absorbing it): libbt-vendor `ctl.start`s the filter, but LuneOS reaches BT via bluebinder/vhci and never uses it, so its SoC open fails and `handle_soc_events()` spins on a dead fd. BT works fully without it. Fix shape: stop it plus a periodic guard (it gets `ctl.start`ed again on some BT power-on paths — recipe `tissot-wcnss-filter-fixup`, 30 s guard). Sort processes by cumulative CPU and measure the container log rate on every "working" port.
2. **Zero-interval GTimerSource spin.** A `GTimerSource` with `interval_ms == 0` expires the instant it is dispatched and re-arms without reaching poll: `sleepd` at 25% of a core, ~40,000 wakeups/s (fixed in sleepd `herrie/fix-zero-interval-timer`). Signature: a constant fraction of a core, enormous wakeup count, no I/O.
3. **pulseaudio pinned by an uncorked stream.** A GStreamer pipeline left PLAYING after EOS keeps an uncorked sink input, so `module-suspend-on-idle` never suspends the sink. Diagnose with `pactl list sink-inputs` (`Corked: no` long after the sound ended); prove the cost with `pactl suspend-sink <sink> 1`. (The Qt 6 EOS case and its numbers: device-sargo.md § Idle health.)
4. **Kernel debug spam wears flash.** A driver shipping a verbose `debug_mask` can nearly double idle writes (sargo's `qpnp_smb2`; device-sargo.md § Idle health). Silence it via module parameters in a `tmpfiles.d` rule — **not** via the device-config sparse overlay, which has no ordering against `systemd-tmpfiles-setup.service`.
5. **Restart loops cost CPU.** Services restarting every few seconds keep cores busy and look like a slow port: on bullhead WebAppMgr every 6 s and sensorfwd every second kept four A53s busy, touch was slow and sound repeated. Look for restart loops before blaming performance (device-bullhead.md).

## Symptom → likely cause → where to look

| Symptom | Likely cause | Where to look |
|---|---|---|
| Hangs at bootloader splash, no console/gadget/pstore | A debug aid in your config broke early boot (fbcon, built-in netconsole) | § Method: diff `.config` vs stock |
| Device resets, nothing visible | Kernel panic | § Ramoops / pstore console |
| Reset at the same second of every boot | A subsystem crash with restart level SYSTEM (e.g. modem lost EFS) | dmesg before the reset; battery reading (§ Ramoops / pstore console) |
| MediaTek: silent reset ~20–30 s in, `wdt_status` non-zero in expdb | Hardware watchdog unfed (mtk_wdt is a module) | soc-mediatek.md § The hardware watchdog; § 1.9 Debug mode must come after module loading |
| MediaTek: reset every ~90–120 s, no panic, journal just ends | 31 s SoC watchdog | soc-mediatek.md § The hardware watchdog |
| MediaTek: reboots ~20–30 s in, lk says `boot reason = 4` / `kernel_panic`, expdb has no kernel log | Panic after userspace started; often a force-loaded vendor module on a struct-layout mismatch | soc-mediatek.md § Read ramoops straight out of DRAM (`mtk da peek`); kmi-crc-matching.md § Struct layouts |
| Faillog image booted, partition holds no record | Died before the logger, or after switch_root | § Recording the initramfs; soc-mediatek.md § Read ramoops straight out of DRAM |
| No USB gadget at all after flash | Kernel/initramfs never ran | unpack the flashed image; § 1.6 Your init never ran on A8–A10 Tier B |
| Repacked image flashes fine, our init never executes | `skip_initramfs` honoured by the vendor kernel | § 1.6 Your init never ran |
| Device enumerates but `adb devices` is empty | Gadget came up as ECM/ACM/RNDIS without adb | § The debug gadget is not necessarily adb |
| No adb on the normal image; log shows two names written to `UDC` | Two UDCs (`dummy_udc.0`), unparsed `ls /sys/class/udc` | § Two UDCs |
| USB gadget "Failed to boot" | initramfs couldn't finish (often rootfs.img not found) | § The debug boot image |
| "luneos initramfs failed:" with empty reason | Debug mode entry, not a failure | next kmsg line (§ The debug boot image) |
| Debug image bootloops on MediaTek | Watchdog kills the shell before modules load | § 1.9 Debug mode must come after module loading |
| Debug image never shows the userspace bug | It cannot boot past the initramfs | § The debug boot image |
| Telnet port 23 answers | Kernel + initrd fine; rootfs transition failed | § The telnet / USB-networking ladder |
| Device lands in Android Recovery ("Try again / Factory data reset") | Ramdisk compression mismatch; vendor `/init` ran | § 1.10 Ramdisk compression must match |
| `deferred probe timeout` wall, then timer/clock panic | `modules.load` isn't topological | § 1.1 Module load order; tools.md § module-order.py |
| Driver panics on unset params (e.g. FMP self test) | `<module>.param=` not passed to insmod | § 1.2 Module cmdline parameters |
| Panics to adb only sometimes | Async UFS probe, no mountroot retry | § 1.3 Async storage probe |
| "Couldn't find data partition", partition mounts by hand | mdev made kernel names only | § 1.3 Async storage probe |
| First boot ok, disk full soon after | userdata never resized (`/dev/sd*`) | § 1.3 Async storage probe; boot-images.md § The userdata-resize-on-UFS bug |
| by-partlabel links empty | mdev hotplug needs `CONFIG_UEVENT_HELPER` | § 1.4 Missing tools |
| Root fs never found, storage + USB are modules | Vendor modules not in the merged ramdisk | § 1.8 The vendor modules may not be in the merged ramdisk |
| Stock modules refuse to load from the initramfs (vermagic) | Release string differs, often by a trailing `+` | § 1.11 Vermagic: match it rather than force it Vermagic |
| Boot dies with a serial console on the cmdline | init's stdio hung on a dead UART | `console=tty0` (§ 1.5 Cmdline-level fixes) |
| Init "stops" after post-fs-data; HALs missing, EACCES everywhere | `wait_for_prop` gate | § 2.1 Init "stuck" vs "curtailed" |
| Every HIDL getService blocks, host + container | Property gate forced with a quoted literal | § 2.2 The quoted-property trap |
| "Child ended on signal Hangup(1)", container dead, no logs | Container init died pre-logging | § 2.3 Container init dies with no trace |
| 0 failed units, audio up, stuck on boot splash | Host-side ashmem → libfmq → composer queue | **container logcat**; § 2.4 Read the container's logcat |
| `setprop` "connection failed" from the host; getprop works | `android-property-service` never started | § 2.5 The property service |
| All vendor HALs block on vndbinder | vndservicemanager aborted (selinuxfs) | § 2.6 Other container-side failure modes |
| Boot queue hangs at HAL enumeration | lshal hung on one HAL | § 2.6 Other container-side failure modes |
| A "disabled" Android service runs anyway | `start-android-hals.sh` started it | hal-userspace.md § Stubbing a service vs not starting it |
| `add_service Permission denied` | selinux config files are symlinks, or stubs missing | § 2.6 Other container-side failure modes |
| Container init restart-loops | Second start fails on leftover state | find the *first* failure (§ 2.7 Working the container by hand) |
| Setting in `EnvironmentFile=` has no effect (e.g. `QT_QPA_FORCE_HWC2`) | `export ` prefix — systemd ignores the line | `/proc/<pid>/environ` (§ 2.6 Other container-side failure modes) |
| Clean shutdown every few minutes | Userspace policy: sleepd, or batteryd on `capacity=-1` | § 2.8 Userspace resets that are not crashes |
| Device powers off within a minute while charging | batteryd critical-percent check on a gauge reporting `capacity=-1` | § 2.8 Userspace resets that are not crashes |
| batteryd reports `Charging:false` on the cable | Charger `online` is `2`; nyx accepted only `1` | nyx-modules.md |
| "Rebooted to a battery symbol" during long sessions | Battery flat — nothing charges during debugging | § The device does not charge while you debug it |
| Screen dark, system healthy | Backlight at 0 | § Stage 3 |
| Compositor never starts on DRM-less device | DRM probe loop | § Other display/UI failure modes |
| Compositor spins on "failed to get drm master" | Android `charger` holds it (charger-mode boot), or HWC opened twice | graphics.md § Charger-mode boots and DRM master; `lsof \| grep card0` |
| Apps: "Failed to create wl_display" | XDG_RUNTIME_DIR split | graphics.md § Wayland socket |
| EGL_BAD_ALLOC everywhere | GPU node perms (ion/pvr_sync) | § Other display/UI failure modes |
| Compositor SIGSEGV ~1 s in, `si_addr` is ASCII text (Mali) | Clobbered thread pointer: TLS hook missing / Mali quirks compiled out | graphics.md § Mali |
| test_hwcomposer segfaults / runs but black | Blob/linker fault, or gralloc/copybit | graphics.md § The display smoke-test ladder |
| Hardware keys ignored by Qt | Input node lacks `ID_INPUT_KEYBOARD` | § Other display/UI failure modes |
| Web app drawn too small / cropped | Client vs compositor size disagreement | graphics.md § Measuring a wrong-sized or cropped window |
| Nothing from ofono/sensorfw/nfcd despite config | HAL never registered, or wrong gbinder `ApiLevel` | § First question for any subsystem; hal-userspace.md § Before blaming AIDL |
| AIDL HAL "missing" on an A15+ vendor | `ApiLevel` from a dated `ro.board.api_level`, or a HIDL-only daemon | hal-userspace.md |
| Audio, camera or other subsystems dead; modules not loaded (GKI) | Container's `/vendor_dlkm` is an empty bind | § First question for any subsystem; kernel-modules.md § The vendor_dlkm set |
| Wifi service restart-looping | modprobing a nonexistent module | is the driver built in? (connectivity.md § Wi-Fi) |
| No wifi on MTK; `wmt_loader` errors | WMT modules not loaded, nodes not exposed, power-on not retried | soc-mediatek.md § Connectivity combo |
| A unit never runs on one machine, nothing in the journal | Gated on `/sys/module/...` with a built-in driver | connectivity.md § Never gate a unit on `/sys/module/<driver>` |
| Wi-Fi works but no 5 GHz networks; `iw reg get` says country 00 | No regulatory.db, or the latched early load | connectivity.md § Regulatory domain |
| Ping works, TCP hangs | Path problem (often the router's band bridging) | connectivity.md § "Wi-Fi associates, ping works, but TCP hangs" |
| `Required key not found` on modprobe | Module signature enforcement (Tier B) | kernel-modules.md § Module signing |
| Vendor modules never load on a rebuilt GKI kernel though the CRC check passes | `CONFIG_MODULE_SIG_PROTECT` must be off | kmi-crc-matching.md § A failure class invisible to CRC checks: MODULE_SIG_PROTECT |
| MTK modem "exception", RIL dead | Wrong fstab → NV partitions unmounted | connectivity.md § Modem failures on the Android side |
| SIM never detected (Qualcomm) | `/dev/block/bootdevice/by-name` structure missing | connectivity.md § Modem failures on the Android side |
| BT HAL can't open its node | Container ueventd ownership vs vendor ueventd.rc | connectivity.md § Bluetooth |
| `hci0` DOWN, "Invalid request code (56)" | Controller rejects a command it advertised | connectivity.md § Finding a controller quirk with btmon |
| BT will not power on, `Blocked through rfkill (0x12)` | rfkill soft-block restored at boot; bluebinder's "Own hci index" is an rfkill index, not a mismatch | connectivity.md § Bluetooth |
| Reset 57 s in, `BUG_ON(!sk)` in `bt_sock_reclassify_lock` | Vendor stubbed `hci_sock_create()` | kernel-build.md § Vendor trees that stub out `net/bluetooth/hci_sock.c` (Samsung) |
| Audio pitched / tempo-shifted | pa-droid sample-rate quirk | audio-media.md § Audio |
| pulseaudio SIGSEGV after "cannot locate symbol ... referenced by /vendor/..." | Vendor HAL needs its VNDK | `HYBRIS_PREFER_VNDK` (audio-media.md § Audio) |
| PulseAudio killed ~1 s after startup, status 9 | `RLIMIT_RTTIME` on SCHED_RR sink threads | § Tooling appendix (`signal_generate` trace) |
| Speakers silent, headphones fine, HAL "undefined in AudioParamOptions" | Vendor lib assumes zeroed `malloc` | audio-media.md § Vendor libraries that assume Android's zeroed malloc |
| Sound card never registers (`-517`) | A deferred ASoC component's module not loaded | audio-media.md § Debugging audio |
| Web-app audio silent, nothing reaches PulseAudio | umediaserver: `waitid(P_PIDFD)`, pipeline binary, resource table | audio-media.md § webOS media server |
| `nfcd` stopped a few minutes after boot | Waydroid's container start stops it | hal-userspace.md § Waydroid |
| Waydroid: "Failed to clone a new set of namespaces" | Kernel lacks IPC_NS/USER_NS; config has no namespace keep | hal-userspace.md § Waydroid |
| Network-time toggle errors | No `timedatectl` by design | § Misc |
| `appinstalld2`: `Failed to execute child process "ar"` | No `ar` on the image | § Misc |
| Daemon at a fixed % of a core, ~40k wakeups/s, no I/O | Zero-interval GTimerSource | § Stage 5, pattern 2 |
| Vendor helper at ~100% of a core, massive logcat rate | Daemon bypassed by the LuneOS stack spinning on a dead fd | § Stage 5, pattern 1 |
| pulseaudio busy while silent; sink RUNNING forever | Uncorked stream (Qt EOS bug) | § Stage 5, pattern 3 |
| Idle flash writes high | Kernel driver debug_mask / log spam | § Stage 5, pattern 4 |
| Journal of a crashed boot ends after a few seconds | journald flushes every 5 min by default | § Tooling appendix |
| `CANNOT LINK EXECUTABLE … cannot locate symbol "strdup8to16"` (or similar) from a LineageOS vendor blob | A LineageOS linker shim the GSI's linker does not load | gsi-building.md § Before deriving, item 1 |
| `Service android.hardware.<hal>@x::I…/default must be in VINTF manifest in order to register/get` | The vendor declares the HAL passthrough | gsi-building.md § Before deriving, item 2; yocto.md § Shipping fixes through /odm |
| sensorfwd logs "Could not find 'android.hardware.sensors@1.0::ISensors/default'" and exits | No sensors service on a passthrough-only vendor | hal-userspace.md § Sensors |
| The library name resolves, a symbol does not (`PermissionCache`, `checkCallingPermission`) | A blob linked against the system libbinder; the vendor has its own | gsi-building.md § Before deriving, item 3 |
| `library "libicu.so" not found` | ICU is in the i18n APEX, not /system/lib | gsi-building.md § Before deriving, item 4 |
| Allocator and composer HAL services (`vendor.gralloc-2-0`, `vendor.hwcomposer-2-1`) exit status 1 at every start, nothing in dmesg or the journal; logcat: `vndksupport: Could not load /vendor/lib/hw/gralloc.<soc>.so … library "libft2.so" not found: needed by /vendor/lib/libpdfium.so` (or `libhwui.so`) | The LLNDK list names libft2.so, the vendor namespace does not hand it over | gsi-building.md § Before deriving, item 5 |
| `service 'X' overrides another service across the treble boundary` | /odm or /vendor override of a system service | yocto.md § Shipping fixes through /odm |
| `No user specified for service 'X', so it would have been root` | Old vendor rc; Android 16 init drops the service | add `user` in an override (yocto.md § Shipping fixes through /odm) |
| Bluetooth: `BluetoothHci::close()` → `__throw_bad_function_call` abort loop, bluebinder times out | initialize never finished; on Qualcomm UART parts a force-started `wcnss_filter` | connectivity.md § Bluetooth |
| `droid-extevdev.c: Unable to open device /dev/input/eventN … Permission denied`; headphones ignored | `pulse` not in group `input` | audio-media.md § Audio |
| `kgsl_get_unmapped_area … failed error -12`; WebAppMgr's GPU thread crashes on every start | Chromium's low-4GB reservation vs a 32-bit-address Adreno | soc-qualcomm.md § Adreno 4xx on a 3.10 kgsl |
| Wi-Fi scans, every connect fails after 5 s with `result:70 and Status:9` (qcacld) | MFP optional vs `WIPHY_FLAG_SUPPORTS_FW_ROAM` | kernel-build.md § Legacy 3.x kernels |
| `init: Service 'lmkd' … received SIGABRT` every 5 s on a 3.x kernel | libmemevents needs BPF | soc-qualcomm.md § A LineageOS 21 vendor without VNDK |

## Tooling appendix

**Make the journal survive a forced power-off.** `Storage=auto` with the default `SyncIntervalSec=5m` means a capture often holds only the first seconds of a boot that ran for minutes — it reads exactly like an early crash. Before debugging anything slower than a few seconds:

```
# /etc/systemd/journald.conf
Storage=persistent
SyncIntervalSec=1s
```

Check *where* the journal lives: on a Halium rootfs `/var` is commonly bind-mounted from the data partition, so `rootfs.img`'s `/var/log/journal/` is empty and the real one is in `<data>/luneos-data/var/log/journal/<machine-id>/`. Boot-time kernel lines rotate out of the dmesg ring and the journal's kernel part within minutes on a chatty MTK kernel — read them right after boot or capture `journalctl -k -b` early.

**`sh -x` as ExecStart for a unit that logs nothing.** A `Type=notify` unit that times out with no output has usually died before its first log statement:

```
# /etc/systemd/system/<unit>.service.d/99-debug.conf
[Service]
ExecStart=
ExecStart=/bin/sh -x /usr/bin/<the-script>
```

`exec` at the end of the script keeps the PID, so `Type=notify` still works.

**Test an environment variable without writing a file:** `systemctl set-environment VAR=1; systemctl restart <unit>; systemctl unset-environment VAR`.

**Who sent the SIGKILL?** For a process "killed, status=9/KILL" with no log and no core, trace the kernel's signal generation:

```sh
T=/sys/kernel/tracing                     # tracefs is mounted on Halium images
echo 0 > $T/tracing_on; echo > $T/trace
echo "sig==9" > $T/events/signal/signal_generate/filter
echo 1 > $T/events/signal/signal_generate/enable; echo 1 > $T/tracing_on
# ... reproduce ...
echo 0 > $T/tracing_on; grep signal_generate $T/trace
```

The line names the *sending* thread; `code=128` (SI_KERNEL) in hard-IRQ context (`d.h`) means the kernel killed it itself. A sender of `init` or `systemd` is a different problem.

**strace a service under its real environment.** Running a daemon from a shell changes its environment enough to hide the bug; run it as a transient unit with the unit's own environment file: `systemd-run --unit=x -p EnvironmentFile=-/etc/default/foo /tmp/strace -f -e trace=openat,newfstatat -s 160 -o /tmp/x.log /usr/bin/foo ...`. There is no `strace` on the image; take the aarch64 one from the build's `tmp/deploy/ipk/aarch64-halium/strace_*.ipk` (`ar p ... data.tar.zst | zstd -dc | tar -x`) and pipe it over ssh into `/tmp` (same for `alsa-utils-amixer`/`-aplay`). To watch a running daemon, attach with `-f -p $(pidof daemon)` *before* triggering the action.

**Reading an aarch64 core with no gdb and no debuginfo.** Host `gdb` dies on aarch64 cores and the rootfs carries no debugger:

1. `eu-stack --core <core>` — raw frame addresses.
2. Parse `NT_FILE` from `readelf -n <core>` to map each address to its library; subtract the library's lowest mapped address for a file offset.
3. `readelf -sW <lib>` — the enclosing `FUNC` symbol.
4. Parse `NT_SIGINFO` **by hand** for `si_addr` (offset 16 in the descriptor on aarch64; `readelf` prints only the header). ASCII text there means a clobbered thread pointer, not a null deref.

The core's mapping list is a ground-truth inventory of which vendor blobs really loaded, and Android's property pages are mapped into it, so `strings core | grep ...` recovers live property values from a dead process.

**busybox is not GNU.** `ls` column-formats into a pipe (`dummy_udc.0  musb-hdrc` on one line) — iterate the directory instead; `head` wants `-n N`; there is no `timeout` (`cmd & p=$!; (sleep N; kill $p) & wait $p`); `dd` has no `conv=fsync` and prints its usage while writing nothing; `od`, `head -c` and `diff` are too limited for binary or file comparison — do that on the host; `ls -l a b 2>&1` interleaves differently.

**Writing files on the device.** Prefer `adb push` from a local copy over `adb shell "cat > file <<EOF ... EOF"` (on the MP01 several bootloops followed heredoc writes — a correlation only, unproven). Keep backups outside scanned directories: a `.orig` plugin next to the real one gets loaded too. `sed -i` on a running device can fail with "Device or resource busy" (it renames): write to a scratch file and `cat` it back over the original, then `sync` (found on athena).

**ext4 will not mount a device rw while it is mounted ro elsewhere**; it quietly gives another ro mount ("source write-protected"), and `umount -l` keeps the superblock held (found on radon; device-radon.md).

**Never `pkill -f`/`pgrep -f` a pattern that also appears in your own adb shell command line**; select by `/proc/<pid>/cmdline`.

**Reboot reliably from adb:** `systemd-run --on-active=2 /bin/systemctl --force reboot --reboot-argument=normal`. A backgrounded command dies with the adb session, and a plain reboot can land a Samsung device in charger mode.

**opkg can run other packages' pending postinsts.** Installing one ipk once configured a long-pending `android-kernel-bootimg` postinst that dd'd a kernel over lk2nd. Dry-run with `opkg install --noaction` and check `/var/lib/opkg/status` for unpacked packages first.

**`luna-send`:** `luna://com.webos.service.applicationmanager/launch` and `close` print a reply without `-i`; `-i` into a pipe printed nothing.
