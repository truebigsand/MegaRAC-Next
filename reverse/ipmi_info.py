# -*- coding: utf-8 -*-
import os
"""只读：BMC 描述、电源、SEL 末尾若干条（看有没有 KVM 服务异常事件）。"""
from pyghmi.ipmi import command
# ⚠️ 需要 BMC 凭据：先设置环境变量 BMC_PASS 再运行

c = command.Command(bmc='192.168.0.200', userid='admin', password=os.environ.get('BMC_PASS', ''), timeout=15)
print('✓ IPMI 已连接')
d = c.get_description()
print('BMC:', d)
print('电源:', c.get_power())
try:
    entries = list(c.get_event_log(300))
    print(f'\nSEL 共 {len(entries)} 条，末 15 条：')
    for e in entries[-15:]:
        print('  ', e.get('date', ''), e.get('time', ''), (e.get('description') or '')[:110])
except Exception as ex:
    print('SEL 读取失败:', type(ex).__name__, ex)
