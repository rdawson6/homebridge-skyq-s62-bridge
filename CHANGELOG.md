# Changelog

## [1.1.0] - 2026-05-14

### Added
- Full EPG programme data via `awk.epgsky.com` — programme title, synopsis, and start time are now included in every Gnome packet (SSN0, SSE0, SST0 fields)
- Packets are now re-sent when the programme changes mid-channel, not just on channel change

### Changed
- Current channel is now retrieved via SOAP/UPnP `GetMediaInfo` on port 49153 rather than the REST API, which does not expose live channel data on Sky Q firmware
- UPnP discovery automatically handles both Sky Q main boxes (`GatewaySkyControl`) and Sky Q Mini (`MRSkyControl`)
- Channel name and number are looked up from the Sky Q channel list (`/as/services/4/1`) cached at startup

## [1.0.0] - 2026-05-08

### Initial release
- Sky Gnome RS232 protocol packet builder (byte-perfect, verified against spec)
- Sky Q SOAP/UPnP client for current channel SID
- Channel map loaded from Sky Q REST API at startup
- Persistent TCP connection to iTach IP2SL with auto-reconnect
- Power state packets sent on standby/wake transitions
- Supports multiple Sky Q boxes, each with its own iTach
