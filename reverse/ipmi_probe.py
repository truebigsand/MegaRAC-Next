# -*- coding: utf-8 -*-
"""只读的 IPMI over LAN 探测：确认能否绕过 web 会话表直接访问 BMC。"""
import sys, json
from pyghmi.ipmi import command

BMC = '192.168.0.200'
USER = 'admin'
PASS = 'REDACTED_BMC_PASSWORD'

try:
    c = command.Command(bmc=BMC, userid=USER, password=PASS, timeout=15)
    print('✓ IPMI 已连接')
    print('  mc:', json.dumps(c.get_inventory(dict={'system': 1}), ensure_ascii=False)[:300])
    print('  电源:', c.get_power())
except Exception as e:
    print('✗ IPMI 失败:', type(e).__name__, e)
    sys.exit(1)
