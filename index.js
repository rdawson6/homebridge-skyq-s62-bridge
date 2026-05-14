var net   = require("net");
var http  = require("http");
var https = require("https");

/* Register the plugin with homebridge */
module.exports = function(homebridge) {
  homebridge.registerPlatform("homebridge-skyq-s62-bridge", "SkyQS62Bridge", SkyQS62BridgePlatform);
}

/* =============================================================================
   Platform
   Registers no HomeKit accessories — this is a pure background bridge service.
   Each sky_box entry in config gets its own SkyQBridge instance which polls
   the Sky Q SOAP/UPnP API and forwards Gnome-protocol packets to the iTach IP2SL.
   ============================================================================= */
function SkyQS62BridgePlatform(log, config) {
  this.log      = log;
  this.sky_boxes = config["sky_boxes"] || [];
  this._bridges  = [];
}

SkyQS62BridgePlatform.prototype.accessories = function(callback) {
  var self = this;

  if (self.sky_boxes.length === 0) {
    self.log("WARNING: No sky_boxes configured. Nothing to bridge.");
  }

  for (var i = 0; i < self.sky_boxes.length; i++) {
    var bridge = new SkyQBridge(self.sky_boxes[i], self.log);
    self._bridges.push(bridge);
    bridge.start();
  }

  // No HomeKit accessories — return empty array
  callback([]);
}

/* =============================================================================
   Sky Gnome RS232 Packet Builder
   Reconstructs the packet format documented at:
   https://www.heenan.me.uk/control-sky-from-pc/gnome-protocol.html

   Packet structure (all ASCII except the leading 0x0a byte):
     0x0a                  - start of packet (LF)
     <total_length_3>      - 3-char decimal: counts itself(3) + body + checksum(2)
     [<type_4><len_3><data>]+ - one or more sub-packets
     <checksum_2>          - 2-char lowercase hex: sum of all bytes mod 256,
                             covering everything from 0x0a up to (not including) checksum

   Sub-packet length field counts: type(4) + length_field(3) + data.length = 7 + data.length
   ============================================================================= */
var GnomePacket = {

  /* Build a single sub-packet: type(4) + len(3) + data */
  _subpacket: function(type, data) {
    var d   = String(data || "");
    var len = String(7 + d.length).padStart(3, "0");
    return type + len + d;
  },

  /* Compute checksum: sum of all bytes mod 256, return as 2-char lowercase hex */
  _checksum: function(str) {
    var sum = 0;
    for (var i = 0; i < str.length; i++) {
      sum += str.charCodeAt(i);
    }
    return (sum & 0xff).toString(16).padStart(2, "0");
  },

  /* Build a complete Gnome packet from an array of { type, data } objects */
  build: function(subpackets) {
    var body = "";
    for (var i = 0; i < subpackets.length; i++) {
      body += this._subpacket(subpackets[i].type, subpackets[i].data);
    }
    // Total length = 3 (length field itself) + body length + 2 (checksum)
    var totalLen = String(3 + body.length + 2).padStart(3, "0");
    var packetWithoutChecksum = "\x0a" + totalLen + body;
    var checksum = this._checksum(packetWithoutChecksum);
    return packetWithoutChecksum + checksum;
  },

  /* Build the standard 60-second heartbeat packet with all now-playing fields */
  nowPlaying: function(channelNumber, channelName, currentTime, startTime, programmeName, programmeDescription) {
    return this.build([
      { type: "SSCN", data: channelNumber },
      { type: "SSCA", data: channelName },
      { type: "SSDT", data: currentTime },
      { type: "SST0", data: startTime },
      { type: "SSN0", data: programmeName },
      { type: "SSE0", data: programmeDescription }
    ]);
  },

  /* Build a power state packet: 0 = on, 1 = standby */
  powerState: function(standby) {
    return this.build([
      { type: "SYST", data: standby ? "1" : "0" }
    ]);
  }
};

