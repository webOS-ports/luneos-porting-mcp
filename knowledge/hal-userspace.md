# Userspace HAL Stack

How LuneOS reaches Android vendor HALs: the libgbinder glue, HIDL vs AIDL, binder ApiLevel, deriving and starting HAL services, sensors, text relocations and Waydroid.

LuneOS talks to Android vendor HALs through the Mer/Sailfish-lineage glue stack (libgbinder-based), libhybris for graphics, and derivation scripts that read the vendor's own configuration instead of shipping per-device files. This file covers the stack, the binder layer, how HAL services are derived and started, and sensors; graphics.md, audio-media.md and connectivity.md hold the other subsystems. Symptom-first triage (and the container-side traps such as `wait_for_prop`, the quoted-property gate and the ashmem node) lives in debugging.md.

## The stack

| Subsystem | Component | Status |
|---|---|---|
| Graphics | libhybris + `qt6-qpa-hwcomposer-plugin` | working through HIDL HWC2; AIDL composer3 support merged upstream but unproven in any shipping port |
| Modem | `ofono-binder-plugin` (+ `libgbinder`, `libgbinder-radio`, `ofono-conf`) | Jolla's plugin, tracks IRadio HIDL *and* AIDL |
| Audio | `pulseaudio-modules-droid` + `-droid-hidl` + `audiosystem-passthrough` | working (32 sinks on sargo) |
| Bluetooth | `bluebinder` | working via HIDL `IBluetoothHci`; AIDL support unverified |
| Sensors | `sensorfw` + `qtsensors-sensorfw-plugin` | working on HIDL; sensorfwd has an AIDL backend, not yet working on any port (surya: retest after the gbinder ApiLevel fix) |
| GPS | geoclue bbappend → add `geoclue-providers-hybris` | to add |
| Camera / HW video | `droidmedia` + `gst-droid` | replaces `qtubuntu-camera` (UT-era, dead); also gives HW decode to the webruntime |
| Vibrator/LED/deviceinfo | `nyx-modules-hybris` | device info (and GPS); haptics comes from `nyx-modules` on halium (nyx-modules.md § When to flip a module back to the OW implementation) |
| MTP | `mtp-server` | present |
| Android apps | waydroid recipes | present; rides the same GSI/GKI base |
| Android-isms | initrd hacks today; evaluate Halium's `mechanicd` | open |
| APEX | UBports `mount-apexes.py` | required from Android 10 |
| Dynamic partitions | `parse-android-dynparts` + ported `mount-android.sh` | required from Android 10, incl. retrofit layouts |

## HIDL vs AIDL — read the vendor manifest

The vendor manifest (`/vendor/etc/vintf/manifest/`, `/vendor/bin/hw`, `/vendor/lib64/hw`)
is the source of truth; read it from the factory `vendor.img` before assuming anything.
Verified surfaces so far:

| device (vendor) | composer | Bluetooth | sensors | radio | the rest |
|---|---|---|---|---|---|
| bluejay (A16 bp4a) | HIDL `@2.4::IComposer`: gs101's graphics HALs were never IDL-migrated (passthrough `hwcomposer.gs101.so` and `gralloc.default.so` still ship), so the path is sargo's | AIDL-only `IBluetoothHci` | AIDL multihal v3 | IRadio HIDL 1.6, dual slot | gralloc AIDL allocator v2 + `mapper.pixel.so` (stable-C mapper5); EGL `libGLES_mali.so` (+ `vulkan.mali.so`); audio HIDL 7.1; GNSS HIDL 2.1 (brcm); camera provider HIDL 2.7 + media.c2 AIDL + OMX 1.0 |
| panther (A16 bp4a) | **AIDL composer3 V4 only** (`android.hardware.composer.hwc3-service.pixel`; no HIDL composer on gs201) — needs libhybris' composer3 support (PR #578, #609, merged, exposed through the unchanged `hwc2_compat_*` API so the QPA plugin needs no change; no shipping port exercises it yet) | AIDL `IBluetoothHci` | AIDL multihal V3 | AIDL `IRadio*` per slot (+ HIDL `@1.2::ISap`): check ofono-binder-plugin's AIDL support | as bluejay, GPU Mali-G710 |

