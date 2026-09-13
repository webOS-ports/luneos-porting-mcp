# LuneOS GSI/GKI Bring-up Debugging Playbook

A stage-by-stage playbook for "the device doesn't come up", distilled from real bring-ups: Pixel 3a (sargo, Halium 9→14/16 GSI), Pixel 6a (bluejay, GKI Tier A), Pixel 7 (panther), and a MediaTek MT6739 32-bit device (mindphone). Every failure mode in the core text was hit on hardware and diagnosed; the fixes named are the ones that shipped. The playbook also folds in cross-checked material from the UBports, Droidian and SFOS porting guides (attributed inline with sources) — that material is other distros' documented experience, not LuneOS-verified; SFOS-derived command spellings in particular were extracted from summarized pages, so verify against the cited source if one fails. Work through the stages in order — each stage's failures are only visible once the previous stage is cleared, and several of these bugs hide behind one another.

**Log-collection discipline** (SFOS hadk-hot, <https://sailfishos.wiki/books/hardware/page/hadk-hot>): collect evidence before changing anything. `dmesg -w` live; boot with `audit=0` (kills audit spam) and `printk.devkmsg=on` (unthrottled userspace → kmsg — the stock bluejay cmdline already carries it); `journalctl -b-1` reads the previous boot once the persistent journal is enabled; logcat output differs run as root vs user.

**The install/boot model these stages assume:** `fastboot flash vbmeta --disable-verity --disable-verification`, our `boot.img` (and `init_boot.img` on A13-launch devices), stock `vendor_boot`/`vendor`/`super` untouched, `rootfs.img` + `android-rootfs.img` (the Halium GSI system image) as files inside an unencrypted ext4 `userdata`. The LuneOS initramfs loop-mounts `rootfs.img` as `/`, and the Android container mounts the GSI at `/android` with the device's real `/vendor` bound in.

---

## Stage 0 — Does the kernel even boot?

Nothing on the screen, no adb, device reboots or sits dead. Two tools before anything else:

### Ramoops / pstore console

On a kernel panic the console log survives the reboot in pstore. This is how the bluejay MCT clock panic was diagnosed — the whole `deferred probe timeout` wall and the final
`Kernel panic: exynos4_timer_resources: unable to determine tick clock rate`
were read from the ramoops console dump after the device rebooted. If the device panics and resets, pull the pstore console before touching anything else.

### The debug boot image (`fastboot boot`, no flashing)

Every device kit ships a `boot-<device>-luneos-debug.img`: the same kernel + initramfs with `enable_adb` on the cmdline. `fastboot boot` runs it without flashing (on Pixels this works even for images that would normally live in `init_boot` — the debug image is deliberately self-contained, kernel + ramdisk in one image). With `enable_adb`, init panics into the initramfs adbd debug shell: the device enumerates as a USB gadget named **"Halium initrd — Failed to boot"**. Then:

```
adb shell
cat /dev/kmsg        # live kernel log, includes every initramfs message
```

The same shell appears automatically (without the debug image) when the initramfs itself fails to boot — e.g. `rootfs.img` not found on userdata. If you get the gadget, the kernel and initramfs core are fine; read kmsg to see where boot stopped.

### The telnet / USB-networking ladder (UBports/Halium, SFOS hybris-boot)

The Halium-family initramfs also exposes a telnet path that works when adb doesn't, and the USB gadget itself tells you how far boot got. (UBports: <https://docs.halium.org/en/latest/porting/debug-build/early-init.html>, <https://docs.ubports.com/en/latest/porting/build_and_boot/Boot_debug.html>; SFOS: <https://github.com/mer-hybris/hybris-boot>)

- **Watch the boot stage from the host** via the gadget's iSerial string:

  ```
  while : ; do lsusb -v 2>/dev/null | grep -Ee 'iSerial +[0-9]+ +[^ ]' ; done | uniq
  ```

  The stages announce themselves: `"Mer Debug setting up (DONE_SWITCH=no)"` → `"Mer Debug telnet on port 23 on usb0 192.168.2.15"` (boot failed in the initrd) or `"GNU/Linux device on rndis0 10.15.19.82"` (booted).
- **Initramfs failure → telnet:** `telnet 192.168.2.15` (**port 23** = still in the initrd, pre-switch_root; **port 2323** = post-switch_root debug in the hybris-boot scheme). Host side: configure yourself as `192.168.2.1`, and give the interface a MAC if it shows `00:00:00:00:00:00`. First commands: `cat diagnosis.log` (the initramfs writes its failure reason there) and check `/init.log`.
- **Reading the silence:** no USB device at all = the kernel or initramfs never ran (unpack and inspect the flashed image); port 23 answering = kernel + initrd fine, the rootfs transition failed.
- **Halt boot deliberately:** hybris-boot honours marker files (`init_enter_debug` before switch_root, `init_enter_debug2` after) and `fastboot boot boot.img -c bootmode=debug`; the UBports recovery flow waits with a shell until `echo continue > /init-ctl/stdin`. These are the telnet-world analogs of our `enable_adb` debug image.

**The LuneOS initramfs now has this too (2026-09-06).** The panic/debug path in `initramfs-scripts-halium` `init.sh` (meta-smartphone/meta-android) starts `telnetd` at **`192.168.2.15` port 23** alongside the adbd gadget, with `udhcpd` serving the host `192.168.2.20–90` so no host-side configuration is needed, and announces itself in the gadget's iSerial string (`LuneOS initrd telnet 192.168.2.15: <reason>`). The gadget network function is auto-selected per kernel: it tries `rndis.usb0` and `ecm.usb0` and links whichever the kernel supports — **stock GKI 6.1 (bluejay/panther) ships ECM only, MTK 4.14 (mindphone) RNDIS only, athena's 4.19 (SDM660) RNDIS only**. Fixed gadget MACs (`FA:75:7F:BB:F4:E6`/`:E7`, first byte even) avoid the all-zeros-MAC refusal and give the host a stable connection. One caveat: ECM has no native Windows driver, so on GKI Pixels use a Linux or macOS host (or adb, which still works — both channels come up together). All tools are busybox applets already in the initramfs (`FEATURE_TELNETD_STANDALONE`, `UDHCPD`, `ip`, `getty` verified in the shipped build). Two more channels ride along:

- **ACM serial console** — an `acm.usb0` gadget function with a shell on `/dev/ttyGS0`; on the host just `screen /dev/ttyACM0 115200`, no networking involved. `CONFIG_USB_CONFIGFS_ACM=y` in stock GKI 6.1 and mindphone's 4.14 (athena's defconfig lacks it — the function silently doesn't appear there).
- **netconsole (Tier B only)** — after the debug network is up, init attaches a dynamic netconsole target streaming kmsg to UDP broadcast port 6666; the host listens with `nc -ul 6666`, and the stream **survives switch_root into the full boot**. Right after attaching, init **replays the early printk buffer** into the stream (`dmesg` re-injected line-by-line into `/dev/kmsg`, prefixed `replay:`), so the host gets history from power-on — boot-param netconsole targets get this via `CON_PRINTBUFFER`, dynamic ones don't. The replay needs `printk.devkmsg=on` on the cmdline (athena's `ANDROID_BOOTIMG_CMDLINE` now carries it; stock bluejay already does). Requires `CONFIG_NETCONSOLE=y` + `CONFIG_NETCONSOLE_DYNAMIC=y`, now in the athena and mindphone fragments. **Do not add it to a Tier A GKI fragment: NETCONSOLE selects NETPOLL, which adds a field to `struct net_device` — KMI-poison of the SYSVIPC class.**

  **Cmdline netconsole (`netconsole=...@/usb0,...`) is mainline-only — and actively harmful on configfs-gadget devices.** Verified in the athena 4.19 source: `netpoll_setup()` aborts with `-ENODEV` when the target interface doesn't exist at init, and `init_netconsole()` then unwinds *everything* — including the dynamic configfs interface — so a cmdline entry naming a not-yet-existing `usb0` silently kills dynamic netconsole too. Tenderloin can use it (`netconsole=6665@172.16.42.2/usb0,6666@172.16.42.1/` in `CONFIG_CMDLINE`, webOS-heritage `172.16.42.x` addressing) only because its mainline kernel sets `CONFIG_USB_ETH=y` — the built-in `g_ether` gadget creates `usb0` before userspace. Enabling `g_ether` on an Android-style kernel would claim the UDC and cost the configfs gadget (adb + everything else) — not worth it. Note also: athena has **no pstore/ramoops at all** (nothing in the defconfig, no DT node), so a panic before the initramfs is currently invisible there; a ramoops DT node + `PSTORE_RAM` would be the fix but needs a carefully chosen reserved-memory region.

