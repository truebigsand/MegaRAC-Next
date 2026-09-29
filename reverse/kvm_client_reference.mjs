// KVM 客户端参考实现（2026-09-29 实测跑通，成功收到视频流）
//
// 运行环境：BMC 同源的页面上下文（浏览器），可整段丢进 Playwright 的 page.evaluate。
// 之所以放浏览器：wss://<bmc>/kvm 用自签证书，Node 原生 WebSocket 会因证书校验失败（1006）。
// 移植到 Node 需用支持 rejectUnauthorized:false 的 WS 库（如 ws）或手写 TLS 升级。
//
// 流程（全部实测确认）：
//   1) POST /api/session 登录 → 取 CSRFToken
//   2) GET /api/settings/media/h5viewercfg → {token, session, client_ip, server_ip}
//   3) 连 wss://<bmc>/kvm，子协议 ["binary","base64"]
//   4) 收到 CMD_CONNECTION_ALLOWED(23) → 发
//        CMD_CONNECTION_COMPLETE_PKT(58) len=0 status=1   ← 缺这 8 字节会被判 INVALID_SESSION
//      + CMD_VALIDATE_VIDEO_SESSION(18) len=438 status=1
//        (u8(0) + token129 + client_ip65 + username129 + mac49 + server_ip65)
//      + CMD_RESUME_REDIRECTION(6) len=0 status=0
//   5) 收到 CMD_KVM_SHARING(32)：status 低字节=STATUS_KVM_PRIV_*、高字节=KVM_REQ_*
//      （2=PARTIAL 表示有别的会话占着 master）→ 回发同命令，
//      status = 1(REQ_MASTER) + (2(PARTIAL) << 8)，payload = 原样回发收到的载荷
//   6) 收到 CMD_MEDIA_LICENSE_STATUS(53) → 回
//        CMD_DISPLAY_LOCK_SET(51) payload=[2] ／ CMD_GET_USER_MACRO(40) ／
//        CMD_GET_WEB_TOKEN(21) payload=session（35 字符）
//   7) 之后进入 CMD_VIDEO_PACKETS(25)：每包 = 8 字节头 + 帧头(约 86B) + 压缩数据
//      ⚠️ 单个 WS 消息可能串接多个协议包 → 必须按 8+len 循环切分
//
// 包格式：cmd u16 LE @0 ｜ len u32 LE @2 ｜ status u16 LE @6 ｜ payload
 
export function kvmClientSnippet(cfg) {
  // cfg 取自 h5viewercfg：{ token, session, client_ip, server_ip }
  return new Promise((resolve) => {
    const out = { log: [], videoCount: 0, videoBytes: 0 };
    const enc = new TextEncoder();
    const cstr = (s, n) => { const b = new Uint8Array(n); b.set(enc.encode(s).subarray(0, n - 1)); return b; };
    const hdr = (cmd, len, st) => { const b = new Uint8Array(8); const dv = new DataView(b.buffer); dv.setUint16(0, cmd, true); dv.setUint32(2, len, true); dv.setUint16(6, st, true); return b; };
    const cat = (...a) => { const n = a.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(n); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };

    const ws = new WebSocket('wss://' + location.host + '/kvm', ['binary', 'base64']);
    ws.binaryType = 'arraybuffer';
    const timer = setInterval(() => { try { ws.send(hdr(57, 0, 0)); } catch {} }, 10000); // KEEP_ALIVE
    const t = setTimeout(() => { clearInterval(timer); try { ws.close(); } catch {} resolve(out); }, 30000);

    ws.onmessage = (ev) => {
      const buf = new Uint8Array(ev.data);
      for (let off = 0; off + 8 <= buf.length; ) {
        const cmd = buf[off] | (buf[off + 1] << 8);
        const len = buf[off + 2] | (buf[off + 3] << 8) | (buf[off + 4] << 16) | (buf[off + 5] << 24);
        const status = buf[off + 6] | (buf[off + 7] << 8);
        const payload = buf.subarray(off + 8, off + 8 + len);
        if (cmd === 25) { out.videoCount++; out.videoBytes += len; }
        else if (out.log.length < 40) out.log.push(`← cmd=${cmd} len=${len} status=${status}`);

        if (cmd === 23) { // CONNECTION_ALLOWED
          const p = cat(new Uint8Array([0]), cstr(cfg.token, 129), cstr(cfg.client_ip, 65), cstr('domain/username', 129), cstr('00-00-00-00-00-00', 49), cstr(cfg.server_ip, 65));
          ws.send(cat(hdr(58, 0, 1), hdr(18, p.length, 1), p, hdr(6, 0, 0)));
        } else if (cmd === 32) { // KVM_SHARING → 请求 master
          ws.send(cat(hdr(32, len, 1 + (2 << 8)), payload));
        } else if (cmd === 53) { // MEDIA_LICENSE_STATUS
          ws.send(cat(hdr(51, 1, 0), new Uint8Array([2])));
          ws.send(hdr(40, 0, 0));
          ws.send(cat(hdr(21, cfg.session.length, 0), enc.encode(cfg.session)));
        }
        off += 8 + len;
        if (len <= 0) break;
      }
    };
    ws.onclose = () => { clearInterval(timer); clearTimeout(t); resolve(out); };
    ws.onerror = () => out.log.push('error');
  });
}