bluebinder is HIDL; its AIDL support is unverified, so Bluetooth is the first expected
casualty on AIDL-only vendors (not boot-blocking). Gralloc on these vendors is AIDL
allocator v2 + a stable-C mapper; the A16 GSI's libui speaks gralloc5 natively and
**libhybris delegates to libui since PR #509 (Jan 2023)** — the payoff of
"android-headers track the GSI, not the vendor".

**Rule:** every port runs the 16.0 GSI; the vendor's API level picks the VNDK snapshot
inside it (gsi-building.md § VNDK snapshot matrix), and the vendor manifest picks
which HAL transport each subsystem needs — never infer either from the Android version the
device runs. From A15, `ro.board.api_level` is a YYYYMM date; the SDK number is
`ro.vendor.build.version.sdk` (see "Before blaming AIDL" below).

## Derive, don't ship: the start-android-hals mechanism

`start-android-hals.sh` implements the derivations in architecture.md § The adaptation
tier model (HAL services, `wait_for_prop` gates, `chown`/`chmod` replay, waiting for
`IComposer`). The diagnostics behind the first two derivations — init blocked by a `wait_for_prop` gate, and the
quoted-property trap that wedged every HIDL `getService` — are in debugging.md § 2.1 Init "stuck" vs "curtailed" and § 2.2 The quoted-property trap.

**Skip lists come from the device's own adaptation.** `start-android-hals.sh` once sourced
every adaptation's deviceinfo on the rootfs, so the one that sorted last (n2awifi) supplied
everybody's `deviceinfo_android_skip_services`. It now sources the one `luneos-adaptation`
(luneos-device-config) names, after the container's properties are readable.

**The health HAL:** stub it only where no vendor daemon needs `IHealth`. sargo and
mindphone stub it (on sargo `healthd` armed a 60 s alarm that woke the SoC every minute);
sunfish cannot, because its `gnss_service` polls for `IHealth` once a second when it is
missing (device-sunfish.md § Subsystem notes).

### Stubbing a service vs not starting it

- **Not started:** `deviceinfo_android_skip_services` keeps `start-android-hals.sh` from
  force-starting a service (deviceinfo-reference.md § LuneOS runtime keys).
- **Stubbed:** `pre-start.d/50-stub-services` (meta-android `android-system`) bind-mounts a
  stub over each binary listed in `stubbed-services.d/<codename>` — one container-relative
  path per line, optionally followed by `exit` so the stub exits 0 for a helper init waits on —
  so init sees the service run and it does no work. Bind mounts also work on a read-only
  image. The codename comes from the vendor `build.prop` (`ro.product.vendor.device` first,
  then the device tree), because the script runs before the container's property service
  exists; a single `stubbed-services` file is the fallback for a machine that builds its own
  rootfs.
- **An APEX service cannot be stubbed this way**: the container's apexd mounts its own copy.
  Stop it from the vendor rc instead (found on goyavewifi; device-goyavewifi.md).
- **The USB gadget HAL** finds no `/config/usb_gadget/g1`, because LuneOS owns the gadget
  host-side, and aborts in its constructor; stub it (found on sunfish, 124 SIGABRTs in ten
  minutes; device-sunfish.md).

### udev rules from the container's own ueventd files — the next derivation to adopt

