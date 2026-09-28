const fs = require('fs');
const s = fs.readFileSync('reverse/source.min.js', 'utf8');

function ctx(word, n = 1200, max = 2, back = 500) {
  const out = [];
  let i = 0;
  while ((i = s.indexOf(word, i)) !== -1 && out.length < max) {
    out.push(s.slice(Math.max(0, i - back), i + n));
    i += word.length;
  }
  return out.join('\n----\n');
}

console.log('=== fanprofile collection model (save protocol) ===');
console.log(ctx('fanprofile/collection', 1200, 2));
console.log('\n=== fanprofile play/apply (mode save) ===');
console.log(ctx('fanprofile_play', 900, 2));
console.log(ctx('FanProfilePlay', 700, 2));
