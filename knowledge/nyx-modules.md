# Nyx Modules and the Per-Machine CMake

Nyx is the webOS hardware portability layer: `nyx-lib` defines the API, `nyx-modules`
implements it against sysfs/evdev, and `nyx-modules-hybris` implements the
Android-blob-backed parts via libhybris. Every LuneOS machine selects and parameterises
its modules through a per-machine `.cmake` file in the nyx-modules recipe — and a machine
without one does not even parse. This file explains the mechanism, the variables, the real
examples, and the hard-won rules about what belongs in the cmake versus what must be
verified on hardware or derived at runtime.

## The three pieces

| Component | What it is |
|---|---|
| `nyx-lib` | the nyx API that LuneOS services (LunaSysService etc.) call |
| `nyx-modules` | per-machine modules built from a webOS-OSE base: battery, charger, keys, touchpanel (incl. an mtdev variant), LED, haptics, deviceinfo, system — driven by sysfs paths and evdev nodes |
| `nyx-modules-hybris` | modules that go through libhybris to the Android HALs. Its `CMakeLists.txt` declares `webos_nyx_module_provider(HYBRIS DEVICEINFO HAPTICS LEDCONTROLLER SYSTEM GPS)` — i.e. it provides led controller, haptics, deviceinfo, system and GPS on hybris machines |

`nyx-modules-hybris` builds with cmake + `cmake-modules-webos` (`include(webOS/webOS)`,
`webos_modules_init`, `webos_component`), depends on `nyx-lib`, glib-2.0, PmLogLib and
android-headers, and includes an optional machine file at configure time:

```cmake
if(EXISTS ${CMAKE_CURRENT_SOURCE_DIR}/machine.cmake)
    include(${CMAKE_CURRENT_SOURCE_DIR}/machine.cmake)
endif()
```

## The recipe and the per-machine .cmake

Recipe: `meta-webos-ports/meta-luneos/recipes-webos-ose/nyx-modules/nyx-modules.bb`.
Key facts:

- `PACKAGE_ARCH = "${MACHINE_ARCH}"` — nyx-modules is inherently machine-specific (one of
  the legitimately machine-arch packages; on generic machines its content is exactly what
  the runtime-derivation work aims to hollow out).
- `DEPENDS = "nyx-lib glib-2.0 luna-service2 openssl udev nmeaparser"` + `mtdev` (LuneOS
  addition for the mtdev touchscreen modules).
- `RDEPENDS:${PN} += "nyx-conf"` — LuneOS uses per-device config provided by the
  `nyx-conf` package.
- A stack of LuneOS patches on top of webOS-OSE nyx-modules (ALS, haptics, keys, LED,
  MSM MTP, touchpanel-mtdev modules, …). **Patch 0022 allows `/etc/nyx.conf` runtime
  override** — the escape hatch for fixing wrong cmake constants on a live device.
- The per-machine files live next to the recipe:
  `meta-luneos/recipes-webos-ose/nyx-modules/nyx-modules/<machine>.cmake`
  (e.g. `hammerhead-halium.cmake`, `mido.cmake`, `tenderloin.cmake`, `raspberrypi4.cmake`,
  `halium-arm64.cmake`, and since Sep 2026 `bluejay.cmake` / `panther.cmake`).

**A machine without a `<machine>.cmake` does not parse.** When the bluejay and panther
machines were added (4 Sep 2026), creating
`meta-luneos/…/nyx-modules/{bluejay,panther}.cmake` as plain copies of
`halium-arm64.cmake` was a required step just to get bitbake past parsing — before any
image was built.

## The variables — real example

`hammerhead-halium.cmake` in full (comment header trimmed):

```cmake
# configuration file for hammerhead
# specify all the modules to be compiled

set(NYXMOD_OW_BATTERY					TRUE)
set(NYXMOD_OW_CHARGER					TRUE)
set(NYXMOD_OW_KEYS						TRUE)
set(NYXMOD_OW_TOUCHPANEL				FALSE)
set(NYXMOD_OW_TOUCHPANEL_MTDEV			TRUE)

# provided by nyx-modules-hybris
set(NYXMOD_OW_DEVICEINFO				FALSE)
set(NYXMOD_OW_SYSTEM					FALSE)
set(NYXMOD_OW_LED						FALSE)
set(NYXMOD_OW_HAPTICS					FALSE)

add_definitions(-DBATTERY_SYSFS_PATH=\"/sys/class/power_supply/battery/\")
add_definitions(-DTOUCHPANEL_DEVICE=\"/dev/input/event1\")
add_definitions(-DCHARGER_AC_SYSFS_PATH=\"/sys/class/power_supply/ac/\")
```

Reading it:

- `NYXMOD_OW_*` booleans pick which open-webOS modules compile for this machine. On a
  hybris machine, `DEVICEINFO`/`SYSTEM`/`LED`/`HAPTICS` are set `FALSE` because
  `nyx-modules-hybris` provides those (`webos_nyx_module_provider(HYBRIS DEVICEINFO
  HAPTICS LEDCONTROLLER SYSTEM GPS)`); building both would collide.
- `add_definitions(-D…)` bakes the device's sysfs paths and input nodes into the modules:
  `BATTERY_SYSFS_PATH`, `CHARGER_AC_SYSFS_PATH`, `TOUCHPANEL_DEVICE` (and on keypad
  devices, the keypad event node).

