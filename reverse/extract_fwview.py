# 提取原版「固件升级」视图完整实现（FirmwareUpgradeView 及相关的 HTTPS 上传分支）。
# 找的是：上传请求的精确形态、httpsFlag 何时为真、cc:-1 的触发条件。
import re

SRC = r'C:\path\to\MegaRAC-Next\reverse\source.min.js'
OUT = r'C:\path\to\MegaRAC-Next\reverse\out_fwview.txt'
d = open(SRC, encoding='utf-8', errors='replace').read()

# 视图定义起点
starts = [m.start() for m in re.finditer(r'views/maintenance/FirmwareUpgradeView', d)]
print('视图定义处:', starts)
buf = []
for s in starts:
    # 找到该 define 块的结尾：下一个 o("views/ 或 o("models/ 或 1万字符
    nxt = d.find('o("views/', s + 10)
    if nxt < 0 or nxt - s > 40000:
        nxt = min(len(d), s + 40000)
    buf.append(d[s:nxt])

# HTTPS 上传分支：含 httpsInterval 的片段
for m in re.finditer(r'httpsInterval', d):
    s = max(0, m.start() - 800)
    e = min(len(d), m.start() + 2500)
    buf.append('\n\n===== httpsInterval @ %d =====\n' % m.start() + d[s:e])

# 是否有其它固件升级向导视图
for m in re.finditer(r'views/maintenance/[A-Za-z_]*[Ww]izard[A-Za-z_]*', d):
    buf.append('\n\n===== wizard 视图: %s @ %d =====\n' % (m.group(0), m.start()))
    s = m.start()
    nxt = d.find('o("views/', s + 10)
    if nxt < 0 or nxt - s > 40000:
        nxt = min(len(d), s + 40000)
    buf.append(d[s:nxt])

txt = '\n'.join(buf)
open(OUT, 'w', encoding='utf-8').write(txt)
print('已写出', OUT, '长度', len(txt))
