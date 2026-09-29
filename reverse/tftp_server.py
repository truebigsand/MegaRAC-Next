#!/usr/bin/env python3
# 最小 TFTP 服务器（RFC 1350 + RFC 2348 blksize 协商）——让 BMC 把固件镜像拉过去。
# ESXi 自带 Python 3.8 但没有 TFTP 服务，所以自己写。
#
# 两个实测出来的坑：
#   1) **必须从监听端口（69）回包**。用临时端口（TFTP 标准允许、多数实现也接受）时，
#      这台 BMC 的客户端会把应答全部忽略 → 每个 RRQ 都卡在「块 1 无 ACK」。
#   2) 要用 blksize 协商：512 字节块传 66 MB 需要 12.9 万个块，BMC 侧会中途放弃重来。
#      BMC 自己会在 RRQ 里带 blksize=1024，按它给的值走。
# 单线程串行服务即可——同时只有一个客户端在传输。
import os
import socket
import struct
import sys
import time

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 69
ROOT = sys.argv[2] if len(sys.argv) > 2 else '/scratch/downloads'
LOG = '/tmp/tftp_access.log'
TIMEOUT = 4
RETRIES = 12


def log(msg):
    line = '[%s] %s\n' % (time.strftime('%Y-%m-%d %H:%M:%S'), msg)
    sys.stderr.write(line)
    sys.stderr.flush()
    try:
        with open(LOG, 'a') as f:
            f.write(line)
    except Exception:
        pass


def parse_rrq(data):
    parts = data[2:].split(b'\x00')
    if len(parts) < 2:
        return None, {}
    filename = parts[0].decode('utf-8', 'replace')
    opts = {}
    rest = parts[2:]
    for i in range(0, len(rest) - 1, 2):
        k = rest[i].decode('utf-8', 'replace').lower()
        v = rest[i + 1].decode('utf-8', 'replace')
        if k:
            opts[k] = v
    return filename, opts


def serve(sock, peer, filename, opts):
    """从监听 socket 回包，串行完成一次传输。"""
    path = os.path.abspath(os.path.join(ROOT, os.path.basename(filename)))
    if not path.startswith(os.path.abspath(ROOT)) or not os.path.isfile(path):
        sock.sendto(struct.pack('!HH', 5, 1) + b'File not found\x00', peer)
        log('RRQ %s from %s:%d → 文件不存在' % (filename, peer[0], peer[1]))
        return
    size = os.path.getsize(path)

    blksize = 512
    oack = []
    if 'blksize' in opts:
        try:
            blksize = max(8, min(int(opts['blksize']), 65464))
        except ValueError:
            blksize = 512
        oack += [b'blksize', str(blksize).encode()]
    if 'tsize' in opts:
        oack += [b'tsize', str(size).encode()]

    log('RRQ %s from %s:%d 大小=%d 选项=%s → blksize=%d（从 69 端口回包）'
        % (filename, peer[0], peer[1], size, opts or '(无)', blksize))

    t0 = time.time()
    if oack:
        pkt = struct.pack('!H', 6) + b'\x00'.join(oack) + b'\x00'
        got = False
        for _ in range(RETRIES):
            sock.sendto(pkt, peer)
            try:
                ack, ap = sock.recvfrom(4096)
            except socket.timeout:
                continue
            if len(ack) >= 4 and ack[0:2] == b'\x00\x04' and struct.unpack('!H', ack[2:4])[0] == 0:
                got = True
                break
        if not got:
            log('  ⚠ OACK 未被确认，退回 512 字节块重试')
            blksize = 512

    blk = 1
    sent_total = 0
    report = 0
    with open(path, 'rb') as f:
        while True:
            chunk = f.read(blksize)
            pkt = struct.pack('!HH', 3, blk) + chunk
            acked = False
            for _ in range(RETRIES):
                sock.sendto(pkt, peer)
                try:
                    ack, ap = sock.recvfrom(65536)
                except socket.timeout:
                    continue
                if len(ack) >= 4 and ack[0:2] == b'\x00\x04' and struct.unpack('!H', ack[2:4])[0] == blk:
                    acked = True
                    break
            if not acked:
                el = max(0.001, time.time() - t0)
                log('  ✗ 块 %d（块大小 %d）重传 %d 次无 ACK，放弃：已传 %d/%d 字节（%.0f%%），%.2f MB/s'
                    % (blk, blksize, RETRIES, sent_total, size, 100.0 * sent_total / size, sent_total / 1048576 / el))
                return
            sent_total += len(chunk)
            report += 1
            if report % 500 == 0:
                el = max(0.001, time.time() - t0)
                log('  进度 %d/%d（%.0f%%）%.2f MB/s' % (sent_total, size, 100.0 * sent_total / size, sent_total / 1048576 / el))
            if len(chunk) < blksize:
                el = max(0.001, time.time() - t0)
                log('  ✓ 传输完成：%d 字节 / %d 块，用时 %.1fs（%.2f MB/s）' % (sent_total, blk, el, sent_total / 1048576 / el))
                return
            blk = (blk + 1) & 0xFFFF
            if blk == 0:
                blk = 1


if __name__ == '__main__':
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(('0.0.0.0', PORT))
    log('TFTP 服务（69 端口回包版）已启动 UDP:%d 根目录=%s（文件：%s）'
        % (PORT, ROOT, ', '.join(sorted(os.listdir(ROOT)))))
    while True:
        try:
            data, peer = sock.recvfrom(4096)
        except Exception as e:
            log('recvfrom 异常 %s' % e)
            continue
        if len(data) < 2:
            continue
        opcode = struct.unpack('!H', data[0:2])[0]
        if opcode == 1:
            fn, opts = parse_rrq(data)
            serve(sock, peer, fn, opts)
        elif opcode == 5:
            log('来自 %s:%d 的 ERROR: %r' % (peer[0], peer[1], data[4:80]))
        elif opcode == 4:
            pass  # 迟到的 ACK，忽略（不再刷屏）
