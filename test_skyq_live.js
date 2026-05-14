/* Live test against both Sky Q boxes.
   Run with: node test_skyq_live.js
   Does NOT require the iTach — only tests the Sky Q API side.
*/

var http = require("http");

var SKYQ_IP = "192.168.4.227";
var MINI_IP  = "192.168.4.232";

/* ---- helpers ---- */
function getJSON(ip, path, callback) {
  var options = {
    host: ip, port: 9006,
    path: "/as/" + path, method: "GET",
    headers: { "User-Agent": "SKYPLUS_skyplus" }
  };
  var req = http.request(options, function(res) {
    var body = "";
    res.on("data", function(c) { body += c; });
    res.on("end", function() {
      try { callback(null, JSON.parse(body)); }
      catch(e) { callback(new Error("JSON: " + e.message + " body=" + body.substring(0,100))); }
    });
  });
  req.setTimeout(5000, function() { req.destroy(); callback(new Error("Timeout")); });
  req.on("error", callback);
  req.end();
}

function soap(ip, controlPath, action, callback) {
  var body = '<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:' + action + ' xmlns:u="urn:schemas-nds-com:service:SkyPlay:2"><InstanceID>0</InstanceID></u:' + action + '></s:Body></s:Envelope>';
  var options = {
    host: ip, port: 49153, path: "/" + controlPath, method: "POST",
    headers: {
      "Content-Type": "text/xml",
      "SOAPACTION": '"urn:schemas-nds-com:service:SkyPlay:2#' + action + '"',
      "User-Agent": "SKYPLUS_skyplus",
      "Content-Length": Buffer.byteLength(body)
    }
  };
  var req = http.request(options, function(res) {
    var data = "";
    res.on("data", function(c) { data += c; });
    res.on("end", function() { callback(null, data); });
  });
  req.setTimeout(5000, function() { req.destroy(); callback(new Error("SOAP timeout")); });
  req.on("error", callback);
  req.write(body);
  req.end();
}

function discoverControlPath(ip, callback) {
  // Main box uses description16-19, Mini uses description0
  // Accept GatewaySkyControl (main) or MRSkyControl (Mini)
  // Exclude GatewaySkyServe which returns "Invalid action" for GetMediaInfo
  var indices = [0, 1, 2, 3, 16, 17, 18, 19];
  var i = 0;
  function tryNext() {
    if (i >= indices.length) return callback(new Error("Not found"));
    var idx = indices[i++];
    var options = { host: ip, port: 49153, path: "/description" + idx + ".xml", method: "GET", headers: { "User-Agent": "SKYPLUS_skyplus" } };
    var req = http.request(options, function(res) {
      var data = "";
      res.on("data", function(c) { data += c; });
      res.on("end", function() {
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

/* ---- test one box, call done() when finished ---- */
function testBox(label, ip, done) {
  console.log("=== " + label + " (" + ip + ") ===\n");

  console.log("Step 1: Power check (/as/system/time)");
  getJSON(ip, "system/time", function(err, data) {
    if (err) { console.log("  FAIL: " + err.message); return done(); }
    console.log("  OK — UTC: " + data.utc + " (box is ON)");

    console.log("\nStep 2: Discover SkyPlay SOAP control path");
    discoverControlPath(ip, function(err, controlPath) {
      if (err) { console.log("  FAIL: " + err.message); return done(); }
      console.log("  OK — " + controlPath);

      console.log("\nStep 3: GetMediaInfo (current channel SID)");
      soap(ip, controlPath, "GetMediaInfo", function(err, xml) {
        if (err) { console.log("  FAIL: " + err.message); return done(); }
        var uriMatch = xml.match(/<CurrentURI>(.*?)<\/CurrentURI>/);
        var uri = uriMatch ? uriMatch[1] : "(not found)";
        console.log("  CurrentURI: " + uri);
        var hexMatch = uri.match(/xsi:\/\/([0-9a-fA-F]+)/);
        var sid = hexMatch ? parseInt(hexMatch[1], 16) : null;
        if (sid) console.log("  SID (decimal): " + sid);

        console.log("\nStep 4: Channel map (/as/services/4/1)");
        getJSON(ip, "services/4/1", function(err, data) {
          if (err) { console.log("  FAIL: " + err.message); return done(); }
          var services = (data && data.services) || [];
          console.log("  OK — " + services.length + " channels loaded");

          if (sid) {
            var ch = services.find(function(s) { return String(s.sid) === String(sid); });
            if (ch) {
              console.log("  Current channel: " + ch.c + " " + ch.t + " (SID " + sid + ")");
            } else {
              console.log("  SID " + sid + " not found in channel list");
            }
          } else {
            console.log("  (standby or no live channel)");
          }

          done();
        });
      });
    });
  });
}

/* ---- run main box then Mini ---- */
testBox("Sky Q Main", SKYQ_IP, function() {
  console.log("\n" + "─".repeat(50) + "\n");
  testBox("Sky Q Mini", MINI_IP, function() {
    console.log("\n=== All tests complete ===");
  });
});