GPU-node (`pvr_sync`/`ion` 0666) and BT-node (`stpbt` ownership) fixes were both
hand-transcribed from values already sitting in the vendor's `ueventd.rc`. UBports
and Droidian generate the whole rule set from those files instead — pure Tier 0
(https://docs.halium.org/en/latest/porting/debug-build/udev.html,
https://docs.droidian.org/porting-guide/debugging-tips/):

```sh
DEVICE=<codename>
cat /var/lib/lxc/android/rootfs/ueventd*.rc \
    /var/lib/lxc/android/rootfs/vendor/ueventd*.rc | \
  grep ^/dev | sed -e 's/^\/dev\///' | \
  awk '{printf "ACTION==\"add\", KERNEL==\"%s\", OWNER==\"%s\", GROUP==\"%s\", MODE==\"%s\"\n",$1,$3,$4,$2}' | \
  sed -e 's/\r//' > /etc/udev/rules.d/70-$DEVICE.rules
```

Every ueventd node line becomes a udev rule, so node ownership/permissions match what the
vendor HALs expect without a per-device list. Candidate for `luneos-device-config`
generation, replacing one-off per-machine files such as mindphone's `70-mindphone.rules`.

## Binder and gbinder

Everything LuneOS layers over libgbinder — ofono-binder-plugin, bluebinder, sensorfw's
binder path, nfcd — presumes the vendor HAL registered on the binder bus; check that first
with `binder-list` (debugging.md § Stage 4). If the interface is absent, middleware
configuration is irrelevant. If it is present but libgbinder cannot reach it, check
`ApiLevel` below.

### Android 15 vendors are AIDL: the HIDL daemons stop finding anything

An Android 15 vendor registers its HALs with **`servicemanager` (AIDL)**, not
`hwservicemanager` (HIDL). LuneOS daemons that only speak HIDL then fail against
a vendor that is working perfectly. **Before concluding that, confirm libgbinder
speaks the vendor's servicemanager protocol** (next subsection): a wrong
`ApiLevel` produces the same symptoms against AIDL HALs that do exist.

The tell: `servicemanager` logs the AIDL HAL as found while the LuneOS daemon reports
its HIDL backend failing (`biomd: Failed to initialize HIDL fingerprint backend`). A
HIDL-only daemon cannot use a HAL the vendor only publishes on AIDL, whatever the
protocol preset. Found on athena with the LineageOS 22 vendor; the HAL lists and logs
are in device-athena.md § Vendor and GSI.

### Before blaming AIDL: is libgbinder even speaking the right protocol?

**Check this first, on every device, before writing or hunting a backend.** It is
one line of configuration and it invalidates any missing-backend diagnosis when
wrong. A property whose format changed is more dangerous than one that went missing: a
missing `ro.vndk.version` falls through to a fallback, while `202404` where an SDK number is
expected is a valid integer and every comparison silently succeeds (found on fajita;
device-fajita.md).

`libgbinder` chooses its servicemanager protocol from `ApiLevel` in
`/etc/gbinder.conf` (or any `/etc/gbinder.d/*.conf`, which override it). It picks
the highest preset **<=** that number, and presets exist only for
**28, 29, 30, 31, 33, 35 and 36** (`gbinder_config.c`). So `ApiLevel = 32`
silently selects the **API 31** preset, and the value must match the **vendor**
the device boots against, not the device's age or the GSI.

`ApiLevel` is an **SDK number**. Which property gives it depends on the vendor:

| vendor | `ro.board.api_level` | use |
|---|---|---|
| up to Android 14 | an SDK number (e.g. 32) | `ro.board.api_level` |
| Android 15+ | a **YYYYMM date** (202404 = A15, 202504 = A16) | `ro.vendor.build.version.sdk` (35 on A15) |
| no board level | — | `ro.vndk.version`, then `ro.build.version.sdk` |

A date written straight into `ApiLevel` is larger than every preset, so it always
selects preset 36 (servicemanager `aidl6`) — an Android 16 protocol against an
A15 vendor that speaks preset 35's `aidl5`. Measured on fajita and surya (both
`ro.board.api_level=202404`, `ro.vendor.build.version.sdk=35`, no
`ro.vndk.version`); see device-fajita.md § Android 15 vendors report a *dated*
API level.

Read the values from the vendor image itself:

```sh
debugfs -R "cat /build.prop" vendor.img | grep -E "ro.vendor.build.version.sdk|ro.board.api_level|ro.vndk.version"
```

**The failure looks exactly like a missing backend.** On sunfish the NFC HAL was
running (`vendor.st_nfc_hal_service`, pid 283), `nfcd` was healthy and had AIDL
support (`nfcd-binder-plugin` 1.2.1, `libgbinder` 1.1.52 = upstream HEAD,
including "Support for AIDL registration notifications"), and the *only* symptom
was:

