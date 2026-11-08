# luneos-mcp

MCP (Model Context Protocol) server packaging the knowledge gained porting
LuneOS to modern Android devices via Halium GSIs and GKI kernels — kernel
porting, boot-image construction, Yocto/meta-smartphone device bring-up,
nyx-modules configuration, GSI building, installation, and a staged
"device doesn't come up" debugging playbook.

Modelled on [webOSArchive/webos-mcp](https://github.com/webOSArchive/webos-mcp),
but for LuneOS device porting rather than legacy webOS app development.

The knowledge was distilled from real ports and bring-ups: Pixels on GKI
(bluejay, panther) and pre-GKI kernels (sargo, sunfish, bramble), MediaTek phones
and tablets (mindphone, q25, mp01, brax3, radon, titanpocket, sm-t220), Qualcomm
Tier B devices from 2015 to 2020 (a3-2015-halium, bullhead, athena, fajita, surya, vince),
and a Spreadtrum tablet (goyavewifi). The
device index in `architecture` lists each with its tier, kernel, vendor, GSI and
status; every device has its own `device-<codename>` topic. Material from the
UBports, Droidian and Sailfish OS (HADK) porting guides is integrated where it
transfers to the LuneOS stack, and flagged where it conflicts.

## Install

```sh
git clone https://github.com/webOS-ports/luneos-porting-mcp.git
cd luneos-porting-mcp
npm install

# For Claude Code, user scope:
claude mcp add luneos-mcp -s user -- node "$PWD/index.js"

# Or per-project:
claude mcp add luneos-mcp -s project -- node "$PWD/index.js"
```

(Once published to npm: `claude mcp add luneos-mcp -s user -- npx -y luneos-mcp@latest`.)

Requires Node.js 18+.

To point Claude at the knowledge base in a porting project, copy
`templates/CLAUDE.md` into the project (or merge its contents into an existing
`CLAUDE.md`).

## What it exposes

### Resources

| URI | Content |
|---|---|
| `luneos://knowledge/all` | every topic concatenated — very large; prefer `architecture` + search |
| `luneos://knowledge/<topic>` | one topic file |

Topics (auto-discovered from `knowledge/*.md`; `luneos_list_topics` shows them in the same
groups). Each description is the topic's own first paragraph.

**General**

| Topic | Covers |
|---|---|
| `architecture` | LuneOS's target architecture: one universal arm64 rootfs plus a generic Halium GSI on any unlockable Treble/GKI device, with per-device cost cut to a boot image and config. |
| `debugging` | Stage-by-stage playbook for a LuneOS GSI/GKI port that does not come up, distilled from failures hit and diagnosed on real hardware. |
| `tools` | The small, self-contained porting and debug tools built during the LuneOS GSI/GKI work, with usage and location. |
| `deviceinfo-reference` | Reference for `deviceinfo` keys: the UBports/HGABT boot and kernel variables LuneOS reuses verbatim, and LuneOS's own runtime keys read by luneos-device-config. |

**SoC families**

| Topic | Covers |
|---|---|
| `soc-mediatek` | What holds across the MediaTek ports (preloader and lk, mgk kernels, the connectivity combo, A12 vendor keys); device files keep their own values and link here. |
| `soc-qualcomm` | What holds across the Qualcomm ports (aboot and ABL, appended device trees, CAF/LineageOS kernels, legacy vendors); device files keep their own values and link here. |

**Kernel**

| Topic | Covers |
|---|---|
| `kernel-config` | What a LuneOS kernel config changes from stock, which changes break a KMI, the debug options, and the kernel command line. |
| `kernel-build` | How a LuneOS kernel is built: one ACK-based kernel per KMI on Tier A devices, the vendor's BSP tree per device on Tier B, and the traps of each. |
| `kmi-crc-matching` | Whether a vendor `.ko` loads into your kernel, Tier A or Tier B: vermagic, CRCs, struct layouts and force-loading. |
| `kernel-modules` | How modules get loaded on a LuneOS port: the vendor's two module sets, load order, prebuilt vendor sets, and building and shipping modules of your own. |
| `boot-images` | How to build, verify and flash LuneOS boot images for the three layout classes: legacy header v2, A12-launch GKI (ramdisk in boot) and A13-launch GKI (ramdisk in init_boot). |

**Userspace components**

| Topic | Covers |
|---|---|
| `yocto` | How a LuneOS port is wired into Yocto: layer geography, machine confs, the generic halium-arm64 machine, GKI boot-image machines, GSI recipes, LXC config and build traps. |
| `nyx-modules` | How LuneOS picks and configures its nyx modules: NYX_MODULES_REQUIRED per machine, nyx.conf values derived at boot, and the rules for what must be measured. |
| `gsi-building` | How LuneOS builds the Halium GSIs it mounts as /android: halium_arm64 and halium_arm products, the halium-16.0 traps, device-tree patches and publishing. |
| `installing` | How LuneOS is installed: flash kits that write vbmeta, a boot image (plus init_boot on A13-launch devices) and a userdata image, leaving stock partitions alone. |
| `hal-userspace` | How LuneOS reaches Android vendor HALs: the libgbinder glue, HIDL vs AIDL, binder ApiLevel, deriving and starting HAL services, sensors, text relocations and Waydroid. |
| `graphics` | How LuneOS draws through vendor GPU blobs: libhybris fixes, Mali, the display smoke test, DRM master, the Wayland socket split and browser scaling. |
| `audio-media` | Sound through pulseaudio-modules-droid and the vendor audio HAL, its quirks and how to debug them, and the webOS media server path for HTML5 audio and video. |
| `connectivity` | Bringing up and debugging the radios on a Halium vendor: Wi-Fi drivers and the regulatory db, bluebinder, ofono-binder-plugin and nfcd. |

**Devices** — one `device-<codename>` topic per port (status, platform facts, kernel, boot
image, vendor/GSI, Yocto, install, open issues); the device index in `architecture` has tier,
kernel, vendor, GSI and state for each.

| Topic | Device | SoC |
|---|---|---|
| `device-sargo` | Google Pixel 3a | Qualcomm SDM670 |
| `device-bluejay` | Google Pixel 6a | Google Tensor gs101 |
| `device-panther` | Google Pixel 7 | Google Tensor G2 gs201 |
| `device-sunfish` | Google Pixel 4a | Qualcomm SM7150-AB (730G) |
| `device-bramble` | Google Pixel 4a 5G | Qualcomm SM7250 (765G) |
| `device-mindphone` | GreenTouch MindPhone | MediaTek MT6739 |
| `device-q25` | Zinwa Q25 / Q25 Pro | MediaTek MT6789 (G99) |
| `device-mp01` | Minimal Phone MP01 | MediaTek MT6789 (G99) |
| `device-brax3` | BraX3 | MediaTek MT6835 (Dimensity 6300) |
| `device-radon` | FuriLabs FuriPhone FLX1s | MediaTek MT6877 |
| `device-titanpocket` | Unihertz Titan Pocket | MediaTek MT6771 (P70) |
| `device-sm-t220` | Samsung Galaxy Tab A7 Lite Wi-Fi | MediaTek MT8768T |
| `device-a3-2015-halium` | Samsung Galaxy A3 (2015) | Qualcomm MSM8916 |
| `device-goyavewifi` | Samsung Galaxy Tab 3 Lite 7.0 Wi-Fi (SM-T113) | Spreadtrum SC7730S |
| `device-bullhead` | LG Nexus 5X | Qualcomm MSM8992 |
| `device-athena` | BlackBerry KEY2 | Qualcomm SDM660 |
| `device-fajita` | OnePlus 6T | Qualcomm SDM845 |
| `device-surya` | Xiaomi POCO X3 NFC | Qualcomm SM7150-AC (732G) |
| `device-vince` | Xiaomi Redmi 5 Plus | Qualcomm MSM8953 |

Renamed topics keep answering under their old name (`TOPIC_ALIASES` in `index.js`):
`device-bringup-yocto` → `yocto`, `kernel-porting` → `kernel-build`. The reply starts with a
note naming the new topic.

### Tools

- `luneos_list_topics` — list topics with descriptions
- `luneos_get_topic` — fetch one topic's markdown
- `luneos_search` — keyword search across the whole knowledge base
  (symptoms, config options, file names)

### Prompts

- `luneos-session-start` — orient a session on the knowledge base
- `luneos-port-device` — guided porting workflow for a new device
- `luneos-debug-boot` — staged triage for a device that does not come up

## Updating the knowledge

Each file in `knowledge/` is one topic; the first `# heading` is its title and
the first paragraph its description, so keep that paragraph to one sentence of
at most ~200 characters and put the rest in a second paragraph. A correction
replaces the wrong text in place rather than being appended next to it. Each
fact has one home; elsewhere, link to it (`kmi-crc-matching.md § Struct layouts`).
Device files follow a common shape (see any `device-*.md`). Add or edit files
and the server picks them up on the next request — no restart or re-registration needed.

`npm test` (`scripts/check-refs.mjs`) checks that every `<topic>.md` and
`<topic>.md § Heading` reference resolves, that each first paragraph fits in 200
characters, and that every alias target and `PROMPT_TOPICS` entry in `index.js` is a
real topic or heading. A renamed topic gets an entry in `TOPIC_ALIASES`.

## License

Apache-2.0
