# Wi-Fi, Bluetooth, Modem and NFC

Bringing up and debugging the radios on a Halium vendor: Wi-Fi drivers and the regulatory db, bluebinder, ofono-binder-plugin and nfcd.

Every daemon here sits on libgbinder: if nothing answers, first check that the HAL is registered and that gbinder's `ApiLevel` matches the vendor (hal-userspace.md § Before blaming AIDL). SoC-specific radio stacks: soc-mediatek.md § Connectivity combo, soc-qualcomm.md § WCNSS.

## Wi-Fi

- A `wifi-module-load.service` modprobing a module that doesn't exist on this device (copy-paste from another port) restart-loops every 2 s — check whether the driver is built in (`CONFIG_MTK_COMBO=y`).
- MediaTek WMT combo: force-loaded stock vendor modules, firmware path, `/dev/wmtWifi` power-on — soc-mediatek.md § Connectivity combo. Force-loading is only safe with stock struct layouts (kmi-crc-matching.md § Force-loading prebuilt modules, and when it is safe).
- Module-load errors: `"Required key not found"` is signature enforcement (kernel-modules.md § Module signing), `"Invalid module format"` a version/config mismatch (Halium, <https://docs.halium.org/en/latest/porting/debug-build/wifi.html>). Broadcom `bcmdhd` is best `=m` (it picks up the MAC as a module). Legacy Qualcomm (pre-2016): `echo 1 > /dev/wcnss_wlan`, `echo sta > /sys/module/wlan/parameters/fwpath` (soc-qualcomm.md § WCNSS).

### Regulatory domain: `country 00` and no 5 GHz

Install **`wireless-regdb-static`** and the **`cfg80211-regdb-reload`** service (meta-luneos/recipes-connectivity, gated on the `wifi` MACHINE_FEATURE in `packagegroup-luneos-extended`). oe-core only wires `wireless-regdb` into `packagegroup-base-wifi` (`00c5a665b4`), which LuneOS images (built from `packagegroup-luneos-*`) never install, and connman does not reference it, so without these every phone sits in the world domain. That goes unnoticed because **country 00 is a fully usable 2.4 GHz radio**: channels 1–11 work and every 5 GHz band is passive-scan-only, so 5 GHz APs are simply never found.

```
country 00:
  (2402 - 2472 @ 40), (6, 20), (N/A)          <- no PASSIVE-SCAN, normal
  (5170 - 5250 @ 80), ... PASSIVE-SCAN
  (5250 - 5330 @ 80), ... DFS, PASSIVE-SCAN
  (5490 - 5730 @ 160), ... DFS, PASSIVE-SCAN
  (5735 - 5835 @ 80), ... PASSIVE-SCAN
```

**Shipping the file is only half the fix.** cfg80211 is built in, so it requests `regulatory.db` during its own initcalls, before any rootfs exists:

```
platform regulatory.0: Direct firmware load for regulatory.db failed, error -2
platform regulatory.0: Falling back to syfs fallback for: regulatory.db
ueventd: firmware: could not find firmware for regulatory.db
cfg80211: failed to load regulatory.db
```

On Halium the sysfs fallback is answered by the **container's ueventd**, which never searches the LuneOS root. The failure is then **latched** (`regdb_fw_cb()` sets `regdb = ERR_PTR(-ENODATA)`), so the db sits on disk unread and `iw reg set XX` returns 0 while changing nothing. Only `NL80211_CMD_RELOAD_REGDB` (`iw reg reload`) clears it:

```sh
iw reg get | head -1                     # "country 00" => broken
ls -l /lib/firmware/regulatory.db        # missing => package not installed
journalctl -k -b | grep -iE "regulatory|regdb"
iw reg reload && iw reg set NL && iw reg get | head -1
```

Old kernels: upstream signs the db with the **wens** key since 2023, and `CONFIG_CFG80211_USE_KERNEL_REGDB_KEYS=y` trusts only `net/wireless/certs/*.hex` — check `wens.hex` is there (FuriLabs' 4.19 has both wens and sforshee).

### Never gate a unit on `/sys/module/<driver>`

A built-in driver has **no `/sys/module` entry**, so `ConditionPathExistsGlob=/sys/module/wlan*` silently excludes machines where it is compiled in (`ConditionResult=no`, no error). The same assumption in *driver detection* is worse because the unit appears to work: `wlan-suspend-mode`'s `driver_layout()` looked for `/sys/module/wlan_drv_gen4m*`, chose the Qualcomm private-ioctl struct with gen4m built in, and `SETSUSPENDMODE` failed with `EINVAL` (found on radon; see device-radon.md). Gate on something that exists either way — the character devices (`/dev/wmtWifi`, `/dev/conninfra_dev`, `/dev/stpbt`) or the interface itself — and bound any wait, exiting with a status in `RestartPreventExitStatus` so a machine without WLAN does not spin.

### "Wi-Fi associates, ping works, but TCP hangs"

Establish **where** the loss is before touching the port. Consumer routers accelerate TCP/UDP in hardware and leave ICMP on the slow path, so ping is no evidence for TCP; a router bridging badly between its 2.4 and 5 GHz radios kills only flows that cross bands (found on radon; see device-radon.md). Run this matrix:

| test | what it isolates |
|---|---|
| `ping -c5 -M do -s 1472 <peer>` | L2/L3 path and MTU, both directions |
| device `wget` a few MB from the internet | device↔AP leg only — fast means radio and driver are fine |
| device connects **out** to a listener on the peer | device-initiated TCP |
| peer connects **in** to a listener on the device | peer-initiated TCP |
| same tests with peer on the **same band** | isolates cross-band bridging |

Read `ss -ti` on the *sending* side: `bytes_acked:1` with climbing `bytes_retrans` means the receiver never got the data. Use a plain socket listener, not sshd.

## Bluetooth

LuneOS reaches the controller through **bluebinder**, which proxies the vendor BT HAL into a
vhci `hci0` for BlueZ.

- **Node ownership and the BT address** come from the vendor: the vendor's ueventd decides
  who owns the BT node, and `bluebinder_post.sh` reads the address from a vendor file. The
  MediaTek case (`/dev/stpbt`, the nvdata `BT_Addr` file): soc-mediatek.md § Connectivity
  combo.
- **BT HAL name is per vendor.** Do not hardcode `bluetooth-1-0`; the MP01 has
  `bluetooth-1-1`. `mtk-bt-bringup.sh` reads it from the vendor rc
  (`service <name> .../android.hardware.bluetooth@*`).
- **Restart order:** stop BlueZ and bluebinder → restart the HAL → start
  bluebinder → start BlueZ. bluebinder holds the HAL binding and does not re-bind by
  itself; restarting the HAL under a connected bluebinder makes it loop on "Remote has
  died", systemd kills it, and the leftover vhci is an `hci0` that will not initialise
  until the whole stack is restarted in order.
- **Controllers that misreport their features** abort hci init (`hci0` DOWN,
  `Can't init device hci0: Invalid request code (56)`). The MT6789 sets page 2 byte 0
  bit 2 (Synchronization Train) but answers Read Synchronization Train Parameters with
  `Unknown HCI Command`: `deviceinfo_bluebinder_ext_features_page_2_mask="0x0400000000000000"`.
  The MT6739 (mindphone) under-reports LE commands: `BLUEBINDER_LOCAL_COMMANDS_SET`.
  The `btmon` method that finds these is in connectivity.md § Bluetooth.
- **`BLUEBINDER_LOCAL_FEATURES_MASK 0x0` in bluebinder's log is its own unset setting
  echoed back**, not a reply from the controller.
- **bluebinder's "Own hci index" is an rfkill index, not the hci number.** bluebinder
  records the `idx` of the new `RFKILL_TYPE_BLUETOOTH` switch its vhci creates
  (`bluebinder.c`, `own_hci_index = event.idx`), and rfkill indices grow with every vhci
  registration, so "Own hci index: 1" (or 2, 3 …) says nothing about which `hciN` BlueZ
  uses. Compare `hciconfig -a` with `rfkill list` instead. With `CONFIG_BT_HCIVHCI=y` as
  the only BT transport, `hci0` *is* bluebinder's proxy.
- **rfkill soft-block that comes back:** `systemd-rfkill` restores saved state from
  `/var/lib/systemd/rfkill/` on every boot, so a state saved while blocked re-blocks after
  any manual `rfkill unblock` (`Failed to set mode: Blocked through rfkill (0x12)`).
- **Samsung EFS address:** see soc-qualcomm.md § Samsung EFS and the Bluetooth address.
- **A vendor with no BT service at all.** A LineageOS vendor whose manifest declares
  `android.hardware.bluetooth@1.0` passthrough loaded the HAL in its Bluetooth app; ship the AOSP
  default `android.hardware.bluetooth@1.0-service` and declare it hwbinder (gsi-building.md
  § Before deriving).
- **Qualcomm Rome over UART and `wcnss_filter`.** `libbt-vendor` either opens the UART
  (`/dev/ttyHS0`) itself or asks for the filter with `wc_transport.start_hci=true`. start-android-hals
  force-starts the vendor's disabled `start_hci_filter` regardless; with both on the UART the
  filter eats the controller's answers (`WCNSS_FILTER: handle_soc_events: Unexpected data format`),
  `bt_vendor` waits for ever on `read_vs_hci_event` after `EDL_PATCH_VER_REQ_CMD`, initialize fails
  and bluebinder times out. Then each `close()` aborts the service in
  `BluetoothHci::close()` → `std::__throw_bad_function_call` (close before a successful
  initialize), and hwservicemanager restarts it in a loop. Fix: `start_hci_filter` in
  `deviceinfo_android_skip_services` (an rc override does not stop the script; yocto.md
  § Shipping fixes through /odm). Found on bullhead.

### Finding a controller quirk with btmon

**`hci0` exists but stays DOWN, "No default controller available":** check `rfkill list` first (webOS BT off = soft-blocked), then `hciconfig hci0 up`. `Invalid request code (56)` is `EBADRQC`, which `bt_to_errno()` maps from HCI status **0x01 "Unknown HCI Command"**: the controller refused something it had *advertised*. Find which with `btmon`:

```sh
(btmon -i hci0 > /tmp/bt.log 2>&1 &); sleep 1; hciconfig hci0 up; sleep 2; pkill btmon
grep -B2 -A6 "Unknown HCI Command" /tmp/bt.log
```

Look up what gates that command in `hci_core.c` (`hci_init*_req`) and mask the bit bluebinder passes through (`BLUEBINDER_LOCAL_EXT_FEATURES_PAGE_2_MASK`, `BLUEBINDER_LOCAL_FEATURES_MASK`) or add missing ones (`BLUEBINDER_LOCAL_COMMANDS_SET`). Test by writing the value to `/var/lib/environment/bluebinder/<x>.conf` and restarting the stack in order. A `dut_mode ... already present` debugfs warning means a second `hci0` was registered over a stale vhci left by a killed bluebinder — restart the stack in order before debugging further. A kernel reset 57 s into every boot with `BUG_ON(!sk)` in `bt_sock_reclassify_lock` is a vendor tree that stubbed `hci_sock_create()` (kernel-build.md § Vendor trees that stub out `net/bluetooth/hci_sock.c` (Samsung)).

## Modem: ofono plugin ladder and config keys

Plugin by Android base (SFOS lineage — https://github.com/mer-hybris/hadk-faq):
`ofono-ril-plugin` (≤7) → `ofono-ril-binder-plugin` (8–10) → **`ofono-binder-plugin`**
(≥10, the one LuneOS ships). Its config lives in `/etc/ofono/binder.d/*.conf`
(`radioInterface` key); a dual-SIM second slot is declared as:

```ini
[ril_1]
transport=binder:name=slot2
name=slot2
```

Per our Tier-0 rule LuneOS *derives* the slot topology from the HAL
(enumerating `IRadio/slotN` on hwservicemanager) rather than hand-writing this file —
but these are the key names the generator must emit. The generator is `40-ofono-binder`;
tissot's and mido's hand-written `ofono-conf/*` files are older than it — do not copy them to a
new port (found on vince; device-vince.md).

### Modem failures on the Android side

- **Pick the right fstab.** `mount-android.sh` once took `fstab.enableswap` because it glob-sorts before `fstab.mt6739`, so the MTK NV partitions (`nvcfg`/`nvdata`/`protect1`/`protect2` — calibration + IMEI) never mounted: `md1.status = "exception"`, RIL daemon stopped. Fix: prefer `fstab.$(getprop ro.hardware)`, skip `*.enableswap`. Generic to any multi-fstab device (found on mindphone, where dual-SIM then came up; see device-mindphone.md). Read *every* fstab the vendor ships — some split them by purpose.
- MTK exposes NV partitions under `/dev/disk/by-partlabel` only (no by-name) — `find_partition_path` must cover that.
- Qualcomm variant (SFOS hadk-faq): the RIL stack needs Android's exact `/dev/block/bootdevice/by-name/` structure. Symptom: SIM never detected, sometimes a bootloop. `ls -lR /dev/block` on Android and replicate it with udev rules.

## NFC

nfcd reaches the vendor NFC HAL over libgbinder, so a stale `ApiLevel` shows up as `registerForNotifications(android.hardware.nfc.INfc/default) tx error` (hal-userspace.md § Before blaming AIDL). Controllers that reject a poll technology answer every `RF_DISCOVER` with `STATUS_REJECTED`; restrict polling in a Tier 2 `libncicore.conf` ordered `Before=nfcd.service` (titanpocket's ST21NFC refuses NFC-F; sargo). Waydroid's container start stops nfcd (hal-userspace.md § Waydroid).