/* =============================================================================
   Sky Q API Client
   Uses two interfaces:

   1. SOAP/UPnP on port 49153 — GetMediaInfo returns current channel SID as
      a hex URI like "xsi://4B9". This is the only reliable way to get the
      currently tuned channel on Sky Q.

   2. REST on port 9006 — /as/services/4/1 returns the full channel list with
      SID → channel name and number. Fetched once at startup and cached.

   3. REST on port 9006 — /as/system/time is used as a lightweight power-state
      check (if it responds, the box is on).
   ============================================================================= */
var SkyQClient = {

  /* Fetch JSON from a Sky Q REST endpoint. callback(err, object) */
  _getJSON: function(ip, path, callback) {
    var options = {
      host:   ip,
      port:   9006,
      path:   "/as/" + path,
      method: "GET",
      headers: { "User-Agent": "SKYPLUS_skyplus" }
    };
    var req = http.request(options, function(res) {
      var body = "";
      res.on("data", function(chunk) { body += chunk; });
      res.on("end", function() {
        try { callback(null, JSON.parse(body)); }
        catch(e) { callback(new Error("JSON parse error: " + e.message)); }
      });
    });
    req.setTimeout(5000, function() { req.destroy(); callback(new Error("Timeout")); });
    req.on("error", function(err) { callback(err); });
    req.end();
  },

  /* Send a SOAP action to the Sky Q UPnP service. callback(err, responseXmlString) */
  _soap: function(ip, controlPath, action, callback) {
    var body = [
      '<?xml version="1.0"?>',
      '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"',
      ' s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">',
      '<s:Body>',
      '<u:' + action + ' xmlns:u="urn:schemas-nds-com:service:SkyPlay:2">',
      '<InstanceID>0</InstanceID>',
      '</u:' + action + '>',
      '</s:Body></s:Envelope>'
    ].join("");

    var options = {
      host:   ip,
      port:   49153,
      path:   "/" + controlPath,
      method: "POST",
      headers: {
        "Content-Type":  "text/xml",
        "SOAPACTION":    '"urn:schemas-nds-com:service:SkyPlay:2#' + action + '"',
        "User-Agent":    "SKYPLUS_skyplus",
        "Content-Length": Buffer.byteLength(body)
      }
    };

    var req = http.request(options, function(res) {
      var data = "";
      res.on("data", function(chunk) { data += chunk; });
      res.on("end", function() { callback(null, data); });
    });
    req.setTimeout(5000, function() { req.destroy(); callback(new Error("SOAP timeout")); });
    req.on("error", function(err) { callback(err); });
    req.write(body);
    req.end();
  },

  /* Get current channel SID via SOAP GetMediaInfo.
     Returns { sid: number, standby: bool } */
  getCurrentSID: function(ip, controlPath, callback) {
    this._soap(ip, controlPath, "GetMediaInfo", function(err, xml) {
      if (err) return callback(err);
      // Extract CurrentURI value — looks like: <CurrentURI>xsi://4B9</CurrentURI>
      var match = xml.match(/<CurrentURI>(.*?)<\/CurrentURI>/);
      if (!match) {
        // No CurrentURI usually means standby
        return callback(null, { sid: null, standby: true });
      }
      var uri = match[1];
      if (!uri || uri === "NOT_IMPLEMENTED" || uri === "") {
        return callback(null, { sid: null, standby: true });
      }
      // xsi://4B9 — hex SID
      var hexMatch = uri.match(/xsi:\/\/([0-9a-fA-F]+)/);
      if (hexMatch) {
        return callback(null, { sid: parseInt(hexMatch[1], 16), standby: false });
      }
      // pvr://... means playing a recording, not live TV
      if (uri.startsWith("pvr://")) {
        return callback(null, { sid: null, standby: false, pvr: true });
      }
      callback(null, { sid: null, standby: false });
    });
  },

  /* Fetch the full channel list and return a SID→{channelNumber, channelName} map.
     Uses /as/services/4/1 (documentId 4, page 1 — returns all channels). */
  getChannelMap: function(ip, callback) {
    this._getJSON(ip, "services/4/1", function(err, data) {
      if (err) return callback(err);
      var map = {};
      var services = (data && data.services) || [];
      for (var i = 0; i < services.length; i++) {
        var s = services[i];
        if (s.sid) {
          map[String(s.sid)] = {
            channelNumber: String(s.c  || ""),
            channelName:   String(s.t  || "")
          };
        }
      }
      callback(null, map);
    });
  },

  /* Lightweight power check — /as/system/time responds when box is on.
     callback(err, { on: bool }) */
  getPowerState: function(ip, callback) {
    this._getJSON(ip, "system/time", function(err, data) {
      if (err) return callback(null, { on: false });
      callback(null, { on: !!(data && data.utc) });
    });
  },

  /* Look up the currently airing programme for a given SID from the Sky EPG.
     Uses awk.epgsky.com — the same public API that pyskyqremote uses.
     Fetches today's schedule for the SID and finds the event whose time window
     contains the current time.
     callback(err, { title, synopsis, startTime } | null) */
  getCurrentProgramme: function(sid, callback) {
    var now  = Math.floor(Date.now() / 1000);
    var date = new Date();
    var dateStr = String(date.getFullYear()) +
                  String(date.getMonth() + 1).padStart(2, "0") +
                  String(date.getDate()).padStart(2, "0");

    var options = {
      hostname: "awk.epgsky.com",
      path:     "/hawk/linear/schedule/" + dateStr + "/" + sid,
      method:   "GET",
      headers:  { "User-Agent": "SKYPLUS_skyplus" }
    };

    var req = https.request(options, function(res) {
      var body = "";
      res.on("data", function(chunk) { body += chunk; });
      res.on("end", function() {
        try {
          var data     = JSON.parse(body);
          var schedule = data.schedule && data.schedule[0];
          var events   = (schedule && schedule.events) || [];

          for (var i = 0; i < events.length; i++) {
            var e   = events[i];
            var end = e.st + e.d;
            if (e.st <= now && now < end) {
              var startDate = new Date(e.st * 1000);
              return callback(null, {
                title:     String(e.t  || ""),
                synopsis:  String(e.sy || ""),
                startTime: _formatTime(startDate)
              });
            }
          }
          // No matching event found (gap in schedule)
          callback(null, null);
        } catch(e) {
          callback(new Error("EPG parse error: " + e.message));
        }
      });
    });
    req.setTimeout(5000, function() { req.destroy(); callback(new Error("EPG timeout")); });
    req.on("error", function(err) { callback(err); });
    req.end();
  },

  /* Discover the SkyPlay control URL by fetching UPnP description XMLs.
     Must use the GatewaySkyControl device (not GatewaySkyServe — that one
     returns "Invalid action" for GetMediaInfo per the Gladdy blog warning).
     callback(err, controlPath) e.g. "444D5276-3247-4761-7465-d4dacd523799SkyPlay" */
  discoverControlPath: function(ip, callback) {
    var indices = [16, 17, 18, 19, 0, 1, 2, 3];
    var i = 0;

    function tryNext() {
      if (i >= indices.length) {
        return callback(new Error("Could not find SkyPlay control URL in any description XML"));
      }
      var idx = indices[i++];
      var options = {
        host:   ip,
        port:   49153,
        path:   "/description" + idx + ".xml",
        method: "GET",
        headers: { "User-Agent": "SKYPLUS_skyplus" }
      };
      var req = http.request(options, function(res) {
        var data = "";
        res.on("data", function(chunk) { data += chunk; });
        res.on("end", function() {
          // Must be a SkyControl device — accept GatewaySkyControl (main box)
          // or MRSkyControl (Sky Q Mini). Exclude GatewaySkyServe which returns
          // "Invalid action" for GetMediaInfo per the Gladdy blog warning.
          if (data.includes("SkyPlay:2") &&
              (data.includes("GatewaySkyControl") || data.includes("MRSkyControl"))) {
            var match = data.match(/<controlURL>\/([^<]+SkyPlay[^<]*)<\/controlURL>/);
            if (match) return callback(null, match[1]);
          }
          tryNext();
        });
      });
      req.setTimeout(3000, function() { req.destroy(); tryNext(); });
      req.on("error", function() { tryNext(); });
      req.end();
    }

    tryNext();
  }
};

