const fs = require('fs');
const s = fs.readFileSync('reverse/viewer.min.js', 'utf8');

function show(title, word, n = 2000, max = 1, back = 100) {
  console.log('\n========== ' + title + ' ==========');
  const out = [];
  let i = 0;
  while ((i = s.indexOf(word, i)) !== -1 && out.length < max) {
    out.push(s.slice(Math.max(0, i - back), i + n));
    i += word.length;
  }
  console.log(out.join('\n----\n') || '(未找到)');
}

// 尺寸常量
console.log('========== 尺寸/其他常量 ==========');
const reConst = /\b([A-Z][A-Z0-9_]{2,40})\s*[:=]\s*(\d{1,6})\b/g;
const wanted = /(SIZE|LENGTH|TOKEN|HASH|LEN|_IP|CHANNEL|TIMEOUT|INTERVAL|THRESHOLD|PORT)/;
const seen = new Map();
let m;
while ((m = reConst.exec(s))) {
  if (wanted.test(m[1]) && !seen.has(m[1])) seen.set(m[1], Number(m[2]));
}
for (const [k, v] of seen) console.log(`${k}=${v}`);

show('sendValidateVideoSessionPkt 全文', 'sendValidateVideoSessionPkt:function', 1800, 1);
show('kvm_token 来源', 'kvm_token=', 700, 3);
show('视频包解析 startRead', 'startRead:function', 3000, 1);
