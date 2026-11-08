# MediaTek SoCs: Facts Shared by Every MediaTek Port

What holds across the MediaTek ports (preloader and lk, mgk kernels, the connectivity combo, A12 vendor keys); device files keep their own values and link here.

Ports: mindphone (MT6739, 4.14, 32-bit), titanpocket (MT6771, 4.14), sm-t220 (MT8768T,
4.19), radon (MT6877, 4.19), q25 and mp01 (MT6789 / Helio G99, mgk android12-5.10), brax3
(MT6835 / Dimensity 6300, mgk android13-5.15). Generic method stays in the component topics
(boot-images.md, installing.md, kernel-porting.md, kmi-crc-matching.md, hal-userspace.md);
this file holds what is MediaTek-only.

## Boot chain: preloader and lk

- **Key combos.** BROM/preloader: hold **Volume Down** while plugging in USB, from power-off
  or through a forced restart (titanpocket, mp01, radon). A bootlooping device also
  presents its preloader on every cycle, which mtkclient catches. Fastboot entry varies
  per device (titanpocket: Volume Up while plugging in; mp01: Volume Up + Power;
  mindphone: Volume Down + Power or `adb reboot bootloader`).
- **Many lk builds have no `fastboot boot`** (q25, mp01, mindphone, titanpocket; brax3
  unmeasured). The debug image is then flashed, not RAM-booted, and the rootfs goes in as
  a prefilled `userdata` image (boot-images.md § Debug images).
- **A locked lk does not say it is locked**: it refuses critical partitions one by one with
  `FAILED (remote: 'No support by lock control')`. Check the lock state before flashing.
  If `flashing get_unlock_ability` is `false`, the unlock is refused too; that switch
  only exists inside booted Android (mp01, q25).
- **lk does not verify the boot header's SHA-1 `id` field** (radon); do not chase an `id`
  mismatch.
- **The `dtb` section is per lk**: an AOSP dt_table on mindphone, titanpocket and sm-t220,
  a bare FDT on radon (`mediatek/mt6877.dtb`). Copy the stock image's form
  (boot-images.md § Class 1 — legacy header v2).
- **What lk does with the header cmdline is per SoC**: the MT6789 lk drops the first 20
  characters (q25, mp01 pad the front with 20 `?`); MT6877 and MT6771 pass it through
  (radon, titanpocket); MT6835 is unmeasured (brax3 pads defensively). The table is in
  kernel-porting.md § The kernel command line. lk prints the cmdline it hands the kernel,
  so expdb confirms what arrived.
- **`os_version`**: mp01 (2099-12) and radon reproduce the stock value and never write a
  lower one; titanpocket ships a lower value than its stock image and lk boots it. The
  open question is in boot-images.md § Class 1 — legacy header v2.
- **AVB.** The stock vbmeta (SHA256_RSA2048, flags 0) chains `vbmeta_system` (location 2),
  `vbmeta_vendor` (4) and `boot` (3), and the stock boot.img carries its own `AVBf` footer
  (mindphone, titanpocket; q25 has vbmeta + vbmeta_system + vbmeta_vendor). A self-built
  boot image therefore needs a verification-disabled vbmeta; lk in orange state then logs
  `HASH_MISMATCH`, `img_auth_required = 0` and boots it (titanpocket). On mp01 lk exposes
  only the top-level vbmeta (`has-slot:vbmeta_system` is empty); disabling it disables the
  chain. An unsigned hash footer matching stock's shape: `ANDROID_BOOTIMG_AVB_PARTITION_SIZE`
  and meta-android `lib/halium/avb.py` (titanpocket).
