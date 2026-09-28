// 1) 主 app 侧：KVM session_info / token 从哪来
// 2) viewer 侧：CMD_VIDEO_PACKETS 的解码路径
const fs = require('fs');
const main = fs.readFileSync('reverse/source.min.js', 'utf8');
const viewer = fs.readFileSync('reverse/viewer.min.js', 'utf8');

function show(src, title, word, n = 1200, max = 2, back = 300) {
  console.log('\n========== ' + title + ' ==========');
  const out = [];
  let i = 0;
  while ((i = src.indexOf(word, i)) !== -1 && out.length < max) {
    out.push(src.slice(Math.max(0, i - back), i + n));
    i += word.length;
  }
  console.log(out.join('\n----\n') || '(未找到)');
}

console.log('############### 主 app（source.min.js） ###############');
show(main, 'SESSION_INFO 定义/写入', 'SESSION_INFO', 900, 2);
show(main, 'KVM 启动时存 sessionStorage', 'updateStorage', 1200, 1);
show(main, 'kvm token 请求', 'kvm_access', 900, 3);
show(main, 'remote_control launch 相关', 'launch:', 900, 2);

console.log('\n############### viewer（viewer.min.js） ###############');
show(viewer, 'CMD_VIDEO_PACKETS 处理分支', 'CMD_VIDEO_PACKETS', 1500, 3, 400);
show(viewer, '视频解码入口 decode', 'decodeVideo', 1200, 2);
show(viewer, 'ImageData/putImageData 渲染', 'putImageData', 900, 2);
