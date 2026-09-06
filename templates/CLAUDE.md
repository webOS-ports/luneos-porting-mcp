# LuneOS project context

This project works on LuneOS (webOS) ports for Android devices via Halium GSI/GKI.

At the start of every session, load the complete LuneOS porting knowledge base
from the `luneos-mcp` server by reading this resource:

luneos://knowledge/all

If the task is narrow, load individual topics instead (`luneos_list_topics`
shows what exists — architecture, kernel-porting, boot-images, gsi-building,
device-bringup-yocto, nyx-modules, hal-userspace, debugging, installing, tools,
and per-device references like device-bluejay).

Ground rules from the knowledge base that always apply:

- Match the GSI to the device's **vendor API level** (`ro.vndk.version` /
  `ro.board.api_level`), never to the Android version it currently runs.
- `android-headers` versions track **the GSI, not the vendor**.
- Derive device configuration at runtime where possible; shipped config files
  are placeholders, not defaults.
- Verify KMI compatibility host-side (`kmi-crc-check.py`) **before** flashing
  any rebuilt GKI kernel.
- Respect anti-rollback: never flash a factory build older than the one on the
  device.
- When a device does not come up, follow `luneos://knowledge/debugging` stage
  by stage and collect evidence before changing anything.