```
nfcd: [gbinder] WARNING! registerForNotifications(
      android.hardware.nfc.INfc/default) tx error -2147483647
```

with the device on `ApiLevel = 32` (API 31 preset) against an **SDK 36** vendor.
A call whose protocol changed across those levels is precisely what breaks first
while everything else looks fine.

#### The build-time setting cannot serve most devices, and once lied

`GBINDER_API_LEVEL` in `libgbinder.bb` is per-machine and works **only for
machines that build their own rootfs image**. Verified by reading the value back
out of the deployed images rather than trusting metadata:

| machine | own rootfs image? | what shipped |
|---|---|---|
| halium-arm64, halium-arm, mindphone | yes | 32 / 30 / 30 |
| athena | yes (`tar.gz`, no `ext4`) | **35** |
| sargo, sunfish, bramble, bluejay, tangorpro, mp01, tissot-halium, mido-halium | no - they install the shared halium-arm64 image | **32**, always |

And the trap that matters: **every device kit checked (athena, sargo, bluejay,
sunfish) shipped the shared halium-arm64 `rootfs.ext4`**, so athena ran the API
31 preset against an A15 vendor for its entire life *even though its recipe
correctly said 35*. The metadata was right; kit assembly discarded it. Where a
machine builds its own image, package from that image.

#### How it is handled now

`luneos-device-config` resolves the level at boot by the table above (dated
values mapped to `ro.vendor.build.version.sdk`, else 202404→35 and 202504→36,
with a warning for an unknown date) and writes

```
/etc/gbinder.d/10-luneos-device.conf
[General]
ApiLevel = <resolved SDK level>
```

`gbinder_config.c` states outright that *"Files in the config directory overwrite
/etc/gbinder.conf"*, so this serves devices with no image of their own and
self-corrects a stale baked-in value. Verify on-device with:

```sh
journalctl -b | grep -i "gbinder ApiLevel"
```

### Telling a routing bug from a missing backend

`hwservicemanager` being *alive* does not mean HIDL is fine, and its being
unused does not mean it is dead. On athena it ran as pid 34 and successfully
served `android.hardware.camera.provider@2.4::ICameraProvider/legacy/0` in the
same boot where `nfcd` failed - so the transport was healthy and the fault was
elsewhere.

A cheap first discriminator is **the shape of the interface name in the log**:

| style | shape | served by |
|---|---|---|
| HIDL | `android.hardware.foo@1.2::IFoo/default` | `hwservicemanager`, `/dev/hwbinder` |
| AIDL | `android.hardware.foo.IFoo/default` | `servicemanager`, `/dev/binder` |

athena's `nfcd` logged `registerForNotifications(android.hardware.nfc.INfc/default)`,
the same call that failed in sunfish's stale-`ApiLevel` case above, and athena
was on the stale preset too. So fix `ApiLevel` and retest before anything else. Reading the line
as an AIDL name routed to a HIDL `IServiceManager` on `/dev/hwbinder` is
**unverified**; if it survives the correct `ApiLevel`, check which binder node
the call went to — a routing fix is far smaller than a new backend.

`-2147483647` (`INT32_MIN+1`) is not a standard binder exception code
(`EX_TRANSACTION_FAILED` is `-129`), which suggests a local library status
rather than a remote reply - i.e. the call failed before reaching a remote.

## Vendor kernel modules

Let the vendor's own init load them; how its loader finds `vendor_dlkm` in the
container, and the trap that makes it load nothing: kernel-modules.md § The
vendor_dlkm set.

## Sensors

sensorfw talks to the HIDL sensors HAL; sensorfwd also has an AIDL backend, not yet seen
working on any port. On surya's A15 vendor only the AIDL multihal service exists, and the
failure there matched the dated-`ApiLevel` problem above — retest after the gbinder fix
before stubbing anything (device-surya.md).

