# 修掉 docs/API.md 里的裸 NUL 字节：该处本意是描述「文件名 + NUL 终止符」，
# 应写成字面转义 \0，而裸 NUL 会让 git/grep 把整个文件当二进制处理。
from pathlib import Path

p = Path(__file__).resolve().parents[1] / 'docs' / 'API.md'
d = open(p, 'rb').read()
before = d.count(b'\x00')
d = d.replace(b'\x00', b'\\0')
open(p, 'wb').write(d)
after = open(p, 'rb').read().count(b'\x00')
print(f'替换前 NUL 数量={before}  替换后={after}')
i = d.find(b'DEVICE_INFO')
print('上下文:', d[i - 60:i + 140].decode('utf-8', 'replace'))