## When to flip a module back to the OW implementation

**mindphone precedent (2026-08-26): `NYXMOD_OW_HAPTICS TRUE` on a hybris machine.** The
hybris haptics module needs the legacy vibrator API, which android-headers 11.0 (and
newer) no longer carry — the image build failed until haptics was flipped to the
open-webOS implementation. This repeats the sargo precedent. Rule of thumb: when
`nyx-modules-hybris` fails to build against the machine's android-headers version because
an Android API was removed, flip that one module to `NYXMOD_OW_<X> TRUE` rather than
pinning older headers (the headers version must track the GSI — see the device-bringup
notes).

## Copy-paste is fiction until verified on hardware

From the mindphone notes, verbatim lesson: after the haptics fix, "the rest of
mindphone.cmake is still a rosy copy-paste: KEYPAD /dev/input/event1, TOUCHPANEL
/dev/input/event2, battery/charger sysfs paths — verify against the real device at
bring-up". Every value in a new machine's cmake starts as an unverified guess from
whatever machine it was copied from. Verify with `evtest` (which node is the keypad,
which the touchscreen) and `ls /sys/class/power_supply/` on the running device. Patch
0022's `/etc/nyx.conf` runtime override lets you correct values on-device before
rebuilding.

Concrete mindphone outcomes of that verification: the keypad really was `mtk-kpd` on
event1, but udev tagged it `ID_INPUT_KEY` only — Qt's evdevkeyboard discovery needs
`ID_INPUT_KEYBOARD`, promoted via a udev rule (a device bring-up fix, not a nyx one, but
found while chasing "nyx keys don't work"-shaped symptoms). The machine conf's display
values were also fiction: 1080x2340 copy-paste vs the real 480x800@~187ppi panel.

## The placeholder rule (migration plan §6.6 corollary)

Established 2026-08-24 and directly about nyx config:

> Shipped config files are placeholders, not defaults. A generic config may exist in the
> image — the generators need something to bind-mount over — but the device-describing
> values in it must be obviously invalid: zeros, empty lists, `/dev/input/PLACEHOLDER`.
> A plausible constant is worse than a broken one, because it is right often enough that
> the devices where it is wrong never announce themselves.

The incident list includes nyx directly: **`nyx.conf` shipped sargo's key nodes as
"graceful defaults"** (alongside `luna-platform.conf` shipping `DPI=445` that
`50-luna-platform` then read back as a fallback, and `surface-manager.env` shipping
sargo's touchscreen node). Two rules follow:

1. Never read a value back out of the file you generate — it is a placeholder, not a
   source.
2. When a fallback is genuinely needed so an unknown device still boots, put it in the
   generator (where it is visibly a fallback), not in the config (where it reads as a
   measurement).

Values that are not derived at all stay as working values, marked as such in the file —
a placeholder there would break something with nothing to replace it.

## Where nyx config is heading: runtime derivation

The target architecture (`luneos-device-config`, migration plan §6.5/§6.6) applies to nyx
config exactly as to display geometry:

- **Tier 0 (derive at runtime)** — the goal for everything: input nodes, battery/charger
  sysfs paths and the like should come off the running device (udev/sysfs enumeration,
  Android props, the vendor's own init rc files) rather than shipping per device.
  `luneos-device-config` resolves `/usr/share/luneos/adaptations/<codename>/` and overlays
  it over `/etc` + `/usr/lib/luneos/device/` via bind-mounts (overlayfs when the kernel
  has it), re-evaluated every boot so the rootfs stays universal.
- **Tier 1 (`deviceinfo`)** — only what cannot be read off a running device.
- **Tier 2 (sparse file overlay)** — last resort; adding a file requires stating why it
  cannot be derived. A per-device `nyx.conf` fragment is Tier 2 debt, to be repaid.

Related runtime-derivation fixes that landed during mindphone bring-up: the
`luneos-device-config` lshal per-call watchdog (lshal hangs forever on an unresponsive
HAL and blocked the whole boot queue), and the panel-size fbdev fallback reading
`/sys/class/graphics/fb0/modes` — **not** `fb0/mode`, which empties once the compositor
owns the panel.

## Checklist: adding nyx support for a new machine

1. Create `meta-luneos/recipes-webos-ose/nyx-modules/nyx-modules/<machine>.cmake` — start
   from `halium-arm64.cmake` for a hybris/GSI machine. Without it the build does not
   parse.
2. Keep `DEVICEINFO`/`SYSTEM`/`LED`/`HAPTICS` on the hybris side (`FALSE` in this file)
   unless the hybris module cannot build against the machine's android-headers — then
   flip that one module to `NYXMOD_OW_<X> TRUE` (haptics on headers ≥ 11.0 is the known
   case).
3. Treat every `add_definitions` path/node as unverified. Confirm with evtest and sysfs
   on the device at bring-up; use the `/etc/nyx.conf` override (patch 0022) to iterate
   without rebuilding.
4. Do not invent plausible values for hardware you have not probed — obviously-invalid
   placeholders beat plausible constants.
5. Longer term, move anything derivable into `luneos-device-config` generation instead of
   accumulating per-device cmake constants.
