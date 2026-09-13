# luneos-mcp

MCP (Model Context Protocol) server packaging the knowledge gained porting
LuneOS to modern Android devices via Halium GSIs and GKI kernels — kernel
porting, boot-image construction, Yocto/meta-smartphone device bring-up,
nyx-modules configuration, GSI building, installation, and a staged
"device doesn't come up" debugging playbook.

Modelled on [webOSArchive/webos-mcp](https://github.com/webOSArchive/webos-mcp),
but for LuneOS device porting rather than legacy webOS app development.

The knowledge was distilled from real ports and bring-ups:

- **sargo** (Pixel 3a) — the GSI pilot: one generic `halium-arm64` rootfs
  booting Halium 14.0 and 16.0 GSIs over the stock Android 12.1 vendor
- **bluejay** (Pixel 6a) — first Tier A GKI port: ACK `android14-6.1` kernel,
  KMI-preserving config fragment, stock vendor modules
- **panther** (Pixel 7) — A13-launch `init_boot` layout, same kernel binary
- **mindphone** (MT6739) — Tier B legacy port: 32-bit kernel, `halium_arm`
  GSI built for Halium 11 and 16, full UI/wifi/BT/modem bring-up
- **q25** (Zinwa Q25, MT6789/Helio G99) — first MediaTek Tier A GKI target,
  square-screen QWERTY; Yocto side and stock-firmware analysis complete,
  pre-hardware

plus cross-checked material from the UBports, Droidian and Sailfish OS (HADK)
porting guides, integrated where their methods transfer to the LuneOS stack
(and flagged where they conflict — e.g. their kernel config lists vs the
Tier A KMI-poison findings).

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

To have Claude load the full context automatically in a porting project, copy
`templates/CLAUDE.md` into the project (or merge its contents into an existing
`CLAUDE.md`).

## What it exposes

### Resources

| URI | Content |
|---|---|
| `luneos://knowledge/all` | every topic concatenated — load at session start |
| `luneos://knowledge/<topic>` | one topic file |

Topics (auto-discovered from `knowledge/*.md`):

| Topic | Covers |
|---|---|
| `architecture` | the GSI+GKI model: one rootfs, Treble, Tier A/B, adaptation tiers, on-device layout |
| `kernel-porting` | GKI/ACK builds, KMI-poison list & CRC verification, Tier B legacy kernels |
| `boot-images` | header v0–v4, per-layout repack recipes, initramfs init patches, AVB/vbmeta |
| `gsi-building` | building Halium GSIs (arm64 and 32-bit arm), Halium 16 traps, VNDK snapshots |
| `device-bringup-yocto` | meta-smartphone machines, gki_bootimg, recipes, bitbake gotchas |
| `nyx-modules` | nyx-modules(-hybris) per-machine cmake, variables, pitfalls |
| `hal-userspace` | libhybris stack, HIDL vs AIDL per subsystem, Mali, MTK connectivity |
| `debugging` | staged "device doesn't come up" playbook, symptom → cause table |
| `installing` | flash kits, userdata images, fastboot flows, anti-rollback |
| `tools` | kmi-crc-check, module-order, payload_extract, mer-kernel-check, … |
| `deviceinfo-reference` | the UBports/HGABT `deviceinfo` variable reference our Tier 1 format reuses |
| `device-bluejay` / `device-panther` / `device-mindphone` / `device-sargo` / `device-zinwa-q25` | per-device reference |

### Tools

- `luneos_list_topics` — list topics with descriptions
- `luneos_get_topic` — fetch one topic's markdown
- `luneos_search` — keyword search across the whole knowledge base
  (symptoms, config options, file names)

### Prompts

- `luneos-session-start` — load the knowledge base into a session
- `luneos-port-device` — guided porting workflow for a new device
- `luneos-debug-boot` — staged triage for a device that does not come up

## Updating the knowledge

Each file in `knowledge/` is one topic; the first `# heading` is its title and
the first paragraph its description. Add or edit files and the server picks
them up on the next request — no restart or re-registration needed.

## License

Apache-2.0