### RNDIS + SSH — a debug channel that survives past the initramfs (Droidian)

Our `enable_adb` shell ends when the initramfs hands over; Droidian's primary channel is RNDIS + SSH into the booted (or half-booted) rootfs (<https://docs.droidian.org/porting-guide/debugging-tips/>):

- Kernel needs `CONFIG_USB_CONFIGFS_RNDIS=y`. Their symptom mapping: "stuck at the glowing logo and RNDIS is not working → check CONFIG_USB_CONFIGFS_RNDIS".
- Device comes up at `10.15.19.82`; host takes `10.15.19.100/24`, then `ssh <user>@10.15.19.82`. "Nothing on screen ≠ boot failure" — remote access determines actual status.
- Forward internet from the host over the USB link:

  ```sh
  sudo sysctl net.ipv4.ip_forward=1
  sudo iptables -t nat -A POSTROUTING -o $INTERNET -j MASQUERADE
  sudo iptables -A FORWARD -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
  sudo iptables -A FORWARD -i $USB -o $INTERNET -j ACCEPT
  # on device:  ip route add default via 10.15.19.100 ; nameserver 8.8.8.8
  ```

- UBports adds an emergency mechanism worth stealing: flag files `/userdata/.force-ssh` and `/userdata/.force-adb` enable SSH/ADB at boot regardless of config (<https://docs.ubports.com/en/latest/porting/configure_test_fix/USBModed.html>) — a flag file on userdata is writable from recovery or fastboot when nothing else is.

---

## Stage 1 — Initramfs failures

Known failure classes, all hit on hardware:

### 1.1 Module load order — `modules.load` is NOT dependency-ordered

On GKI devices the vendor's early modules (from the `vendor_boot` DLKM fragment or `vendor_kernel_boot`) land in `lib/modules` of the merged initramfs, and our init must load them — the stock LuneOS initramfs loads no early modules at all (fine on sargo where storage is built-in, fatal on GKI devices where even UFS is a module).

**Never assume `modules.load` order is topological.** It is a list, not an order: stock init feeds it to libmodprobe, which resolves `modules.dep` per entry. Measured with `tools/module-order.py`: bluejay has **335 hard-dependency pairs listed backwards** across 99 of 203 modules; panther 332 across 107 of 204. On bluejay, `clk_exynos_gs.ko` sits at line 15 while its symbol exporter `cmupmucal.ko` sits at line 45 — one-pass insmod-in-list-order left the clock driver unloaded, so no clocks → power domains deferred → `deferred probe timeout` wall → MCT timer panic at 11.5 s.

Fix history, worth knowing because the intermediate fix was a trap:
- **v2 (fixpoint loader):** repeated insmod passes until a pass makes no progress. Worked (88/203, 37/115, 26/78 per pass) but treats a symptom — and **`softdep pre:` edges are invisible to a retry loop** (insmod of the dependent *succeeds*, it just probes in the wrong order; `exynos-drm` after `phy-exynos-mipi` and `exynos_pd` after `clk_exynos_gs` are in that set, i.e. display and power-domain ordering).
- **v4 (shipped):** resolve the order up front the way modprobe does, in ~40 lines of busybox awk over `modules.dep` (each line holds the module's full dependency closure, deepest last — emit the line reversed, then `softdep pre:` entries, then the module). Fixpoint loop kept behind it as a safety net for deps that ship in `vendor_dlkm` (loaded later). This lives in `initramfs-scripts-halium` `init.sh` now.
- **Diagnostic lesson:** the original init silenced insmod errors with `2>/dev/null`, which hid the `Unknown symbol cal_clk_* (err -2)` failures completely. Log per-pass progress to kmsg and print a WARNING naming any module that never loaded.

Check any device's module set host-side, no hardware needed:

```
python3 gsigki/tools/module-order.py <lib/modules dir>
```

### 1.2 Module cmdline parameters — the kernel does not pass them to loadable modules

Second bluejay panic, at 2.3 s: `ufs-pixel-fips140: Invalid module params: first_lba=0 last_lba=0` → `Kernel panic: FMP self test failed` (the driver hard-fails when its LBA params are unset).

Root cause: **`module.param=` cmdline options only apply to built-ins.** modprobe/libmodprobe parse `/proc/cmdline` and pass them at load time; plain `insmod` does not. The device cmdline carries `ufs_pixel_fips140.fips_first_lba=30086` etc. (and `exynos_drm.panel_name=…`, which the display needs later).

Fix (init v3, shipped in v4): `module_cmdline_args()` collects matching `<module>.*=` tokens from `/proc/cmdline` for each module and passes them to insmod, **treating `-` and `_` as equivalent in the module name** (modprobe semantics — the file is `ufs-pixel-fips140.ko`, the cmdline says `ufs_pixel_fips140.`).

### 1.3 Async storage probe — poll for userdata

UFS (`ufs-exynos-gs.ko`) probes asynchronously, and `mountroot` has no retry — if storage is late it panics straight to the adb shell. The init patch polls sysfs `PARTNAME` for `userdata*` up to 10 s after module load before proceeding.

### 1.4 userdata never grows on UFS devices

`resize_userdata_if_needed()` in `halium-boot.sh` computed the partition size with a `case $path in /dev/mmcblk*) … /dev/disk*) …` over `/proc/partitions` — but `mountroot` sets `path=$(readlink -f $part)`, which on UFS resolves to **`/dev/sd*`**: neither case matches, the size stays empty, and the filesystem is silently left at its image size. Harmless if you `fastboot format:ext4 userdata` and push files; **fatal to the shipped-userdata-image flow**, which relies on a ~3.6 GB image growing to the ~100 GB partition. Fixed generically: read `/sys/class/block/<dev>/size` (512-byte sectors, present for every block device including partitions), keep the old greps as fallback, warn to kmsg if neither yields a size.

### 1.5 Missing tools, file layout, hotplug

- The initramfs lacked `udevadm` and `dumpe2fs` (`halium-boot.sh` calls both). Boot survives, but settle is skipped and the resize check degrades — add them to `initramfs-android-image`.
- **`android-rootfs.img` must sit NEXT TO `rootfs.img` on userdata** (halium file layout) — not only inside the rootfs. The name matters: `halium-boot.sh` checks `/tmpmnt/android-rootfs.img`. Also note `0001-halium-find-the-Android-image-instead-of-assuming-whe.patch` fixes the "userdata image with only rootfs.img in it does not boot" case.
- mdev hotplug writes `/sys/kernel/uevent_helper`, which needs `CONFIG_UEVENT_HELPER=y` — not in stock GKI configs. Without it, late hotplug events are lost; if by-partlabel links come up empty, this is why. (Added to the LuneOS kernel fragment; KMI-safe.)
- Old forked `machine.conf` files with hardcoded `mmcblk0p*` partition numbers: the modern initramfs discovers partitions by name — stale copy-pasted numbers are mostly harmless (panic path only) but should be deleted.

### 1.6 Cmdline-level fixes (Droidian porting guide)

Three documented failure → cmdline fixes (<https://docs.droidian.org/porting-guide/debugging-tips/>):

| Symptom | Fix |
|---|---|
| Device reboots immediately after flashing boot | remove a stale `systempart=` from the cmdline |
| Initramfs stuck / can't find data | add `datapart=/dev/disk/by-partlabel/userdata` |
| Initramfs refuses to exec `/init` | replace `console=ttyMSM0,115200n8` with `console=tty0` |

The `console=` one is worth remembering: a serial console on a dead UART can hang init's stdio — Droidian appends `console=tty0` as standard practice.

### 1.7 The `skip_initramfs` trap — your init never ran at all (SFOS hadk-hot)

On many Android 8–10 vendor kernels the bootloader passes `skip_initramfs` for normal boot and the kernel **bypasses the packed ramdisk entirely** — a repacked boot.img flashes fine but your init simply never executes (no gadget, no logs, stock-looking behaviour). Fix is in kernel source: revert the "Add skip_initramfs command line option" patches or force `do_skip_initramfs = 0` (details belong to the Tier B kernel work; <https://sailfishos.wiki/books/hardware/page/hadk-hot>). We have not hit this yet (mindphone is A11), but it is the first suspect when a Tier B device ignores a repacked ramdisk.

### 1.8 Recovery as a debug environment (Droidian)

On devices with TWRP/recovery, the shipped rootfs can be inspected and repaired without booting it (<https://docs.droidian.org/porting-guide/debugging-tips/>):

```sh
mkdir /tmp/mpoint
mount /data/rootfs.img /tmp/mpoint
chroot /tmp/mpoint /bin/bash
export PATH=/usr/bin:/usr/sbin
```

Grow it offline with `e2fsck -fy /data/rootfs.img && resize2fs -f /data/rootfs.img 8G` (complementary to the first-boot `resize_userdata_if_needed`). Recovery is also where you read `/sys/fs/pstore/` after a panic and mask broken systemd units before the next boot attempt.

---

## Stage 2 — Android container failures

The rootfs is up, systemd runs, but HALs / display / radio are dead. This stage has the deepest traps.

### 2.1 Init "stuck" vs "curtailed" — always look for `wait_for_prop` first

Halium patches Android init so the framework never starts, and `on nonencrypted` is dead on a GSI (no fstab → `mount_all` never runs). It is tempting to conclude init stopping after `post-fs-data` is by design. **It usually isn't — look for a `wait_for_prop` gate before concluding anything.**

On sargo, `init.<board>.rc` gates `post-fs-data` on `wait_for_prop vendor.qcom.time.set true`; that property is set by Android's `time_daemon`, which Halium doesn't run. `wait_for_prop` blocks init's state machine outright — everything after it (`early-boot`, `boot`, every `class_start`, every `chown`/`chmod` the vendor HALs depend on) is simply never reached. Setting that **one property** on a running device brought up the whole modem subsystem (`per_mgr`, `per_proxy`, `pd_mapper`, `qcrild`), fixed the vibrator restart loop, zeroed the sensors' QMI errors, and cut EACCES failures in a boot from 50 to 1.

The shipped mechanism (`start-android-hals.sh`) generalizes this: parse every `wait_for_prop` out of the container's rc files, grant a grace period, then force only the stragglers — and keep a `class_start`/`chown` replay as a safety net.

Cross-reference: SFOS hits the same time_daemon conflict and mitigates from the other end — disabling `time_daemon`/`vendor.time_daemon` outright via a `disabled_services.rc` dropped into the container's init dirs (stops "RTC initialization failed" loops). A port seeing time_daemon crash-loop should know both mitigations. (<https://sailfishos.wiki/books/hardware/page/hadk-hot>)

### 2.2 The quoted-property trap

mt6739's vendor rc writes `wait_for_prop hwservicemanager.ready "true"` — **with quotes**, which init's own parser strips. `start-android-hals.sh` harvested gates with awk, which kept the quotes, so the gate never looked satisfied, and after the grace period the script "forced" the literal value `"true"` (quotes included) over the correct one — **wedging every libhidl `WaitForProperty`, i.e. every HIDL `getService`, on host and container**. This was the one true root cause under the mindphone boot-splash hang, hiding beneath several real-but-secondary bugs. Fixed with a gsub in the awk. sargo never triggered it (its vendor gates carry no quotes) — a reminder that "works on device A" proves nothing about the parser.

### 2.3 Container init dies with no trace — the logging black hole

Inside the LXC container, init often has no usable `/dev/kmsg` (the host owns `/dev`; first stage's mknod can fail), so KernelLogger discards every line. Worse, init is built with `REBOOT_BOOTLOADER_ON_PANIC`, so a fatal signal becomes a handled `reboot()` — the kernel records nothing — and a pid namespace delivers that as SIGHUP. All the container manager can say is:

```
Child <pid> ended on signal Hangup(1)
```

Two init patches (in `gsigki/halium16-init-logging-patches/`) close the hole:
1. **Tee every log line to `/dev/socket/init.log`** — the container config bind-mounts `/dev/socket` from the host, so the log outlives the container and is readable from outside after init is gone.
2. **Breadcrumbs before `InitKernelLogging`** — two plain `write()` markers at `FirstStageMain` entry and after the `/dev` setup block, so a death in that window is distinguishable from init never having been exec'd. No-ops outside a Halium container.

This is how the Android 16 GSI's PropertyInit failure was found: the tee captured init's `InitFatalReboot` backtrace naming `prop_area::map_prop_area_rw` — the host's **4M `/dev` tmpfs running out of pages** while mapping one 128K `prop_area` per SELinux property context, of which a 16 GSI has ~557.

### 2.4 Read the container's logcat, not just journalctl

The `/dev/ashmem` case: system booted to `systemctl is-system-running = running`, **0 failed units**, 32 audio sinks, working nyx/ofono — and sat on the bootloader splash forever. Nothing in journalctl. The evidence was **only in the container's logcat**: from Android 12, libcutils opens `/dev/ashmem<boot_id>`, not `/dev/ashmem`; the container's init creates that node inside the container, but hybris runs on the host — every `ashmem_create_region()` failed, so libfmq couldn't allocate, so the HIDL composer's command queue was never created and the compositor sent no display commands at all. Fix: create `/dev/ashmem<boot_id>` on the host (`mount-android.sh`). When the host side looks perfect, go read logcat.

### 2.5 Other container-side failure modes (all real)

| Failure | Cause / fix |
|---|---|
| vndservicemanager aborted, every vendor HAL blocks on `/dev/vndbinder` | A stock vendor's vndservicemanager aborts without selinuxfs — preload `libselinux_stubs` into vndservicemanager (halium device-tree patch; on 32-bit the GSI preloaded it from a hardcoded `/system/lib64/` path and died — fixed in `device/halium/halium_arm`) |
| Boot queue hangs on one bad HAL | `lshal` hangs forever on an unresponsive HAL — `luneos-device-config` runs lshal under a per-call watchdog |
| Dynamic-partition mounts racy/missing nodes | dmsetup/udev race — run `dmsetup mknodes` in `mount-android.sh` |
| Binder calls fail on host | Host needs `/dev/{binder,hwbinder,vndbinder}` symlinks into binderfs |
| `.capex` APEXes silently skipped (conscrypt, media) on a 16 GSI | `mount-apexes.py` cannot mount compressed APEXes — build the GSI with `PRODUCT_COMPRESSED_APEX := false` |
| `/init` aborts instantly on an old (4.9) kernel | `MADV_WIPEONFORK` needs Linux ≥ 4.14 — hybris-patches makes it non-fatal |
| getprop/setprop TLS abort on Android 16 GSI | Needs the Android 16 libhybris adaptation (`Herrie82/libhybris` `herrie/android16-tls`) |
| GPU driver not found | `/vendor/lib{,64}/egl` must be on the linker's default LD paths (same libhybris branch) |
| Container "service not found" for zygote/netd/update_verifier | By design — the Halium GSI strips them. Not a bug. |
| "add_service Permission denied" / "Unknown class service_manager" | SELinux-family (SFOS hadk-hot): the selinux config files must be real files, **not symlinks**; "Unknown class" in permissive mode wants stub services. Check what the base expects first — dmesg shows `SELinux: Disabled at boot` (hybris ≤16) vs `SELinux: Initializing` (≥17) |
| `libandroidicu.so not found` (and libicui18n/libicuuc) | Straggler libs live in the runtime APEX — symlink them in, e.g. `/odm/lib64/libandroidicu.so → /apex/com.android.runtime/lib64/…` (SFOS hadk-hot) |
| apexd/loop-device failures | `loop.max_part=7` on the cmdline, loop block-size patch, or the "linkerconfig: switch no-updatable-apex" hybris-patch; also check `/proc/device-tree/firmware/android/fstab/` for partitions the DT expects early-mounted (SFOS hadk-hot) |
| Early crash-loop on Exynos 9810/9820 | `systemd-journald` crashes the device — mask it (from recovery if needed). On kernels with broken namespace support, mask `systemd-resolved` and `systemd-timesyncd` too (Droidian) |

### 2.6 Working the container by hand (UBports/Halium, Droidian, SFOS)

- `lxc-checkconfig` — one-shot check that the running kernel has every namespace/cgroup option LXC needs (everything except User namespace should be enabled). `lxc-ls --fancy` shows container state at a glance.
- When `android-system` fails silently, start the container manually with full logging: `lxc-start -n android --logfile=/tmp/lxclog --logpriority=DEBUG`. To debug the host side alone, temporarily neuter the container: override the service with `ExecStart=/bin/true`. (<https://docs.droidian.org/porting-guide/debugging-tips/>)
- Get logs from inside: `lxc-attach -n android -- /system/bin/logcat` (and `logcat -b radio` for RIL).
- **The container's init cannot be started twice** (SFOS hadk-hot): a second start fails on leftover state, not on the original bug — so a restart-looping container init is a misleading symptom; find the *first* failure. And logcat only exists once Android init is up — absence of logcat ≠ broken logging.
- **strace a proprietary vendor daemon** by editing its rc service line (works in the LXC container too): `mkdir -m777 /data/strace`, then `service tad /usr/bin/strace -ff -o /data/strace/tad.strace /vendor/bin/tad …`. Often the only window into a closed daemon. (SFOS hadk-hot)

---

## Stage 3 — Display and UI

First, distinguish the two black-screen shapes:
- **Stuck on the bootloader splash** with a healthy system underneath → compositor never sent display commands; think ashmem/composer (§2.4), or init gates (§2.1).
- **Screen dark but everything runs** → check the backlight before anything else: on mindphone nothing drives `/sys/class/leds/lcd-backlight` and the panel boots at brightness 0. `echo 200 >` it from a compositor drop-in as a bring-up hack; the real fix belongs in the display service. Qualcomm gotcha (Droidian): many QC panels take a max of **2047**, not 255 — a "correct-looking" low absolute value can still leave the panel visually dark.

### The display smoke-test ladder (SFOS HADK/hadk-hot)

When the compositor shows nothing, don't debug it top-down — isolate layers bottom-up with the libhybris test binaries, compositor masked first (SFOS masks `user@100000`; LuneOS analog: stop/mask luna-surfacemanager). (<https://github.com/mer-hybris/hadk-faq>, <https://sailfishos.wiki/books/hardware/page/hadk-hot>)

1. `EGL_PLATFORM=hwcomposer test_hwcomposer` (as root). Success = a spinning colored rectangle: EGL + gralloc + composer blobs work under the hybris linker. Segfault → `EGL_PLATFORM=hwcomposer strace test_hwcomposer`, or `gdb test_hwcomposer` → `run` → `bt full`. Runs-but-black → suspect the gralloc/copybit module.
2. "minimer": `EGL_PLATFORM=hwcomposer qmlscene -platform hwcomposer main.qml` — adds the Qt QPA hwcomposer plugin on top (LuneOS analog: qt6 qmlscene with qt6-qpa-hwcomposer-plugin). Tuning when it misbehaves: `QPA_HWC_IDLE_TIME=5`, `QPA_HWC_BUFFER_COUNT=3`; black backgrounds/images inside otherwise-working apps → `QT_OPENGL_NO_BGRA=1`.
3. Only then the full compositor.

**surfaceflinger as a bisect oracle:** run the Android stack's *own* compositor from the container/GSI — `/system/bin/surfaceflinger` (Android 11+: also `ANDROID_ROOT="/system" /system/bin/bootanimation`). If it renders, kernel + vendor blobs + gralloc/composer are proven good and the fault is in the hybris/QPA layer; if it doesn't, stop debugging libhybris and fix the Android side first.

Other verified display/UI failure modes:

| Symptom | Cause / fix |
|---|---|
| Compositor blocks forever before starting | `product.env` DRM probe loops forever on DRM-less devices — guard the probe (needs a luna-surfacemanager patch) |
| Wrong/unknown panel geometry | Fallback must read `/sys/class/graphics/fb0/modes` — **NOT `mode`**, which empties once the compositor owns the panel. (mindphone's machine conf claimed 1080x2340; the real panel is 480x800@~187ppi — never trust copy-pasted display constants) |
| Every `eglCreateContext` → `EGL_BAD_ALLOC`, webapps never render | GPU node permissions: `/dev/pvr_sync` and `/dev/ion` needed 0666 (the vendor's own ueventd.rc values) for the WAM user — ship a udev rule |
| QML apps die with "Failed to create wl_display"; webapp-mgr/maliit can't reach wayland | XDG_RUNTIME_DIR mismatch: compositor keeps its socket in `/tmp/luna-session` (surface-manager.env) while apps inherit `/tmp/xdg` from DefaultEnvironment — and `/tmp/xdg` is pulseaudio's dir (different perm domain, can't merge). Durable fix: a tiny always-on watcher `wayland-xdg-link.service` (Type=simple, Restart=always) re-linking `/tmp/xdg/wayland-0 → /tmp/luna-session/wayland-0` every 2 s. **Not** a systemd .path unit — PathExists stays true, a oneshot loops into its start limit |
| Compositor races the vendor HAL at boot | Don't sleep — wait for `IComposer` to actually register on hwbinder. (Even Droidian ships an `ExecStartPre=sleep 5` drop-in for Phosh here; the wait-for-registration pattern is strictly better) |

---

## Stage 4 — Subsystems (wifi, modem, BT, misc)

### First question for any subsystem: is the HAL registered at all?

Before debugging ofono/sensorfw/bluebinder configuration, verify the vendor HAL is actually up on the binder bus — LuneOS ships libgbinder, so `binder-list` is available (SFOS hadk-hot, <https://github.com/mer-hybris/libgbinder>):

```
binder-list -d /dev/hwbinder | grep IRadio      # modem
binder-list -d /dev/hwbinder | grep ISensors    # sensors
```

If the interface is absent, the middleware config is irrelevant — go back to Stage 2 (the HAL never started). If `binder-list -d /dev/binder` shows **nothing at all**, the gbinder **API level** may be wrong for this Android base — set it in `/etc/gbinder.conf` (valid levels: see `gbinder_config.c` in mer-hybris/libgbinder). ofono-binder-plugin, bluebinder and sensorfw all sit on libgbinder, so a wrong API level breaks all of them at once.

libhybris also ships per-subsystem smoke binaries usable before any middleware exists: `test_egl`, `test_hwcomposer`, `test_vibrator`, `test_gps`, `test_audio` (`test_sensors` is legacy-HAL-era, Android ≤7 — use binder-list on binderized bases). Cheap first answer to "does the blob respond at all?" (SFOS hadk-faq)

### Wifi
- A `wifi-module-load.service` modprobing a module that doesn't exist on this device (copy-paste from another port) produces a 2 s restart loop — check whether the driver is built-in (`CONFIG_MTK_COMBO=y` on mindphone: no module to load).
- MTK combo (WMT) pattern: the real drivers are the **stock vendor modules** (`/vendor/lib/modules`: wmt_drv, wmt_chrdev_wifi, wlan_drv_gen2, bt_drv, gps_drv). Their CRCs disagree with a reconfigured kernel (module_layout) — `CONFIG_MODULE_FORCE_LOAD=y` + `modprobe --force` proved safe in practice. Set the firmware path (`firmware_class.path` → `/android/vendor/firmware`) before loading.
- The container's `wmt_loader` needs the MTK connectivity `/dev` nodes exposed to the container; then power-on is `echo 1 > /dev/wmtWifi` **retried until wlan0 exists** (the container wmt daemons patch CONSYS firmware first).
- This is generalized in `meta-android/recipes-core/mtk-connectivity`: three condition-gated units keyed on `ConditionPathExists |wmt_drv.ko |conninfra.ko`, driven by the connectivity subset of the vendor's `modules.load` (grep `wmt|wlan|conn|bt_drv|gps|fmradio`) — no hardcoded module list, inert on non-MTK.
- Module-load error decoding (Halium docs, <https://docs.halium.org/en/latest/porting/debug-build/wifi.html>): `"Required key not found"` = module signature enforcement — disable `CONFIG_MODULE_SIG*` (Tier B only; stock GKI leaves MODULE_SIG_FORCE unset anyway, per bluejay). `"Invalid module format"` = kernel/module version-config mismatch — the non-GKI cousin of our CRC story. Broadcom `bcmdhd` is best built `=m`, not `=y` — as a module it picks up the device MAC address; built-in it doesn't. Legacy Qualcomm (pre-2016 SoCs): `echo 1 > /dev/wcnss_wlan`, `echo sta > /sys/module/wlan/parameters/fwpath`.

### Modem
- mindphone: `md1.status = "exception"`, RIL daemon stopped. Root cause was **fstab selection**: `mount-android.sh` picked `fstab.enableswap` (sorts before `fstab.mt6739` under the glob), so the modem NV partitions (nvcfg/nvdata/protect1/protect2 — MTK calibration + IMEI) never mounted. Fix: prefer `fstab.$(getprop ro.hardware)`, skip `*.enableswap`. Generic to any multi-fstab MTK device. After the fix: `md1.status=ready`, IRadio em1/em2 registered, ofono `/ril_0` + `/ril_1` both Powered (dual-SIM).
- MTK exposes NV partitions under `/dev/disk/by-partlabel` only (no by-name) — `find_partition_path` must cover that.
- The Qualcomm variant of the same disease (SFOS hadk-faq): the RIL stack needs the exact `/dev/block/bootdevice/by-name/` symlink structure Android has. Symptom is SIM never detected, in bad cases a bootloop. `ls -lR /dev/block` on Android (or in the container), replicate the structure via udev rules.

### Bluetooth
- Node ownership: the **vendor's** ueventd.rc says `/dev/stpbt` is `bluetooth:bluetooth`; the container's ueventd made it `system:system` → HAL can't open it. Chown in the container, then start the BT HAL (after android-system).
- BT MAC: `bluebinder_post.sh` knows no MTK source; the MAC lives in `/mnt/vendor/nvdata/APCFG/APRDEB/BT_Addr` (first 6 bytes) → write once to `/var/lib/bluetooth/board-address`.

### Misc
- Audio wrong rather than absent: pulseaudio-modules-droid has documented quirk arguments — pitched/tempo-shifted audio → `rate=48000` (or 44100); volume keys dead → `hw_volume=false`; crash or silence in voice calls → `use_legacy_stream_set_parameters=true`. Full table and the `audio.hidl_compat.default.so` binder workaround live in the hal-userspace topic. (UBports docs)
- Time-sync UI dead: LunaSysService calls `timedatectl`, which isn't installed until systemd-timedated ships.
- HW keypad ignored by Qt: udev tags it `ID_INPUT_KEY` only; Qt evdevkeyboard discovery needs `ID_INPUT_KEYBOARD` — promote with a udev rule.
- `library "libpq_cust.so" not found` from MTK HWC is benign — the vendor ships `libpq_cust_base.so` and the HAL falls back.

---

## Stage 5 — Idle health: the port "works" but burns CPU, flash or battery

A port that boots and runs can still be quietly wasteful. From the sargo/tissot idle triage (12 Sep 2026, `LuneOS/memoryusage/findings-2026-09-12.md`): both devices "healthy", yet four separate things were burning a core or flash for nothing. **Metrics to collect on any idle device:** per-process *cumulative* CPU vs uptime (`ps -o time` against `uptime` — a daemon that has used 2 h in 10 h is 20% of a core however calm it looks now), journal *and* container-logcat lines/s, GB/h whole-disk flash writes, `SUnreclaim` slope over **at least a day** (18 minutes cannot separate a slow leak from churn), and the suspend entry count (neither triage device had suspended once — check before trusting wake-from-suspend).

Four proven failure patterns, generalized:

1. **A bypassed vendor helper daemon busy-spins.** tissot's `wcnss_filter` sat at 96% of a core logging **~62,000 lines/s** (2.34 billion entries / 262 GB into the host log buffer since boot; `logd` burned another 36% of a core absorbing it). Cause: libbt-vendor `ctl.start`s the filter, but the BT HAL already holds the SMD channels — LuneOS reaches BT via bluebinder/vhci and never uses the filter — so its SoC open fails and `handle_soc_events()` spins on a dead fd. BT verified fully working without it. Fix shape: stop the daemon plus a periodic guard (it gets `ctl.start`ed again on some BT power-on paths — recipe `tissot-wcnss-filter-fixup`, 30 s guard). **Generic lesson: on any "working" port, sort processes by cumulative CPU and measure the container log rate** — a vendor helper made redundant by the LuneOS stack can burn a core silently. Related: restarting a vendor BT HAL requires restarting bluebinder too — it holds the HIDL binding and does not re-bind by itself.
2. **Zero-interval GTimerSource spin.** `sleepd` at 25% of a core, ~40,000 wakeups/s: a `GTimerSource` with `interval_ms == 0` expires the instant it is dispatched (prepare TRUE → check TRUE → callback → re-arm, never reaching poll). Two callers passed 0 to mean "fire now". Fixed in sleepd branch `herrie/fix-zero-interval-timer` (separate fire-now from repeat-every-0; floor intervals). Signature: a daemon pinned at a constant fraction of a core with an enormous wakeup count and no I/O.
3. **pulseaudio pinned by an uncorked stream.** `playbackState` says Stopped but the GStreamer pipeline is still PLAYING (the Qt 6 EOS bug — full story in device-sargo); `module-suspend-on-idle` cannot suspend a sink that has uncorked inputs, so the sink renders silence forever. Diagnose: `pactl list sink-inputs` showing `Corked: no` long after the sound ended; prove the cost with `pactl suspend-sink <sink> 1` and watch pulseaudio's CPU collapse.
4. **Kernel debug spam wears flash.** sargo's `qpnp_smb2` ships `debug_mask=31`, nearly doubling idle flash writes (0.19 vs 0.10 GB/h). Measure GB/h writes and kernel-journal lines/s at idle; silence via module parameters — a `tmpfiles.d` rule works, but **not via the device-config sparse overlay** (no ordering against `systemd-tmpfiles-setup.service`, the rule can arrive after tmpfiles already ran).

---

## Quick checklist: symptom → likely cause → where to look

| Symptom | Likely cause | Where to look |
|---|---|---|
| Device resets, nothing visible | Kernel panic | pstore/ramoops console dump |
| USB gadget "Halium initrd — Failed to boot" | initramfs couldn't finish (often rootfs.img not found) | `adb shell`, `cat /dev/kmsg` |
| `deferred probe timeout` wall, then timer/clock panic | Module load order — `modules.load` isn't topological | init v4 loader; `tools/module-order.py` |
| Driver panics on unset params (e.g. FMP self test) | `<module>.param=` cmdline not passed to insmod | init `module_cmdline_args()`; compare `/proc/cmdline` |
| Panics to adb only sometimes (storage race) | Async UFS probe, no mountroot retry | PARTNAME poll in init |
| First boot ok, disk full soon after | userdata never resized (`/dev/sd*` case miss) | `halium-boot.sh` resize; `/sys/class/block/<dev>/size` |
| Init "stops" after post-fs-data; HALs missing, EACCES everywhere | `wait_for_prop` gate blocking init's state machine | vendor rc files; `start-android-hals.sh` |
| Every HIDL getService blocks, host + container | Property gate forced with wrong literal (quoted-value trap) | gate values vs `getprop`; the awk harvest |
| "Child ended on signal Hangup(1)", container dead, no logs | Container init died pre-logging | `/dev/socket/init.log` tee + breadcrumb patches |
| 0 failed units, audio up, stuck on boot splash | Host-side ashmem → libfmq → composer queue | **container logcat**, `/dev/ashmem<boot_id>` on host |
| All vendor HALs block on vndbinder | vndservicemanager aborted (selinuxfs) | libselinux_stubs preload patch |
| Boot queue hangs at HAL enumeration | lshal hung on one HAL | per-call watchdog in luneos-device-config |
| Screen dark, system healthy | Backlight at 0 | `/sys/class/leds/lcd-backlight` |
| Compositor never starts on DRM-less device | DRM probe loop | product.env guard |
| Apps: "Failed to create wl_display" | XDG_RUNTIME_DIR split | wayland-0 symlink watcher |
| EGL_BAD_ALLOC everywhere | GPU node perms (ion/pvr_sync) | vendor ueventd.rc values → udev rule |
| Wifi service restart-looping | modprobing a nonexistent module | is the driver built-in? which modules does *this* vendor ship? |
| MTK modem "exception" | Wrong fstab chosen → NV partitions unmounted | `mount-android.sh` fstab selection |
| BT HAL can't open its node | Container ueventd ownership vs vendor ueventd.rc | chown in container |
| by-partlabel links empty | mdev hotplug needs CONFIG_UEVENT_HELPER | kernel fragment |
| No USB gadget at all after flash | Kernel/initramfs never ran | unpack + inspect the flashed image; §1.7 skip_initramfs on A8–A10 Tier B |
| Telnet port 23 answers | Kernel + initrd fine; rootfs transition failed | `cat diagnosis.log`, `/init.log` |
| Repacked image flashes fine, our init never executes (Tier B) | `skip_initramfs` honoured by the vendor kernel | §1.7; revert the skip_initramfs patches |
| Boot dies with a serial console on the cmdline | init's stdio hung on a dead UART | `console=tty0` (§1.6) |
| Container init restart-loops | Second start fails on leftover state — not the original bug | find the *first* failure (§2.6) |
| `add_service Permission denied` | selinux config files are symlinks, or stubs missing | §2.5 SELinux row |
| SIM never detected (Qualcomm) | `/dev/block/bootdevice/by-name` structure missing | replicate via udev (§ modem) |
| `Required key not found` on modprobe | Module signature enforcement (Tier B) | disable CONFIG_MODULE_SIG* |
| Audio pitched / tempo-shifted | pa-droid sample-rate quirk | `rate=48000` (hal-userspace) |
| test_hwcomposer segfaults | Blob/linker fault below the compositor | strace/gdb it; smoke-test ladder (§3) |
| test_hwcomposer runs but screen black | gralloc/copybit module | smoke-test ladder (§3) |
| Nothing from ofono/sensorfw despite config | HAL never registered, or wrong gbinder API level | `binder-list -d /dev/hwbinder`; `/etc/gbinder.conf` |
| Daemon at a fixed % of a core, ~40k wakeups/s, no I/O | Zero-interval GTimerSource re-arming instantly | Stage 5 §2; sleepd `herrie/fix-zero-interval-timer` |
| Vendor filter/helper at ~100% of a core, massive logcat rate | Daemon bypassed by the LuneOS stack spinning on a dead fd | Stage 5 §1; stop it + guard service |
| pulseaudio busy while silent; sink RUNNING forever | Uncorked stream (Qt EOS bug) | `pactl list sink-inputs`; Stage 5 §3, device-sargo |
| Idle flash writes high (GB/h at rest) | Kernel driver debug_mask / log spam | Stage 5 §4; module param via tmpfiles.d |
| Wifi/BT vendor modules never load on a rebuilt GKI kernel though kmi-crc-check passes | `CONFIG_MODULE_SIG_PROTECT` must be off | kernel-porting.md (bluejay 12 Sep) |