**Passthrough-only sensors HAL.** With the HIDL backend sensorfwd asks hwservicemanager for
`android.hardware.sensors@2.1`, `2.0` and `1.0` `ISensors/default` ("Could not find …" for each in the
journal) and exits when none is registered. A LineageOS vendor that declares `@1.0` passthrough has
only the impl (`/vendor/lib*/hw/android.hardware.sensors@1.0-impl.so`); ship the AOSP default
`android.hardware.sensors@1.0-service`, declare it hwbinder, and give it the groups for
`/dev/uinput` (`uhid` in the GSI's ueventd, `bluetooth` from host udev) if the HAL opens it.
**Sensor hubs that are flashed at boot** (Nexus 5X nanohub: the vendor's `flash-nanohub-fw` runs
`nanoapp_cmd download`, 50 s in one boot when it had firmware to load): the HAL gives up if it starts while the hub is busy.
Start the service from `on property:init.svc.flash-nanohub-fw=stopped`, in a class start-android-hals
does not force-start, and leave out the rc's `interface` line so a lookup cannot start it early. Also
check the flasher's rc itself: the Nexus 5X's has no `user`, which Android 16 init rejects, so the hub
was never flashed and the kernel logged `nanohub_kthread: err_cnt` every second.

## Text relocations: the Android 16 linker refuses them

Vendor libraries with `TEXTREL` (`readelf -d lib.so | grep TEXTREL`) do not load in a process whose target
SDK is 23 or later. On the A3 only three had them, all camera: libmmcamera_faceproc.so (dlopen()ed by
mm-qcamera-daemon, so its faceproc module silently went missing and the preview stream could not be linked:
"mct_stream_start_link ... Null", "QCameraStream: Failed to config stream" — a white viewfinder) and two
ArcSoft libraries. libpermissioncache_shim.so lowers the process's target SDK to 22 from a constructor;
preload it into the affected services with an rc `override` + `setenv LD_PRELOAD` (direct exec, no shell
wrapper). `android-system-image-legacy-a9-shim.inc` ships just that shim. Scan a new vendor once:
`for f in vendor/lib/*.so vendor/lib/hw/*.so; do readelf -d $f | grep -q TEXTREL && echo $f; done`.

## SoC-specific userspace

What only one SoC family needs lives in its own topic: the MediaTek connectivity combo, the A12 vendor keys, `stp_dump` and MT6789 audio in soc-mediatek.md; legacy Qualcomm vendors (display gaps, HAL1 camera, WCNSS, Samsung EFS, a LineageOS 21 vendor without VNDK) and the Adreno 4xx low-4GB reservation in soc-qualcomm.md.

## Waydroid

Upstream `container_manager.py` runs `systemctl stop nfcd` on container start and only restarts it on stop, so a failed start leaves NFC dead until reboot (meta-luneos waydroid patch 0010 removes both calls). A fresh userdata has no `/var/lib/waydroid/waydroid.cfg`, so the session units skip until `waydroid init` has downloaded its ~1 GB of images. When it genuinely fails, `/var/lib/waydroid/waydroid.log` has the `lxc-start` output; `lxc_spawn: ... Failed to clone a new set of namespaces` means the kernel lacks `CONFIG_IPC_NS`/`CONFIG_USER_NS` and Waydroid's generated config, unlike the Android container's, has no `lxc.namespace.keep = ipc user`. `waydroid-luneos-prepare` adds it for whichever is missing from `/proc/self/ns`, after `waydroid upgrade -o` regenerates the config (found on mp01).

Two more faults keep Android in the container from reaching `sys.boot_completed` (found on sargo; device-sargo.md § Waydroid): a session that bind-mounts `/tmp/xdg/wayland-0` by inode is left on a dead socket by a compositor restart (`waydroid-luneos-session.service` has `PartOf=surface-manager-daemon.service`); and Waydroid's SurfaceFlinger asks the host's hwservicemanager for `configstore` through `/dev/host_hwbinder` while LuneOS stubs it on the host, so `waydroid-luneos-prepare` sets the nine `ro.surface_flinger.*` props — after `waydroid upgrade -o`, which regenerates `waydroid_base.prop`.
