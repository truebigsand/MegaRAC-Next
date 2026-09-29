# 提取技嘉官方 BMC 固件升级指南文本，搜索「配置保留 / 刷写方式 / Redfish」相关说明。
# 目的：确认本次刷写是否会清掉 BMC 配置（网络设置一旦丢，BMC 可能换 IP 失联）。
from pypdf import PdfReader
import re

r = PdfReader(r'C:\path\to\MegaRAC-Next\bmc_firmware\upgrade_guide.pdf')
pages = [(p.extract_text() or '') for p in r.pages]
t = '\n'.join(pages)
open(r'C:\path\to\MegaRAC-Next\reverse\out_guide.txt', 'w', encoding='utf-8').write(t)
print(f'页数={len(pages)} 字符={len(t)}')

KEYS = ['preserve', 'Preserve', 'retain', 'Retain', 'keep', 'Keep', 'default', 'Default',
        'Redfish', 'SimpleUpdate', 'reset', 'Reset', 'full flash', 'Full Flash', 'full_flash',
        'configuration', 'Configuration', 'preserv']
seen = set()
for k in KEYS:
    for m in re.finditer(re.escape(k), t):
        s = max(0, m.start() - 200)
        e = min(len(t), m.start() + 260)
        frag = re.sub(r'\s+', ' ', t[s:e])
        key = frag[:80]
        if key in seen:
            continue
        seen.add(key)
        print(f'\n[{k}] …{frag}…')