/* Format a Date as "H.MMam/pm Day DD Mon" to match Gnome protocol examples */
function _formatTime(d) {
  var hours  = d.getHours();
  var mins   = d.getMinutes();
  var ampm   = hours >= 12 ? "pm" : "am";
  var h      = hours % 12 || 12;
  var days   = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  var months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return h + "." + String(mins).padStart(2,"0") + ampm + " " + days[d.getDay()] + " " + d.getDate() + " " + months[d.getMonth()];
}

/* =============================================================================
   Sky Q Bridge
   One instance per sky_box config entry. Polls Sky Q and writes Gnome packets
   to the iTach IP2SL over a persistent TCP connection.

   Config fields:
     name          - friendly name for logs
     skyq_ip       - IP address of the Sky Q box
     itach_ip      - IP address of the iTach IP2SL
     itach_port    - TCP port on the iTach (default 4999)
     poll_interval - seconds between polls (default 15)
   ============================================================================= */
function SkyQBridge(config, log) {
  this.name          = config.name          || "Sky Q Bridge";
  this.skyq_ip       = config.skyq_ip;
  this.itach_ip      = config.itach_ip;
  this.itach_port    = config.itach_port    || 4999;
  this.poll_interval = (config.poll_interval || 15) * 1000;
  this.log           = log;

  this._sock         = null;
  this._sockReady    = false;
  this._pollTimer    = null;
  this._reconnTimer  = null;

  this._controlPath  = null;   // discovered SkyPlay SOAP control URL path
  this._channelMap   = null;   // SID → { channelNumber, channelName }

  // Last known state — used to suppress duplicate packets
  this._lastStandby  = null;
  this._lastSID      = null;
  this._lastProg     = null;  // programme title — resend when programme changes
}

