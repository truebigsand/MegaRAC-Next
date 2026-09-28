const fs = require('fs');
const s = fs.readFileSync('reverse/viewer.min.js', 'utf8');

// List all short string literals mentioning kvm/video/cdrom/media/sol/floppy
const set = new Set();
const re = /["']([^"'\n]{0,120}(?:kvm|KVM|video|Video|cdrom|CDROM|media|MEDIA|sol|SOL|floppy|hdisk)[^"'\n]{0,120})["']/g;
let m;
while ((m = re.exec(s))) set.add(m[1]);
console.log('--- strings mentioning kvm/video/media/sol ---');
console.log([...set].sort().join('\n'));

// WebSocket constructions
console.log('\n--- WebSocket usages ---');
let i = 0;
let count = 0;
while ((i = s.indexOf('new WebSocket', i)) !== -1 && count < 10) {
  console.log('---');
  console.log(s.slice(Math.max(0, i - 500), i + 300));
  i += 5;
  count++;
}
