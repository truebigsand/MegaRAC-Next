# -*- coding: utf-8 -*-
import os
"""通过 IPMI 冷重置 BMC：清空 web/媒体/KVM 会话表并重启各服务。
主机（及其上的虚拟机）不受影响——BMC 重启不等于主机重启。
之所以走 IPMI：web 会话表满时连登录都被拒，web 通道已无法自救。
"""
from pyghmi.ipmi import command
import time
# ⚠️ 需要 BMC 凭据：先设置环境变量 BMC_PASS 再运行

c = command.Command(bmc='192.168.0.200', userid='admin', password=os.environ.get('BMC_PASS', ''), timeout=20)
print('✓ IPMI 已连接，电源状态:', c.get_power())
print('→ 发送 BMC 冷重置…')
c.reset_bmc()
print('✓ 已发出重置命令')
