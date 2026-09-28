const fs = require('fs');
const viewer = fs.readFileSync('reverse/viewer.min.js', 'utf8');

function show(title, word, n = 1400, max = 3, back = 300) {
  console.log('\n========== ' + title + ' ==========');
  const out = [];
  let i = 0;
  while ((i = viewer.indexOf(word, i)) !== -1 && out.length < max) {
    out.push(viewer.slice(Math.max(0, i - back), i + n));
    i += word.length;
  }
  console.log(out.join('\n----\n') || '(未找到)');
}

// worker 创建方式（文件名/内联）
show('new Worker', 'new Worker', 600, 3);
show('decodeWorker 赋值', 'decodeWorker=', 800, 3);
// SESSION_INFO 写入方
show('SESSION_INFO 写入', 'SESSION_INFO"', 900, 3);
show('setItem(SESSION_INFO', 'setItem(_,', 600, 2);
// 视频解码帧头
show('currentFrameHeader 解析', 'currentFrameHeader=', 1800, 2, 100);
