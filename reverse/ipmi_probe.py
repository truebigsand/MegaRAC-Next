# -*- coding: utf-8 -*-
import os
"""只读的 IPMI over LAN 探测：确认能否绕过 web 会话表直接访问 BMC。"""
import sys, json
from pyghmi.ipmi import command
# ⚠️ 需要 BMC 凭据：先设置环境变量 BMC_PASS 再运行

BMC = '192.168.0.200'
USER = 'admin'
PASS = os.environ.get('BMC_PASS', '')

try:
    c = command.Command(bmc=BMC, userid=USER, password=PASS, timeout=15)
    print('✓ IPMI 已连接')
    print('  mc:', json.dumps(c.get_inventory(dict={'system': 1}), ensure_ascii=False)[:300])
    print('  电源:', c.get_power())
except Exception as e:
    print('✗ IPMI 失败:', type(e).__name__, e)
    sys.exit(1)
