const fs = require('fs');
const s = fs.readFileSync('reverse/viewer.min.js', 'utf8');

function ctx(word, n = 800, max = 3, back = 300) {
  const out = [];
  let i = 0;
  while ((i = s.indexOf(word, i)) !== -1 && out.length < max) {
    out.push(s.slice(Math.max(0, i - back), i + n));
    i += word.length;
  }
  return out.join('\n----\n');
}

console.log('=== createWebSocket ===');
console.log(ctx('createWebSocket', 700, 2));
console.log('\n=== "kvm" path or url build ===');
console.log(ctx('"/kvm"', 400, 2));
console.log(ctx("'/kvm'", 400, 2));
console.log('\n=== wss/https url build ===');
console.log(ctx('wss:', 400, 3));
