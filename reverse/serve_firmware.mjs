// 升级用一次性 HTTP 服务器：把 bmc_firmware/ 下的文件暴露给 BMC 拉取。
// BMC 通过 Redfish SimpleUpdate 的 ImageURI 来这里 GET 固件镜像。
// 用法: node reverse/serve_firmware.mjs [port] [rootDir]
// 关键点：支持 HEAD 与 Range（BMC 的 HTTP 客户端可能先探后拉或分段拉），并逐条记录请求，
//        因为升级期间 BMC 会重启、SSH/Web 全部失联，这一份日志是唯一的现场证据。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.argv[2] || 8899);
const ROOT = path.resolve(process.argv[3] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bmc_firmware'));

const TYPES = { '.bin': 'application/octet-stream', '.zip': 'application/zip', '.ima_enc': 'application/octet-stream', '.txt': 'text/plain; charset=utf-8' };

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const name = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.resolve(ROOT, name);
  const ua = req.headers['user-agent'] || '(无 UA)';
  const remote = req.socket.remoteAddress;
  log(`→ ${req.method} /${name} from ${remote} UA="${ua}" range=${req.headers.range || '-'}`);

  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end('forbidden');
    log('   ← 403 越界');
    return;
  }
  let st;
  try {
    st = fs.statSync(file);
    if (!st.isFile()) throw new Error('not a file');
  } catch (e) {
    res.writeHead(404).end('not found');
    log('   ← 404', e.message);
    return;
  }

  const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
  res.setHeader('Content-Type', type);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Last-Modified', st.mtime.toUTCString());

  let start = 0;
  let end = st.size - 1;
  let code = 200;
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m) {
      if (m[1]) start = Number(m[1]);
      if (m[2]) end = Number(m[2]);
      if (!m[1] && m[2]) {
        start = Math.max(0, st.size - Number(m[2]));
        end = st.size - 1;
      }
      if (start >= st.size || end < start) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }).end();
        log('   ← 416 range not satisfiable');
        return;
      }
      code = 206;
      res.setHeader('Content-Range', `bytes ${start}-${end}/${st.size}`);
    }
  }

  res.setHeader('Content-Length', end - start + 1);
  if (req.method === 'HEAD') {
    res.writeHead(code).end();
    log(`   ← ${code} HEAD 已回应，文件 ${st.size} 字节`);
    return;
  }

  let sent = 0;
  const t0 = Date.now();
  const stream = fs.createReadStream(file, { start, end });
  stream.on('data', (c) => {
    sent += c.length;
  });
  stream.on('error', (e) => {
    log('   ← 读取错误', e.message);
    res.destroy();
  });
  res.on('close', () => {
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const mbps = sent && secs > 0 ? (sent / 1048576 / Number(secs)).toFixed(1) : '0';
    log(`   ← ${code} 传输 ${sent}/${end - start + 1} 字节，用时 ${secs}s（${mbps} MB/s）${res.writableFinished ? '完整' : '⚠️ 被中断'}`);
  });
  stream.pipe(res);
});

server.on('clientError', (e, sock) => {
  log('clientError:', e.code || e.message);
  sock.destroy();
});

server.listen(PORT, '0.0.0.0', () => {
  log(`固件服务器已启动：http://0.0.0.0:${PORT}/  根目录 ${ROOT}`);
  log(`可用镜像: ${fs.readdirSync(ROOT).filter((f) => fs.statSync(path.join(ROOT, f)).isFile()).join(', ')}`);
});