/* Start: discover SOAP control path, load channel map, then connect and poll */
SkyQBridge.prototype.start = function() {
  var self = this;
  self.log("[" + self.name + "] Starting — Sky Q: " + self.skyq_ip + " → iTach: " + self.itach_ip + ":" + self.itach_port);

  // Discover the SkyPlay SOAP control URL
  SkyQClient.discoverControlPath(self.skyq_ip, function(err, controlPath) {
    if (err) {
      self.log("[" + self.name + "] SOAP discovery failed: " + err.message + " — will retry in 30s");
      setTimeout(function() { self.start(); }, 30000);
      return;
    }
    self._controlPath = controlPath;
    self.log("[" + self.name + "] SkyPlay control path: " + controlPath);

    // Load channel map
    SkyQClient.getChannelMap(self.skyq_ip, function(err, map) {
      if (err) {
        self.log("[" + self.name + "] Channel map failed: " + err.message + " — continuing without names");
        self._channelMap = {};
      } else {
        var count = Object.keys(map).length;
        self.log("[" + self.name + "] Channel map loaded: " + count + " channels");
        self._channelMap = map;
      }

      // Connect to iTach and start polling
      self._connect();
    });
  });
}

/* Open (or reopen) the TCP connection to the iTach */
SkyQBridge.prototype._connect = function() {
  var self = this;
  if (self._sock) { self._sock.destroy(); self._sock = null; }
  self._sockReady = false;

  var sock = new net.Socket();
  self._sock = sock;

  sock.connect(self.itach_port, self.itach_ip, function() {
    self.log("[" + self.name + "] iTach connected");
    self._sockReady = true;
    self._schedulePoll(0);
  });

  sock.on("error", function(err) {
    self.log("[" + self.name + "] iTach socket error: " + err.message);
    self._sockReady = false;
    self._scheduleReconnect();
  });

  sock.on("close", function() {
    self.log("[" + self.name + "] iTach connection closed");
    self._sockReady = false;
    self._scheduleReconnect();
  });

  // The iTach IP2SL may send back status messages — log them
  sock.on("data", function(data) {
    self.log("[" + self.name + "] iTach RX: " + data.toString().trim());
  });
}

