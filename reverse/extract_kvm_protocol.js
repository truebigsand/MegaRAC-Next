// 提取 KVM 协议：命令常量、状态常量、createHeader、握手序列、帧解析
const fs = require('fs');
const s = fs.readFileSync('reverse/viewer.min.js', 'utf8');

function show(title, word, n = 1500, max = 1, back = 200) {
  console.log('\n========== ' + title + ' ==========');
  const out = [];
  let i = 0;
  while ((i = s.indexOf(word, i)) !== -1 && out.length < max) {
    out.push(s.slice(Math.max(0, i - back), i + n));
    i += word.length;
  }
  console.log(out.join('\n----\n') || '(未找到)');
}

// 1. 常量定义（形如 CMD_XXX=数字 或 CMD_XXX:数字）
const consts = new Map();
const reConst = /\b([A-Z][A-Z0-9_]{2,40})\s*[:=]\s*(\d{1,5})\b/g;
let m;
while ((m = reConst.exec(s))) {
  const key = m[1];
  if (!/^(CMD|STATUS|KVM|POWER|MEDIA|REC|SOL|USB|MOUSE|KEY|VIDEO|NOTIFICATION|SESSION|PACKET|REQ|RES)/.test(key)) continue;
  if (!consts.has(key)) consts.set(key, Number(m[2]));
}
console.log('========== 协议常量（' + consts.size + ' 个） ==========');
const grouped = {};
for (const [k, v] of consts) {
  const prefix = k.split('_')[0];
  (grouped[prefix] = grouped[prefix] || []).push(`${k}=${v}`);
}
for (const [p, list] of Object.entries(grouped)) {
  console.log(`\n-- ${p} --`);
  console.log(list.join('  '));
}

show('createHeader 实现', 'createHeader:function', 1200, 1);
show('握手：ws.onopen', 'ws.onopen=function', 1500, 1);
show('视频帧处理入口（onmessage 中的非文本分支）', 'onmessage=function', 2500, 1);
