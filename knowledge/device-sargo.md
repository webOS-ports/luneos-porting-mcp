# Device: sargo (Google Pixel 3a) — the GSI pilot

The device the whole GSI/GKI architecture was proven on. **One generic rootfs (`MACHINE=halium-arm64`, no kernel, no GSI baked in) boots sargo on both the Halium 14.0 and 16.0 GSIs over its stock Android 12.1 vendor** — `systemctl is-system-running = running`, 0 failed units, full UI, 32 audio sinks, working nyx, sensorfwd, bluebinder, bluetooth and ofono. The same build serves both GSIs. Full history: `gsigki/luneos-gsi-gki-migration-plan.md` (§0, §2, §11).

## Platform facts

| Fact | Value |
|---|---|
| SoC | Qualcomm (Adreno) — the best-trodden libhybris path |
| Launched | Android 9; official updates through **Android 12** (final OTA May 2022) → can present vendor API level 28, 29, 30, 31 on one device |
| Kernel | 4.9.124 device kernel (**pre-GKI** — Tier B forever), LineageOS `bonito` defconfig, built by `linux-google-sargo` |
| A/B | yes (`androidboot.slot_suffix`) — exercises the initramfs A/B path |
| Dynamic partitions | **Retrofit** from Android 11: `BOARD_SUPER_PARTITION_METADATA_DEVICE := system`, block devices `system vendor` — **no partition named `super`, ever**, extents span two block devices |
| Old per-device image | `halium-luneos-9.0-*-sargo` tarballs — the thing the GSI work deletes |

## Why sargo mattered (and what it proved)

- **The control experiment**: same device, same 4.9 kernel, same Android 9 vendor, same LuneOS build — swap only `/android` from the sargo device image to a generic `halium_arm64` GSI. This proved the per-device Android build unnecessary.
- The android-headers version must **track the GSI, not the vendor** (libhybris gates Android 16 support on `ANDROID_VERSION_MAJOR >= 16` from that package). Verified ABI-safe: gralloc/hwcomposer2/hardware/lights headers byte-identical 11.0↔16.0; `audio_hw_device` unchanged member order with fields appended.
- The Tier-0 "derive, don't ship" adaptation principle: four sargo problems (33 vendor HALs never started, init blocked forever, 50 sysfs EACCES, compositor racing the HAL) each solved by deriving from the device's own rc files / HAL registry instead of shipping per-device files.

## The seven Android 16 blockers (each only visible after the previous one)

| Problem | Fix | Where |
|---|---|---|
| `***missing tool metalava***` at 86% | lunch `bp4a`, not `trunk_staging` (codename PLATFORM_VERSION builds `api_fingerprint`) | build config |
| VNDK 32 absent vs a 12.1 vendor | ship the v32 snapshot | halium device tree |
| `/init` aborts on kernel 4.9 | `MADV_WIPEONFORK` non-fatal (needs ≥4.14) | `hybris-patches` `herrie/h16-fixes` |
| `.capex` never mounted | `PRODUCT_COMPRESSED_APEX := false` | device tree |
| TLS abort in every getprop/setprop | Android 16 libhybris adaptation | `Herrie82/libhybris` `herrie/android16-tls` |
| GPU driver not found | `/vendor/lib{,64}/egl` on default LD paths | same branch |
| Boot splash never cleared | create `/dev/ashmem<boot_id>` on the host | `mount-android.sh` |

The last one is the one to remember: 0 failed units, working audio, no display — evidence only in the container's logcat (libcutils → libfmq → HIDL composer command queue).

## Retrofit dynamic partitions

`mount-android.sh` (ported from Droidian, run as `ExecStartPre` of `android-system.service`, NOT from the initramfs) + `parse-android-dynparts`, both fixed for the retrofit case: no `super` partition, LP metadata on `system`, extents spanning `system`+`vendor` (upstream parse-android-dynparts refused multi-device layouts). Covered by `tests/loopback-retrofit-test.sh` — 22 assertions on loop devices with real device-mapper; also pins the Android 9 no-metadata behaviour (exit 0, no dm nodes). Retrofit is a device *class* (most phones upgraded to 10/11 rather than launched on it), not a sargo quirk. Converting sargo to a real `super` is impossible/pointless (GPT fixed by bootloader; bad flash = EDL brick).

