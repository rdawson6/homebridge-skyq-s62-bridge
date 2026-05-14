# homebridge-skyq-s62-bridge

A Homebridge plugin that retrieves now-playing data from Sky Q boxes and forwards it to a **Systemline S6.2** multi-room audio system via a **Global Cache iTach IP2SL** RS232 bridge.

This reconstructs the **Sky Gnome RS232 protocol** that Sky used to output natively on older set-top boxes, so the S6.2 touch screen continues to display channel graphics and full programme information with Sky Q hardware.

No HomeKit accessories are created — this is a pure background bridge service.

---

## How it works

```
Sky Q box (SOAP/UPnP port 49153)  →  current channel SID
Sky EPG API (awk.epgsky.com)       →  programme title + synopsis
        ↓
  Homebridge plugin (Pi)
        ↓
  TCP socket → iTach IP2SL port 4999
        ↓
  RS232 serial output (57600 baud, 8N1)
        ↓
  S6.2 RS232 input
        ↓
  Channel graphic + programme info on touch screen
```

The plugin uses three data sources:

1. **SOAP/UPnP `GetMediaInfo`** on port 49153 — the only reliable way to get the currently tuned channel on Sky Q. Returns the channel SID as a hex URI (`xsi://4B9`).
2. **Sky Q REST API** on port 9006 — `/as/services/4/1` returns the full channel list (SID → channel name and number), fetched once at startup and cached.
3. **Sky EPG API** (`awk.epgsky.com`) — fetches today's schedule for the current channel and finds the currently airing programme, providing title, synopsis, and start time.

All six Sky Gnome packet fields are populated on every update:

| Field | Content |
|-------|---------|
| `SSCN` | Channel number (e.g. `102`) |
| `SSCA` | Channel name (e.g. `BBC Two HD`) |
| `SSDT` | Current time (e.g. `2.23pm Thu 14 May`) |
| `SST0` | Programme start time |
| `SSN0` | Programme title |
| `SSE0` | Programme synopsis |

Packets are sent when the channel changes, when the programme changes mid-channel, and when the box wakes from standby.

---

## Hardware required

- **Global Cache iTach IP2SL** — the dedicated IP-to-serial model (one RS232 port)
- RS232 cable from iTach to S6.2 RS232 input
- Sky Q box with a static IP address on your local network

---

## iTach IP2SL serial port configuration

Configure the iTach serial port via its web UI at `http://<itach-ip>`:

| Setting | Value |
|---------|-------|
| Baud rate | **57600** |
| Data bits | **8** |
| Parity | **None** |
| Stop bits | **1** |
| Flow control | **None** |

---

## Installation

```bash
npm install -g homebridge-skyq-s62-bridge
```

Or install via the Homebridge UI plugin search.

---

## Configuration

Add to your Homebridge `config.json`:

```json
{
  "platform": "SkyQS62Bridge",
  "name": "Sky Q S6.2 Bridge",
  "sky_boxes": [
    {
      "name": "Sky Q",
      "skyq_ip": "192.168.1.x",
      "itach_ip": "192.168.1.y",
      "itach_port": 4999,
      "poll_interval": 15
    }
  ]
}
```

### Config options

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `name` | No | `Sky Q S6.2 Bridge` | Platform name |
| `sky_boxes` | Yes | — | Array of Sky Q box entries |
| `sky_boxes[].name` | Yes | — | Friendly name for logs |
| `sky_boxes[].skyq_ip` | Yes | — | IP address of the Sky Q box |
| `sky_boxes[].itach_ip` | Yes | — | IP address of the iTach IP2SL |
| `sky_boxes[].itach_port` | No | `4999` | TCP port on the iTach |
| `sky_boxes[].poll_interval` | No | `15` | Poll interval in seconds (5–60) |

---

## Multiple Sky Q boxes

If you have more than one Sky Q box (e.g. a main box and a Sky Q Mini), add an entry for each. Each entry needs its own iTach IP2SL wired to the appropriate S6.2 RS232 input.

```json
{
  "platform": "SkyQS62Bridge",
  "name": "Sky Q S6.2 Bridge",
  "sky_boxes": [
    {
      "name": "Sky Q",
      "skyq_ip": "192.168.1.10",
      "itach_ip": "192.168.1.20",
      "itach_port": 4999,
      "poll_interval": 15
    },
    {
      "name": "Sky Q Mini",
      "skyq_ip": "192.168.1.11",
      "itach_ip": "192.168.1.21",
      "itach_port": 4999,
      "poll_interval": 15
    }
  ]
}
```

---

## Credits

**Sky Gnome RS232 protocol**
Documented by Joseph Heenan at https://www.heenan.me.uk/control-sky-from-pc/gnome-protocol.html — without this the packet format would have been very difficult to reverse engineer. The packet builder in this plugin has been verified byte-for-byte against the known example in that specification.

**Sky Q UPnP/REST API**
The Sky Q local network API was reverse engineered and documented by Liam Gladdy at https://gladdy.uk/blog/2017/03/13/skyq-upnp-rest-and-websocket-api-interfaces/ — this was essential for understanding the SOAP/UPnP interface and the critical distinction between the `GatewaySkyControl` and `GatewaySkyServe` UPnP nodes.

**pyskyqremote**
Roger Selwyn's Python library (https://github.com/RogerSelwyn/skyq_remote) provided invaluable reference for the Sky Q API endpoints, UPnP service discovery, and the `SKYPLUS_skyplus` user agent required to authenticate requests.

**Sky EPG API**
Programme data is sourced from `awk.epgsky.com`, Sky's public EPG web service.

**Built with Kiro AI**
This plugin was designed and built with [Kiro](https://kiro.dev), an AI-powered development environment. Kiro wrote the code, debugged the packet format against the live spec, discovered the correct UPnP endpoints by probing the actual hardware, and verified the full data pipeline end-to-end before the iTach hardware even arrived.

---

## Troubleshooting

**S6.2 not showing channel info**
- Check the iTach serial port baud rate is set to **57600** — this is the most common cause
- Check the RS232 cable is wired correctly (TX on iTach → RX on S6.2)
- Check the Homebridge logs for `TX:` lines — these show the hex packets being sent to the iTach

**Sky Q queries failing**
- Confirm the Sky Q box IP is correct and reachable from the Pi
- Sky Q boxes must be on the same local network as Homebridge
- The plugin uses SOAP/UPnP on port 49153 — ensure nothing is blocking this port

**iTach not connecting**
- Confirm the iTach IP and port in config
- Ensure the serial port baud rate is configured in the iTach web UI before connecting
- The plugin will automatically reconnect every 10 seconds if the connection drops

**Programme info missing (channel name only)**
- The Sky EPG API (`awk.epgsky.com`) requires internet access from the Pi
- Check the Pi can reach the internet: `curl https://awk.epgsky.com`
