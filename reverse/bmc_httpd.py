#!/usr/bin/env python3
# 在 ESXi 上跑的固件 HTTP 服务器（ESXi 自带 Python 3.8，没有 Node）。
# 比 python3 -m http.server 多了三件事，都是为了给 BMC 拉镜像时少一个变量：
#   1. 支持 Range（BMC 若分块拉取，SimpleHTTP 会回整包把它搞乱）
#   2. 支持 HEAD
#   3. 每次请求写日志 —— 刷写期间 BMC 会重启失联，这份日志是唯一的现场证据
import http.server
import os
import socketserver
import sys
import time

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8899
ROOT = os.path.abspath(sys.argv[2] if len(sys.argv) > 2 else '/scratch/downloads')
LOG = '/tmp/bmc_httpd_access.log'


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    server_version = 'BMCFwServer/1.0'

    def log_message(self, fmt, *args):
        line = '[%s] %s %s\n' % (time.strftime('%Y-%m-%d %H:%M:%S'), self.address_string(), fmt % args)
        sys.stderr.write(line)
        sys.stderr.flush()
        try:
            with open(LOG, 'a') as f:
                f.write(line)
        except Exception:
            pass

    def _resolve(self):
        name = self.path.split('?')[0].lstrip('/')
        p = os.path.abspath(os.path.join(ROOT, name))
        if not p.startswith(ROOT):
            return None
        return p if os.path.isfile(p) else None

    def _head(self):
        p = self._resolve()
        t0 = time.time()
        if not p:
            self.send_error(404, 'not found')
            return None, None, None, None
        size = os.path.getsize(p)
        start, end, code = 0, size - 1, 200
        rng = self.headers.get('Range')
        if rng and rng.startswith('bytes='):
            spec = rng[6:].split(',')[0].strip()
            a, _, b = spec.partition('-')
            if a:
                start = int(a)
            if b:
                end = int(b)
            if not a and b:
                start = max(0, size - int(b))
                end = size - 1
            if start >= size or end < start:
                self.send_response(416)
                self.send_header('Content-Range', 'bytes */%d' % size)
                self.send_header('Content-Length', '0')
                self.end_headers()
                self.log_message('416 range=%s', rng)
                return None, None, None, None
            code = 206
            self.send_response(206)
            self.send_header('Content-Range', 'bytes %d-%d/%d' % (start, end, size))
        else:
            self.send_response(200)
        self.send_header('Content-Type', 'application/octet-stream')
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Content-Length', str(end - start + 1))
        self.send_header('Last-Modified', self.date_time_string(int(os.path.getmtime(p))))
        self.end_headers()
        return p, start, end, (code, t0, size)

    def do_HEAD(self):
        p, start, end, meta = self._head()
        if meta:
            self.log_message('HEAD -> %d  size=%d  ua=%s', meta[0], meta[2], self.headers.get('User-Agent'))

    def do_GET(self):
        p, start, end, meta = self._head()
        if not meta:
            return
        code, t0, size = meta
        sent = 0
        try:
            with open(p, 'rb') as f:
                f.seek(start)
                remain = end - start + 1
                while remain > 0:
                    chunk = f.read(min(262144, remain))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    sent += len(chunk)
                    remain -= len(chunk)
        except Exception as e:
            self.log_message('传输中断 sent=%d/%d err=%s', sent, end - start + 1, e)
            return
        self.log_message('GET -> %d  sent=%d/%d  用时%.1fs  ua=%s',
                         code, sent, end - start + 1, time.time() - t0, self.headers.get('User-Agent'))


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == '__main__':
    Server(('0.0.0.0', PORT), Handler).serve_forever()