SkyQBridge.prototype._scheduleReconnect = function() {
  var self = this;
  if (self._reconnTimer) return;
  self._reconnTimer = setTimeout(function() {
    self._reconnTimer = null;
    self.log("[" + self.name + "] Reconnecting to iTach...");
    self._connect();
  }, 10000);
}

SkyQBridge.prototype._schedulePoll = function(delay) {
  var self = this;
  if (self._pollTimer) clearTimeout(self._pollTimer);
  self._pollTimer = setTimeout(function() {
    self._pollTimer = null;
    self._poll();
  }, delay !== undefined ? delay : self.poll_interval);
}

/* Poll Sky Q via SOAP, build Gnome packets, send to iTach */
SkyQBridge.prototype._poll = function() {
  var self = this;

  if (!self.skyq_ip || !self._controlPath) {
    self._schedulePoll();
    return;
  }

  SkyQClient.getCurrentSID(self.skyq_ip, self._controlPath, function(err, result) {
    if (err) {
      self.log("[" + self.name + "] SOAP query failed: " + err.message);
      self._schedulePoll();
      return;
    }

    var standby = result.standby;

    // Send power state packet if it changed
    if (self._lastStandby !== standby) {
      self._lastStandby = standby;
      self.log("[" + self.name + "] Power: " + (standby ? "STANDBY" : "ON"));
      self._send(GnomePacket.powerState(standby));
    }

    if (standby) {
      self._schedulePoll();
      return;
    }

    if (result.pvr) {
      self.log("[" + self.name + "] Playing recording — no channel info");
      self._schedulePoll();
      return;
    }

    if (!result.sid) {
      self._schedulePoll();
      return;
    }

    var sid = result.sid;

    // Only send a packet if the channel or programme changed
    // EPG lookup happens on every poll so we catch programme changes mid-channel
    var ch = (self._channelMap && self._channelMap[String(sid)]) || {};
    var channelNumber = ch.channelNumber || String(sid);
    var channelName   = ch.channelName   || "Unknown";

    SkyQClient.getCurrentProgramme(sid, function(err, prog) {
      if (err) {
        self.log("[" + self.name + "] EPG lookup failed: " + err.message);
      }

      var title    = (prog && prog.title)     || "";
      var synopsis = (prog && prog.synopsis)  || "";
      var startTime= (prog && prog.startTime) || "";

      // Suppress duplicate packets — only send if channel or programme changed
      var changeKey = sid + "|" + title;
      if (changeKey === self._lastSID + "|" + self._lastProg) {
        self.log("[" + self.name + "] No change — CH" + channelNumber + " " + channelName + (title ? " / " + title : ""));
        self._schedulePoll();
        return;
      }

      self._lastSID  = sid;
      self._lastProg = title;

      self.log("[" + self.name + "] Now playing: CH" + channelNumber + " " + channelName + (title ? " — " + title : ""));

      var packet = GnomePacket.nowPlaying(
        channelNumber,
        channelName,
        _formatTime(new Date()),
        startTime,
        title,
        synopsis
      );
      self._send(packet);
      self._schedulePoll();
    });
  });
}

/* Write a Gnome packet to the iTach socket */
SkyQBridge.prototype._send = function(packet) {
  if (!this._sockReady || !this._sock) {
    this.log("[" + this.name + "] iTach not connected — packet dropped");
    return;
  }
  var hex = Buffer.from(packet).toString("hex").match(/../g).join(" ");
  this.log("[" + this.name + "] TX: " + hex);
  this._sock.write(packet);
}