- **Image size is a ceiling lk enforces silently.** Embedding all 180 vendor modules took
  mp01's boot image from 28 to 31.6 MB (ramdisk 6.6 → 14.8 MB) and lk stopped starting our
  init, with nothing in kmsg or expdb on six images; the constraint was the combined
  ramdisk (ours plus vendor_boot's 22.5 MB), not the 64 MiB partition. mindphone's image
  must stay ≤ 24 MB. Ship a minimal module set if one is needed (debugging.md § 1.8).
- **Ramdisk compression** matches vendor_boot's: LZ4 *legacy* on mp01 and brax3
  (`GKI_RAMDISK_COMPRESSION = "lz4-legacy"`; debugging.md § 1.10).
- **Never truly off.** A MediaTek device auto-boots on USB power and does not power off
  with a long press while USB is connected (mp01); with a cable attached it boots with
  `androidboot.bootreason=usb` into charger mode (§ Display).
- **Slots.** `fastboot getvar current-slot` right after `--set-active` can report the old
  slot; a slot that failed to boot is marked `slot-unbootable` and lk silently falls back,
  and `--set-active` does not clear it (mp01). q25 and mp01 keep Android on slot A and put
  LuneOS on slot B; the general slot policy is in installing.md § Flash steps per layout
  class.
- **No by-name links**: MediaTek exposes partitions under `/dev/disk/by-partlabel` only
  (`ANDROID_BOARD_BOOTIMAGE_PARTITION = "/dev/disk/by-partlabel/boot_a"` on radon), and
  `find_partition_path` must cover that (debugging.md § Stage 4 — Subsystems).

## Install over BROM/preloader (SP Flash Tool, mtkclient)

Some MediaTek devices are flashed over the BROM/preloader link only — SP Flash Tool on
Windows, `mtkclient` on Linux — with no fastboot step and no `fastboot getvar` to
interrogate the device. Rules (found on radon, the FuriPhone FLX1s; see
device-radon.md):

- Write partitions **by name** (`mtk w <name> <file>`), never by offset (`wo`/`wf`): a
  wrong offset overwrites what follows, and on these SoCs that can include the
  preloader — the one genuinely hard-to-recover MediaTek brick.
- Partition sizes come from `mtk printgpt`; the active slot lives in `misc` and is
  unknowable from the host, so write both slots; unlock state is not exposed.
- **Read the vendor's own flash package before deciding a device needs no vbmeta** —
  a kernel package's "no vbmeta" setting says nothing about what the flash package
  writes.
- **Scatter-file sizes for the LAST partition are nominal** (`userdata` declared 3 GiB on
  MT6877 and MT6789 against far larger real partitions); treat a reported `userdata` at or
  below the nominal figure as suspect and ask, rather than refusing.
- **MTK lk does not verify the boot header's SHA-1 `id` field**; do not chase an `id`
  mismatch on a MediaTek device.
- `expdb` is the debugging channel when USB never comes up, readable over the same link
  (§ Debugging a mute device); save a baseline from a healthy phone first.
- When no factory image is published, back up `boot_a`/`boot_b` before flashing; that
  is the only cheap way back.

## Debugging a mute device

### `expdb` when there is no pstore and no gadget

MediaTek kernels frequently ship **no pstore console**, and if the USB controller is a vendor module (debugging.md § 1.8) there is no debug gadget either — a failing device can be completely mute, nothing on `lsusb` but the preloader flashing past on each reset. `expdb` is the way in: a partition holding preloader/lk logs, AP watchdog status and the kernel's `RAM_CONSOLE` (kmsg from before the reset), readable over the preloader connection that still enumerates (mtkclient usage: tools.md § mtkclient). On the MP01 it showed our init running and the debug shell coming up, then:

```
RAM_CONSOLE detect abnormal boot wdt_status:0x6, aee_exp_type:1
```

**Read `wdt_status`.** Non-zero means the hardware watchdog reset the SoC rather than the kernel panicking — a different problem (§ The hardware watchdog).

**expdb can come back empty where it matters.** lk may log `kedump add: SYS_PSTORE_RAW ... kedump mini done` on every reset while the kedump region reads back as zeros; lk's own log then shows only `lk boot reason = 4` (`androidboot.bootreason=kernel_panic`, `exp_type 0x2` = kernel exception) — *that* it panicked, not *why* (found on titanpocket; see device-titanpocket.md). Read DRAM instead.

### Read ramoops straight out of DRAM over the preloader

MediaTek lk passes ramoops on the command line (lk's log in expdb shows `ramoops.mem_address=… ramoops.mem_size=… ramoops.console_size=… ramoops.pmsg_size=…`), runs with `kedump: ddr reserve mode enabled`, and a panic reset is a *warm* reset — so DRAM still holds the dying kernel's log when the preloader comes past on the next loop, and mtkclient's DA can read it:

```
mtk da peek <mem_address> <mem_size> --filename pstore.bin    # from lk's ramoops.* cmdline
                                                                # (titanpocket: 0x54410000 0xe0000)
```

- the kernel needs `CONFIG_PSTORE_RAM=y` (stock MTK defconfigs have it);
- **catch the preloader while it is bootlooping.** Holding Power to switch off, or the Volume-Down BROM route from a powered-off phone, loses DRAM. Read DRAM first; do expdb and other partitions in a second session;
- the region is a set of `persistent_ram_buffer` zones, each starting with `DBGC` (0x43474244 LE), then `u32 start`, `u32 size` and a ring buffer. `start == size` means the zone never wrapped; otherwise `size` is the capacity and the oldest byte is at `start`. Look for the console zone and the pmsg zone (Android userspace logging); most others are empty dmesg-dump slots;
- `loglevel=` does not hide the panic: oops and panic lines are emitted at emergency level.

On the Titan Pocket this gave the whole answer after five flash rounds of initramfs instrumentation had shown nothing: a force-loaded `wlan_drv_gen3` crashing on a struct-layout mismatch 22 s into boot, with pmsg showing the container already up (see device-titanpocket.md; the rule is kmi-crc-matching.md § Force-loading prebuilt modules, and when it is safe). A staging-kit `dump-expdb.sh` that does DRAM first, then `mtk r expdb,cache`, and decodes everything is the convenient shape.

### The hardware watchdog

The preloader arms a **hardware watchdog** before handing off; stock Android's init feeds it, ours does not. `CONFIG_WATCHDOG_HANDLE_BOOT_ENABLED=y` makes the kernel watchdog core pet it until userspace takes over — but only once the driver is loaded, and on MediaTek `mtk_wdt.ko` is a vendor module. Until modules load nothing feeds it, and the SoC resets after ~20–30 s — happily killing a working debug shell (debugging.md § 1.9).

Later in boot the same watchdog shows up as a reset every ~90–120 s with **no panic and no oops**:

```
mtk-wdt 10007000.watchdog: Watchdog enabled (timeout=31 sec, nowayout=0)
[wdtk] kick watchdog
[wdtk] kick watchdog        <- then silence, and the journal simply ends
```

Tells: `wdt_status` non-zero in expdb; a suspiciously regular reset interval; `kick watchdog` intervals against the declared timeout. The journal's last timestamp is the last flush, not the reset.

**Disable it for a debug session** with the standard magic close, first thing every boot (it lasts one boot; verified on MT6789, where uptime went from resetting at ~90–104 s to climbing past 180 s):

```sh
printf 'V' > /dev/watchdog
```

This is MediaTek-specific in practice: on the Qualcomm and Tensor ports the watchdog driver (`msm_watchdog`/`qcom_wdt`) is built in. Check `CONFIG_<vendor>_WATCHDOG` in the stock config before assuming.

## Kernel

- **mgk is not ACK.** A GKI boot image and `android12-5.10` in the version string do not
  make an ACK build usable: on MT6789 an ACK kernel failed 344 of 344 stock modules,
  `module_layout` included, and q25/mp01/brax3 build the device's own mgk tree
  (kernel-porting.md § Step 1: Check that the stock kernel really is GKI).
- **Toolchain: Google clang r416183b** (12.0.5), the stock kernel's own, on q25, mp01,
  radon and sm-t220 (sunfish and bramble use it too), through `GKI_CLANG_DIR:<machine>`.
- **The KMI-poison list moves between MediaTek KMIs**: `CONFIG_USER_NS` on mgk
  android12-5.10 / MT6789 (q25, mp01); `CONFIG_SYSVIPC` on mgk android13-5.15 / MT6835,
  where `USER_NS` is clean and `NET_L3_MASTER_DEV` is `=y` in stock and must stay on
  (brax3). Bisect every new KMI (kmi-crc-matching.md § Poison options: per KMI, and drift
  is a max).
- **Vermagic** comes from a `vermagic.cfg` (`CONFIG_LOCALVERSION`, `LOCALVERSION_AUTO`
  off) plus an empty `.scmversion` (q25, mp01, brax3); the sublevel comes from the
  Makefile, so a vendor whose release differs only there takes `SUBLEVEL=` on the make
  line (brax3's iodéOS machine). The ramdisk's busybox `insmod` needs an exact match
  (debugging.md § 1.11).
- **BTF**: the MT6835 stock kernel has `DEBUG_INFO_BTF` on, and a host without `pahole`
  silently builds a kernel whose `struct module` differs (brax3; kmi-crc-matching.md
  § Step 5).
- **ThinLTO**: `KERNEL_LTO_THIN = "1"` took mp01's single-threaded full-LTO link from about
  20 minutes to 6m04s and is KMI-neutral (0/345 either way); q25 sets it too.
- **List-valued Kconfig.** `CONFIG_TOUCHSCREEN_MTK_TOUCH` and
  `CONFIG_CUSTOM_KERNEL_IMGSENSOR` name source subdirectories: `olddefconfig` can drop
  unknown symbols but not directories that do not exist (`No rule to make target
  .../focaltech_touch/Makefile`; mp01, radon).
- **Platform variables.** Mali's sibling Makefiles name `mali_mgm_$(MTK_PLATFORM_VERSION)`
  from an unexported variable; pass `MTK_PLATFORM_VERSION=mt6789` or the build produces
  `mali_mgm_.ko` (q25). On 4.19 the MT6877 shares the `mt6853` platform directory
  (`MTK_PLATFORM="mt6853"`, radon).
- **`cgroup_disable=net_prio`** breaks a boot- and shutdown-time deadlock wherever LXC +
  connman run on a MediaTek `ccmni` modem: `net_prio`'s `cgrp_css_online()` takes rtnl
  under cgroup_mutex while connmand holds rtnl waiting on an events work item whose
  kworkers wait on cgroup_mutex (measured on mp01; q25 carries it pre-emptively; see
  device-mp01.md § Kernel).
- **The watchdog driver is a module** (`mtk_wdt.ko`), unlike Qualcomm and Tensor (§ The
  hardware watchdog).
- **4.x BSPs force-load the connectivity modules** (§ Connectivity combo); that is only safe
  while every struct they touch keeps its stock layout, and titanpocket's `wlan_drv_gen3`
  panicked on a mismatch (kmi-crc-matching.md § Force-loading prebuilt modules, and when it
  is safe). `CONFIG_MTK_COMBO=y` builds the combo driver in instead (radon).
- **A 64-bit SoC can run a 32-bit kernel and userland** (`bootopt=64S3,32S1,32S1`,
  mindphone; kernel-porting.md § Identify the platform precisely first).

## Connectivity combo (WMT/connac)

The MTK WMT combo driver (wifi/BT/GPS/FM core) is not in the GPL kernel drop — only
built-in adapter shims. The real drivers are stock vendor modules
(`/vendor/lib/modules`: `wmt_drv`, `wmt_chrdev_wifi`, `wlan_drv_gen2`, `bt_drv`,
`gps_drv`) whose CRCs disagree with a reconfigured kernel (`module_layout`), so the kernel
fragment sets `CONFIG_MODULE_FORCE_LOAD=y` and they are force-loaded. That worked on
mindphone, and is only safe while every struct those modules touch keeps the stock layout
(kmi-crc-matching.md § Force-loading prebuilt modules, and when it is safe; the Titan Pocket counter-example is in device-titanpocket.md).
Set `firmware_class.path` to `/android/vendor/firmware` before loading, and stage the
modules in a private tree under `/run`, **not** `/lib/modules/$(uname -r)` — udev coldplug
autoloads from there and bootloops the device on the next boot.

The generic recipe **`meta-android/recipes-core/mtk-connectivity`** covers the whole
MediaTek family: three condition-gated systemd units + two helpers, shipped into every
halium rootfs via `android-system RDEPENDS += mtk-connectivity`, inert on non-MTK:

- `mtk-connectivity-modules.service` → `mtk-load-modules.sh`: force-load the
  connectivity modules in an order derived from the vendor, no hardcoded list. WMT era
  (mt6739, Android 11): the family is in `modules.load`, loaded in that order. connac era
  (mt6789, Android 12 GKI): only `connadp` and `c2k_usb_f_via_gps` are in `modules.load`;
  the drivers are `insmod`ed by the vendor rc files (`wmt_drv` + `connfem` `on boot`, the
  rest behind `vendor.connsys.driver.ready=yes`, property-templated file names), so the
  script reads those rc files and the vendor properties (device-q25.md).
- `mtk-connectivity-wifi.service`: retry `echo 1 > /dev/wmtWifi` until `wlan0` exists
  (the container's wmt daemons must patch the CONSYS firmware first).
- `mtk-connectivity-bt.service`: seeds the BT address and node ownership and starts the
  BT HAL (e.g. `android.hardware.bluetooth@1.0-service`, driven via bluebinder; hal-userspace.md § Bluetooth).

The container needs the MTK connectivity `/dev` nodes exposed: `wmt_loader` could not open
`/dev/wmtdetect` until they were.

**Gate the units on the character devices as well as on `.ko` files.** `CONFIG_MTK_COMBO=y`
(radon) compiles the combo driver in, so no `wmt_drv.ko` and no `/sys/module/wlan*` ever
exist and `.ko`-only units silently never run. The units OR together `.ko` globs (in
`vendor` and `vendor_dlkm`, e.g. `bt_drv*.ko` for the Q25's `bt_drv_connac1x.ko`) and
`ConditionPathExists=|/dev/stpbt`, `|/dev/conninfra_dev`, `|/dev/wmtWifi` (general rule:
debugging.md, "Never gate a unit on `/sys/module/<driver>`"). In built-in mode the driver
also waits for `CONNINFRA_IOCTL_DO_MODULE_INIT` before any sub-driver comes up.

**GKI-era MediaTek (MT6789):**

- **The modules live in `vendor_dlkm`, not `vendor`.** All three units' conditions
  only checked `/android/vendor/lib/modules`, so on the MP01 every unit was skipped
  with "no trigger condition checks were met". They now also check
  `/android/vendor_dlkm/lib/modules` (`meta-smartphone` `9d68df46`).
- **Load order matters: WiFi and BT modules loaded together in the wrong order
  corrupt the DMASHDL queues the two share** (`RST_FW_DL_FAIL` every ~6 s, forever).
  Follow the vendor's two-stage `init.*.rc` order (`wmt_drv` + `connfem` on boot,
  the rest on `vendor.connsys.driver.ready=yes`), never a generic dependency loader.
- **WiFi power-on races `wmt_launcher`.** `wlan_drv` powers the chip as soon as
  it loads; if `wmt_launcher` has not yet set up the host interface, power-on fails
  with `wmt_core_stp_init: no hif info!` (`-8`) and asserts a whole-chip reset.
  When the reset recovers, BT/WiFi/GPS all come up afterwards and WiFi works;
  when it does not, no `wlan0`. Proper fix (open): power WiFi only after
  `wmt_launcher`'s `WMT_open`.

**Bluetooth on the combo.**

- **Node ownership:** the vendor's ueventd.rc says `/dev/stpbt` is `bluetooth:bluetooth`;
  the container's ueventd made it `system:system`, so the HAL could not open it. Chown it
  inside the container, then start the BT HAL (after android-system).
- **BT address:** `bluebinder_post.sh` knows no MTK source; the MAC is the first 6 bytes of
  `/mnt/vendor/nvdata/APCFG/APRDEB/BT_Addr`, written once to
  `/var/lib/bluetooth/board-address` (`mtk-bt-address.sh`).
- **Feature over-reporting.** The MT6789 combo (q25, mp01) needs the Synchronization Train
  mask; radon does not carry it (copy it only if `hci0` fails with "Unknown HCI Command").
  mindphone's MT6739 answers every LE command but advertises none
  (`BLUEBINDER_LOCAL_COMMANDS_SET`, device-mindphone.md § Subsystem notes). The mechanism:
  hal-userspace.md § Bluetooth.

## Userspace and vendor keys

**MediaTek Android 12 vendor keys** (q25, mp01, radon; brax3's Android 16 vendor takes only
the first and the sample rate):

| Key | Why |
|---|---|
| `deviceinfo_force_hwc2="1"` | `ro.hardware.hwcomposer=mtk_common`; without it surface-manager fails to take DRM master for its whole 90 s start timeout (radon) |
| `deviceinfo_hardware_egl` | the vendor sets no `ro.hardware.egl` and ships several `libGLES_*`: `meow` on mp01 and radon, `mtk` on sm-t220 |
| `deviceinfo_hybris_prefer_vndk="1"` | vendor `libnvram.so` imports `android::base::Basename`, which the 16 GSI's libbase no longer exports; without it pulseaudio crashes (hal-userspace.md § Audio) |
| `deviceinfo_audio_sample_rate="48000"` | the DL paths run at 48 kHz (§ Audio) |

**`stp_dump`/`stp_dump3` busy-loops.** The connectivity core-dump collector, started by
`persist.vendor.connsys.coredump.mode`, spins on `pselect6()` for `/dev/stpwmt` with no
framework to receive a dump: 93% of a core on mp01 and sm-t220, ~11,500 calls/s on q25,
54,249 s of CPU in 54,653 s uptime on mindphone. Two fixes in use: a stubbed-services file
(mindphone, q25, mp01), or `deviceinfo_android_skip_services="stp_dump"` plus a `prop.halium`
with `persist.vendor.connsys.coredump.mode=0` bind-mounted over the GSI's empty one
(sm-t220, the mechanism FuriOS' adaptations use).

**`mtk-ril-watchdog`.** `vendor.ril-daemon-mtk` is `oneshot` + `disabled`, so telephony that
dies once stays dead; mindphone's `mtk-ril-watchdog` (meta-greentouch) restarts it, and q25
has the same pair (device-q25.md § Subsystem notes).

**NV partitions and the fstab.** The modem's calibration and IMEI live in the NV partitions
(`nvcfg`, `nvdata`, `protect1`, `protect2`); picking the wrong `fstab.*` leaves them
unmounted and the modem in "exception" (mindphone; debugging.md § Modem).

### Display

- **Writeback connectors.** MediaTek DRM reports its writeback endpoints as permanently
  connected; exclude `Writeback` as well as `Virtual` connectors, or the compositor picks
  `Writeback1`, hangs 90 s and restarts for ever (radon).
- **Charger-mode boots hold DRM master** (`bootreason=usb`, Android's `charger`; mp01):
  debugging.md § Stage 3 — Display and UI.
- `library "libpq_cust.so" not found` from the MTK HWC is benign.
- PowerVR (MT6739): `/dev/pvr_sync` and `/dev/ion` must be 0666 or every
  `eglCreateContext` in web apps returns `EGL_BAD_ALLOC` (mindphone).

### Audio

**MediaTek MT6789 audio:** the sound card only registers once `mtk-btcvsd`
(component `mtk-btcvsd-snd`) is loaded — without it `mt6789-mt6366` defers
forever (`snd_soc_register_card fail -517`); find such components with the deferred-card
method in debugging.md § Stage 4 — Subsystems (Audio). The DL paths run at 48 kHz
(`mtk_afe_fe_hw_params() ... rate 48000`); at pulseaudio's default 44.1 kHz the HAL
resamples and playback sounds slightly off → `deviceinfo_audio_sample_rate="48000"`.
`libsndcardparser.so not found` from the vendor `libtinycompress.so` is harmless noise.
The DT may describe second-source amplifier parts that are not fitted (`chip id check
fail`); see device-mp01.md. Pulseaudio's unit restarts five times within a second on a
crash and then gives up, taking `audiod` with it.

The MediaTek audio HAL needs `rlimit-rttime = -1` for PulseAudio on sm-t220 (a droid sink
write ran past `RLIMIT_RTTIME` and was SIGKILLed from interrupt context), and the
`audio_param` parser there corrupts its own path through an uncleared `malloc`
(device-sm-t220.md § Subsystem notes; hal-userspace.md § Vendor libraries that assume
Android's zeroed `malloc`).
