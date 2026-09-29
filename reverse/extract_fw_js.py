# 从 BMC 原版 source.min.js 里提取「固件升级」相关实现，弄清：
#   1) 上传请求的精确形态（字段名/头部/URL），因为经典路径上传一直被拒
#   2) flash-progress 的 state 取值含义
#   3) 响应里 cc 字段是什么
import re

SRC = r'C:\path\to\MegaRAC-Next\reverse\source.min.js'
OUT = r'C:\path\to\MegaRAC-Next\reverse\out_firmware_js.txt'
d = open(SRC, encoding='utf-8', errors='replace').read()
buf = []


def grab(pattern, label, before=400, after=1600, limit=6):
    buf.append('\n' + '=' * 30 + f' {label} ' + '=' * 30)
    for i, m in enumerate(re.finditer(pattern, d)):
        if i >= limit:
            buf.append(f'(...共 {len(re.findall(pattern, d))} 处，仅列前 {limit})')
            break
        s = max(0, m.start() - before)
        e = min(len(d), m.start() + after)
        buf.append(f'\n--- [{label}] 位置 {m.start()} ---')
        buf.append(d[s:e])


grab(r'/api/maintenance/firmware', 'maintenance/firmware 端点')
grab(r'flash-progress', 'flash-progress')
grab(r'fwimage', 'formData 字段 fwimage', 300, 900, 8)
grab(r'FormData', 'FormData 构造', 300, 900, 6)
grab(r'cc\s*[:=]\s*-1|\.cc\b', 'cc 字段', 300, 300, 6)
grab(r'preserve_config', 'preserve_config', 300, 600, 6)

open(OUT, 'w', encoding='utf-8').write('\n'.join(buf))
print('已写出', OUT, '总长', sum(len(x) for x in buf))
