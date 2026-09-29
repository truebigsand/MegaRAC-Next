# -*- coding: utf-8 -*-
import urllib.parse
"""等 BMC 重启完成：轮询登录，成功后打印会话数并注销。"""
import json, time, sys, urllib.request, ssl

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

def post(path, data, cookie=None, csrf=None):
    req = urllib.request.Request('https://192.168.0.200' + path, data=data,
                                 method='POST' if data is not None else 'GET')
    req.add_header('content-type', 'application/x-www-form-urlencoded')
    if cookie: req.add_header('cookie', cookie)
    if csrf: req.add_header('x-csrftoken', csrf)
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=10) as r:
            return r.status, r.read().decode('utf8', 'ignore'), r.headers.get_all('Set-Cookie') or []
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode('utf8', 'ignore'), []
    except Exception as e:
        return None, str(e), []

deadline = time.time() + 300
while time.time() < deadline:
    status, text, cookies = post('/api/session',
        urllib.parse.urlencode({'username': 'admin', 'password': 'REDACTED_BMC_PASSWORD'}).encode())
    stamp = time.strftime('%H:%M:%S')
    if status == 200:
        data = json.loads(text)
        cookie = '; '.join(c.split(';')[0] for c in cookies)
        print(f'[{stamp}] ✓ BMC 已恢复，登录成功 racsession_id={data.get("racsession_id")}')
        st, lst, _ = post('/api/settings/service-sessions', None, cookie, data['CSRFToken'])
        try:
            arr = json.loads(lst)
            print(f'   当前会话数: {len(arr)}')
        except Exception:
            print('   会话列表读取:', st, lst[:80])
        st2, svc, _ = post('/api/settings/services', None, cookie, data['CSRFToken'])
        try:
            for s in json.loads(svc):
                print(f'   {s["service_name"]:9s} state={s["state"]} active={s["active_session"]}/{s["maximum_sessions"]}')
        except Exception:
            pass
        post('/api/session', b'', cookie, data['CSRFToken'])
        print('   （已注销本次登录）')
        sys.exit(0)
    print(f'[{stamp}] 未就绪: {status} {text[:60]}')
    time.sleep(12)
print('等待超时')
sys.exit(1)
