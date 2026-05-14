/* Quick test to verify the Gnome packet builder produces correct output.
   Run with: node test_packet.js
   
   This tests against the known example from the Sky Gnome protocol spec:
   https://www.heenan.me.uk/control-sky-from-pc/gnome-protocol.html
*/

// Inline the packet builder
var GnomePacket = {
  _subpacket: function(type, data) {
    var d = String(data || '');
    var len = String(7 + d.length).padStart(3, '0');
    return type + len + d;
  },
  _checksum: function(str) {
    var sum = 0;
    for (var i = 0; i < str.length; i++) sum += str.charCodeAt(i);
    return (sum & 0xff).toString(16).padStart(2, '0');
  },
  build: function(subpackets) {
    var body = '';
    for (var i = 0; i < subpackets.length; i++) {
      body += this._subpacket(subpackets[i].type, subpackets[i].data);
    }
    var totalLen = String(3 + body.length + 2).padStart(3, '0');
    var packetWithoutChecksum = '\x0a' + totalLen + body;
    var checksum = this._checksum(packetWithoutChecksum);
    return packetWithoutChecksum + checksum;
  }
};

console.log('=== Sky Gnome Packet Builder Test ===\n');

// Test 1: Known example from spec (pressing '1' key)
console.log('Test 1: Channel entry packet (CE00)');
var p1 = GnomePacket.build([{ type: 'CE00', data: '1--' }]);
var hex1 = Buffer.from(p1).toString('hex').match(/../g).join(' ');
var expected1 = '0a 30 31 35 43 45 30 30 30 31 30 31 2d 2d 61 34';
console.log('Built:    ' + hex1);
console.log('Expected: ' + expected1);
console.log('Match:    ' + (hex1 === expected1 ? 'PASS ✓' : 'FAIL ✗'));
console.log('');

// Test 2: Power state packet
console.log('Test 2: Power state packet (SYST)');
var p2 = GnomePacket.build([{ type: 'SYST', data: '0' }]);
var hex2 = Buffer.from(p2).toString('hex').match(/../g).join(' ');
console.log('Built:    ' + hex2);
console.log('Decoded:  LF + length=' + p2.charCodeAt(1) + p2.charCodeAt(2) + p2.charCodeAt(3) + ' + SYST001 + 0 + checksum=' + p2.slice(-2));
console.log('');

// Test 3: Now-playing packet (full 60s heartbeat)
console.log('Test 3: Now-playing packet (6 sub-packets)');
var p3 = GnomePacket.build([
  { type: 'SSCN', data: '270' },
  { type: 'SSCA', data: 'FX' },
  { type: 'SSDT', data: '2.06pm Sat 12 Nov' },
  { type: 'SST0', data: '2.00pm' },
  { type: 'SSN0', data: 'JAG' },
  { type: 'SSE0', data: 'Admiral Chegwidden and Clayton Webb make an unlikely team when they join forces to save a CIA agent from Italian terrorists. Starring: Catherine Bell.' }
]);
console.log('Length:   ' + p3.length + ' bytes');
console.log('Hex:      ' + Buffer.from(p3).toString('hex').substring(0, 60) + '...');
console.log('ASCII:    ' + p3.substring(0, 40).replace(/\x0a/g, '<LF>') + '...');

// Verify checksum manually
var withoutCs = p3.slice(0, -2);
var sum = 0;
for (var i = 0; i < withoutCs.length; i++) sum += withoutCs.charCodeAt(i);
var cs = (sum & 0xff).toString(16).toUpperCase().padStart(2,'0');
console.log('Checksum: ' + p3.slice(-2) + ' (calculated: ' + cs + ') ' + (cs === p3.slice(-2) ? 'PASS ✓' : 'FAIL ✗'));
console.log('');

console.log('=== All tests complete ===');
