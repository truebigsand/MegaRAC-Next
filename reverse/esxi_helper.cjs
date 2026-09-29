// ESXi 文件/命令助手（ESXi 的 SSH 只支持 keyboard-interactive，普通 ssh2 密码认证会失败）。
// 用法:
//   ESXI_PASS=... node reverse/esxi_helper.cjs exec "df -h"
//   ESXI_PASS=... node reverse/esxi_helper.cjs put  <本地文件> <远端路径>
//   ESXI_PASS=... node reverse/esxi_helper.cjs get  <远端文件> <本地路径>
// 环境变量: ESXI_HOST(默认 192.168.0.201) ESXI_USER(默认 root) ESXI_PASS
const path = require('node:path');
const { Client } = require('ssh2');
const fs = require('node:fs');

const HOST = process.env.ESXI_HOST || '192.168.0.201';
const USER = process.env.ESXI_USER || 'root';
const PASS = process.env.ESXI_PASS || '';
const [action, ...rest] = process.argv.slice(2);

if (!PASS) {
  console.error('缺少 ESXI_PASS 环境变量');
  process.exit(1);
}

const conn = new Client();
const ready = new Promise((res, rej) => {
  conn.on('ready', res);
  conn.on('error', rej);
});
conn.on('keyboard-interactive', (n, i, l, prompts, finish) => finish([PASS]));
conn.connect({ host: HOST, port: 22, username: USER, password: PASS, tryKeyboard: true, readyTimeout: 25000, keepaliveInterval: 5000 });

const runExec = (cmd) =>
  new Promise((res, rej) => {
    let out = '';
    conn.exec(cmd, (err, stream) => {
      if (err) return rej(err);
      stream
        .on('close', (code) => res({ code, out }))
        .on('data', (d) => (out += d.toString()))
        .stderr.on('data', (d) => (out += d.toString()));
    });
  });

const runSftp = (op) =>
  new Promise((res, rej) => {
    conn.sftp((err, sftp) => {
      if (err) return rej(err);
      op(sftp, res, rej);
    });
  });

const main = async () => {
try {
  await ready;
  if (action === 'exec') {
    const r = await runExec(rest.join(' '));
    process.stdout.write(r.out);
    console.log(`\n[exit=${r.code}]`);
  } else if (action === 'put') {
    const [local, remote] = rest;
    let st;
    try {
      st = fs.statSync(local);
    } catch (e) {
      console.error(`本地文件不可读: ${local} → ${e.message}`);
      process.exit(3);
    }
    console.log(`本地确认: ${local} = ${st.size} 字节 → 目标 ${remote}`);
    const t0 = Date.now();
    await runSftp((sftp, res, rej) => {
      sftp.fastPut(local, remote, { concurrency: 16, chunkSize: 32768 }, (e) => (e ? rej(new Error(`SFTP: ${e.message} (code=${e.code})`)) : res()));
    });
    const secs = (Date.now() - t0) / 1000;
    console.log(`已上传 ${local} → ${remote}（${st.size} 字节，${secs.toFixed(1)}s，${(st.size / 1048576 / secs).toFixed(1)} MB/s）`);
    const r = await runExec(`ls -l "${remote}" && md5sum "${remote}"`);
    process.stdout.write(r.out);
  } else if (action === 'get') {
    const [remote, local] = rest;
    await runSftp((sftp, res, rej) => {
      sftp.fastGet(remote, local, { concurrency: 16, chunkSize: 32768 }, (e) => (e ? rej(e) : res()));
    });
    console.log(`已下载 ${remote} → ${local}`);
  } else {
    console.error('未知动作，用 exec / put / get');
    process.exit(2);
  }
  conn.end();
  process.exit(0);
} catch (e) {
  console.error('失败:', e.message);
  conn.end();
  process.exit(1);
}
};

main();