## The wrynose baseline (what makes sargo a usable control)

All GSI work targets `Herrie82/meta-smartphone` → `herrie/wrynose`; build tree `/media/herrie/LuneOS/wrynose/webos-ports`, `MACHINE=sargo . ./setup-env`. sargo builds and boots on wrynose as of 2026-08-16. Key commits:

| Commit | Why it matters |
|---|---|
| `20949047` | 4.9 host tools vs C23 (`constexpr` in unifdef.c) — pin the host C standard; also documents the corrupt `20240307-1` vendor.img |
| `17abddfa` | `wait-for-android.sh` no longer requires LineageOS's `livedisplay`; accepts hwcomposer/gralloc/`sys.init_boot_completed`, bounded wait with services logged on timeout — a generic GSI ships no livedisplay |
| `23edbee8` | `mdev-partlabel.sh` parses uevent instead of sourcing it (bash 5.3 can't source sysfs) — restores `/dev/disk/by-partlabel`, which is what lets the stock vendor mount by name |
| `dde5391a`+`0b37a1ae` | UNPACKDIR sweep — new recipes must use `${UNPACKDIR}`, not `${WORKDIR}` |
| `810e2c57`, `03508c3e`, `28615726` | dynparts port + retrofit fix + loopback test |
| `9b32def7` | lxc: arch from TARGET_ARCH, `lxc.uts.name=android`, binderfs, APEX via `mount-apexes.py` |

`android-system-image-sargo.bb` selects device vs GSI image via `SARGO_ANDROID_SYSTEM ?= "gsi"` and the generation via `SARGO_GSI_TARBALL`/`SARGO_GSI_SHA256`. GSI tarballs in DL_DIR: 11.0, 13.0, 14.0, 16.0 (`halium-luneos-<ver>-<date>-N-halium_arm64.tar.bz2`) — **publishing them is an open action**; published releases exist for 9.0/10.0/11.0 on `webOS-ports/halium-images`.

## Known sargo-specific traps

- `init.<board>.rc` gates `post-fs-data` on `wait_for_prop vendor.qcom.time.set true` — set by `time_daemon`, which Halium doesn't run. See debugging.md §2.1; this single property unblocked modem/vibrator/sensors and cut EACCES 50→1.
- Its vendor rc gates carry **no quotes** — sargo will never catch the quoted-property bug that wedged mindphone.
- The RIL crash `Missing path for slot slot2` proved the plugin enumerates slots from the HAL, not from `ril_subscription.conf` → the committed `ofono-conf/sargo/*` files are Tier 2 debt, to be replaced by derivation.
- Shipped-placeholder rule was learned here: `luna-platform.conf` shipped `DPI=445` and the generator read it back as a fallback — a plausible constant silently wrong on every device without an adaptation. Placeholders must be obviously invalid.
- 4.9 kernel has **no `CONFIG_OVERLAY_FS`** → adaptation overlays must fall back to bind-mounts on sargo.
- Atlas browser UI scaling: no LuneOS-side config fixes it — both fixes (CSS zoom, collapsing toolbar) belong in Atlas itself (`gsigki/atlas-scaling-findings.md`).

## What sargo can and cannot test

**Can:** vendor API 28→31 ladder on one device, A/B, retrofit dynparts, FBE/AVB/APEX (from A10 vendor up), the whole generic-rootfs claim, Halium 14/16 GSIs over a 12.1 vendor.
**Cannot:** GKI Tier A (pre-GKI 4.9 kernel), the `init_boot` path (A13-launch only), anything above vendor API 31 as a *vendor* (AIDL IComposer, gralloc5 vendors, VNDK-less A15+ vendors).

Recommended: keep a second sargo (~€50–70) as a known-good reference while bricking the first; check `getprop ro.vndk.version` on LineageOS 22 before assuming sargo can't go higher.
