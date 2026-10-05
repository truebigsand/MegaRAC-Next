# Gigabyte MZ32-AR0 BMC（AMI MegaRAC SP-X 12.41.11）Web API 逆向文档

> 逆向对象：`https://192.168.0.200`（技嘉 MZ32-AR0-00 / EPYC 7R32 的 BMC）
> 固件：AMI MegaRAC SP-X "Scorpio"，Web 显示 12.41.11（fw-info 报 12.65，IPMI rev 12/65），构建日期 Mar 20 2020
> 逆向方法：前端 bundle 静态分析（`reverse/source.min.js`、`reverse/viewer.min.js`）+ Playwright 页面走查 + 只读 API 实测（`reverse/probe_api.mjs` 抓样本；样本与摘录都是产物，不入库）
> **纪律**：本文档数据端点均为 GET 实测；写操作协议在 2026-09-28 后逐步实测（风扇档案写入/切换已验证，见 §3），未验证者标注【未实测】。

---

## 0. 会话与认证

### 登录 `POST /api/session`
- Content-Type: `application/x-www-form-urlencoded`，body: `username=admin&password=<URL编码后的密码>`
- ⚠️ 密码中的特殊字符必须 URL 编码：`#` → `%23`，`$` → `%24`
- 成功响应（`ok: 0` 即成功，非 0 为失败）：

```json
{
  "ok": 0,
  "privilege": 4,            // 4 = Administrator（1=User 2=Operator 3=OEM? 4=Administrator）
  "extendedpriv": 259,
  "racsession_id": 7,        // BMC 会话 ID
  "remote_addr": "192.168.0.101",
  "server_name": "192.168.0.200",
  "server_addr": "192.168.0.200",
  "HTTPSEnabled": 1,
  "CSRFToken": "V4xZ0x5v",   // 后续所有请求都要带
  "channel": 1,
  "passwordStatus": 0        // 1 = 密码已过期/必须修改（前端会强制进改密流程）
}
```

- 后续所有请求带请求头 `x-csrftoken: <CSRFToken>`（原版前端通过 `jQuery.ajaxSetup` 全局注入，并写入 `sessionStorage.garc`）
- 登录成功还会 `Set-Cookie`（原版还会设 `refresh_disable=1` cookie）
- **注销**：`DELETE /api/session`（带 csrf 头）
- **改密**【未实测】：`POST /api/updatenew_password`、`POST /api/reset-pass`（bundle 中存在）

### ⚠️ 会话限制（实测关键结论）
- `/api/settings/services` 实测显示 web 服务 `maximum_sessions: 148, active_session: 131`、kvm `128/130`、cd-media `129/129` —— **BMC 会话表长期处于接近满的状态**（历史泄漏会话释放极慢，十几分钟以上）。
- 这解释了"开几个会话就 403/返回 HTML"的现象。
- **新代理的铁律**：整个代理生命周期只维持 1 个 BMC 会话，所有浏览器请求多路复用；注销时必须 `DELETE /api/session`；403 时退避等待而不是重开新会话。

---

## 1. 仪表盘 / 监控

| 端点 | 方法 | 说明 | 实测 |
|---|---|---|---|
| `/api/chassis-status` | GET | 电源状态与 LED | ✅ `{"power_status":1,"led_status":0}` |
| `/api/sensors` | GET | 全部传感器 | ✅ 数组，见下 |
| `/api/detail_sensors_readings` | GET | 同 sensors（原版"详细读数"页用） | ✅ |
| `/api/sdr` | GET | 原始 SDR 记录（hex 数组） | ✅ |
| `/api/status/uptime` | GET | POH 开机时长 | ✅ `{"minutes_per_count":60,"poh_counter_reading":2437}` |
| `/api/firmware-info` | GET | 固件版本 | ✅ `{"fw_ver":"12.41.11",...,"active_image":0}` |
| `/api/settings/date-time` | GET | 时间/NTP 配置 | ✅ `{"primary_ntp":"pool.ntp.org","ntp_auto_date":2,"timezone":"Etc/GMT",...}` |
| `/api/configuration/project` | GET | 固件特性开关列表 | ✅ `[{feature:"NWLINK"},...]` |
| `/api/configuration/runtime` | GET | 运行时特性 | ✅ `[{feature:"LDAP",enabled:0},...]` |
| `/api/oem/node_info` | GET | 节点信息 | ❌ 500（本构建不支持） |
| `/api/dcmi/power` | GET | DCMI 功耗 | ✅ 全 0（ATX 电源无 PMBus，误报非故障） |

### 传感器条目结构（`/api/sensors`）
```json
{
  "id": 1, "sensor_number": 1, "name": "CPU0_TEMP",
  "owner_id": 32, "owner_lun": 0,
  "raw_reading": 31, "reading": 31,          // 当前读数
  "type": "temperature", "type_number": 1,   // 类型字符串+数字
  "sensor_state": 1, "discrete_state": 0,
  "accessible": 0, "settable_flag": 6939,
  "lower_non_recoverable_threshold": "NA",   // 阈值，无则 "NA"
  "lower_critical_threshold": 0, "lower_non_critical_threshold": 5,
  "higher_non_critical_threshold": 97, "higher_critical_threshold": 100,
  "higher_non_recoverable_threshold": "NA",
  "unit": "deg_c"                            // deg_c / RPM / Volts 等
}
```
实测传感器清单：CPU0_TEMP(31°C)、CPU0_DTS(69°C)、DIMMG0/G1_TEMP、MB_TEMP1/2、PSU 输入输出电压（全 0，Health=Fail 系 ATX 电源误报）、CPU0_FAN(~2250RPM)、SYS_FAN1-4(900-1050RPM)、12V/5V/3.3V 等。

原版仪表盘轮询节奏：`/api/sensors` + `/api/chassis-status` 数秒一拍，另轮询 `/api/logs/event?LASTEVENTID=<最大ID>` 做增量事件。

---

## 2. 电源控制【写操作，全部未实测】

Bundle 中 `models/chassis_status`：
- **`POST /api/actions/power`**，Content-Type: `application/json`，body：`{"power_command": <n>}`
  - `0` = 关闭电源（Power Off）
  - `1` = 开启电源（Power On）——主机已上电时 BMC 会禁用此项
  - `2` = 电源循环（Power Cycle）——"已上电但没起来"时用这个
  - `3` = 硬重启（Hard Reset）
  - `5` = ACPI 关闭（Soft Off）
- **`POST /api/actions/chassis-led`**，body：`{"blink_time": <n>, "force_on": <0|1>}`（识别灯）
- 原版 UI 提交前有确认弹窗。

---

## 3. 风扇控制（技嘉 OEM 风扇设定）★ 本项目重点

### 数据端点（GET 已实测）
| 端点 | 说明 |
|---|---|
| `/api/settings/fanprofile/mode` | 当前运行的 profile 名：`{"strMode":"default"}` |
| `/api/settings/fanprofile/collection` | 全部 profile 及策略（曲线本体） |
| `/api/settings/fanprofile/device_define/collection` | PCIe 设备库（NVIDIA/AMD 显卡 VendorID/DeviceID 表，用于"插卡时调速"条件） |

### 曲线结构（实测 `collection`）
```json
[{
  "strVersion": "1.00",
  "strName": "default",
  "arrPolicy": [{
    "iPolicyType": 2,             // 策略类型（2=温度传感型）
    "iInSDR": 1,
    "iSensorCode": 1,             // Sensor Type 编码
    "iInitDuty": 30,              // 初始 Duty (%)
    "iCpuTdp": 0,                 // 执行条件：CPU TDP (W)，0=不启用
    "iAmbientSensor": 0,          // 执行条件：环境温度传感器，0=N/A
    "iAmbientSensorTemp": 0,
    "arrSensor": [12],            // 源传感器 id 列表（12=CPU0_DTS）
    "arrFanSensor": [184,186,187,188,189,190],  // 被控风扇 sensor_number（CPU0_FAN+SYS_FAN1~5）
    "arrRef":  [43, 30, 20, 7],   // 曲线参考点（Slope 算法）
    "arrDuty": [30, 75, 90, 100]  // 对应 Duty (%)
  }]
}]
```

### 原版编辑页字段语义（`#/fan_profile/edit/default` 只读查看）
- Policy（策略编号，可多条）、Algorithm = **Slope**、Sensor Type = 温度
- Initialize Duty（初始占空比）
- **Sensor**（多选温度源，实测选中 CPU0_DTS）
- **Fan**（多选被控风扇：CPU0_FAN、SYS_FAN1~5，全部选中）
- Policy Execute Condition：CPU Tdp (W) / Ambient Sensor / PCIE Device（设备库 device_define）
- Policy Reference Table：**Reference ↔ Duty (%) 四组点对**（43→30%、30→75%、20→90%、7→100%）
- 页面还有：新增/编辑/复制/删除 profile、播放（应用）/停止、**导入/导出配置文件**、"支持PCIE设备"开关

### ✅ 写协议（2026-09-28 实测验证通过）

```
新建档案: POST /api/settings/fanprofile/collection
          body = 单个档案对象（含 strVersion/strName/arrPolicy[]），HTTP 200 返回写入后的对象
          ⚠️ 仅创建：名称已存在时返回 500 {"error":"Request Create FanProFile Name Already Exist","code":1010}
更新档案: PUT /api/settings/fanprofile/collection/<名称>
          body = 完整档案对象，HTTP 200 返回更新后的对象（实测改动生效）
          ⚠️ PUT 到集合路径（无名称）返回 404 Invalid API Call
删除档案: DELETE /api/settings/fanprofile/collection/<名称>，HTTP 200 {}
切换运行: POST /api/settings/fanprofile/mode
          body = {"strMode":"<档案名>"}，HTTP 200 返回 {"strMode":"<档案名>"}
停止/回退: 同上传 strMode:"default"
```
实测记录：POST 创建 `CPU_TEMP`/`ZZ_TEST_UI` 均 200；重复 POST 同名复现 500 重名错误；PUT `<名称>` 修改 iInitDuty 33→35 并回读确认生效；DELETE 后档案从列表消失。风扇转速按新档案生效（30 秒观察稳定）。
备份：写入前的档案与运行模式已存 `reverse/profiles/backup-*.json`；协议验证脚本 `reverse/verify_profile_update.mjs`。

### 算法字段 iPolicyType（Step / Slope）

原版 UI 的 Algorithm 下拉框只有两项，绑定到档案字段 `iPolicyType`：

| 值 | 名称 | 含义 |
|---|---|---|
| 1 | Step | 阶梯：读数在参考点之间时保持前一参考点的占空比 |
| 2 | **Slope** | 相邻参考点之间按斜率**线性插值**，超出两端钳位 |

- 本机全部档案（default / CPU_TEMP / MAX / MIN / BOX_MAX）均为 **2 = Slope**
- 实测（三次，均为 Slope 档案）：读数 68 落在参考点 30~70 之间时，占空比随读数连续变化，
  排除了 Step 的保持行为 → 与 Slope 命名一致
- ⚠️ 严格来说，"恰好是直线"由"命名 + 唯一替代算法是 Step"推出，未逐点标定验证曲线精确形状；
  如需确认可做标定实验（用若干恒定占空比档案标定 duty→RPM，再在 t≈0.25 处测一条曲线反推占空比）

### 多源传感器合并规则（2026-09-29 实测）

策略的 `arrSensor` 是数组，原版 UI 也是多选（`<select multiple="multiple">`）。实测确定**固件取读数最大的那个传感器**（与数组顺序无关）：

| 实验 | arrSensor | 曲线 | 结果 |
|---|---|---|---|
| A | `[1, 12]` = CPU0_TEMP(32) + CPU0_DTS(68) | 30→50% / 70→100% | CPU0_FAN 4950 RPM → 对应读 68 的 96% 档 |
| B | `[12, 1]`（顺序对调） | 30→10% / 70→90% | 4650 RPM → 仍是读 68 的高档 |
| C | `[1, 12]` | 30→10% / 70→100% | 4950 RPM → 仍是读 68 的高档 |

即使 CPU0_TEMP 排在第一位、其读数只对应 14%~54% 档，风扇也按 DTS 的 68 取值 → **取最大读数，不是取第一个**；
也排除了"取平均"（平均 50 应对应中档 ≈3300 RPM）。
参考：本机同一风扇 1% 占空比 ≈1950 RPM、30% ≈2250、86% ≈4650、96% ≈4950。

⚠️ 注意：DTS 是"距临界温度的余量"（越小越热），所以把 **DTS 与普通温度传感器混选**时，"取最大读数"反而会取到更凉的那一路。
同一策略内建议只用同一类传感器。

实验脚本：`reverse/test_multi_sensor_rule{,2,3}.mjs`（均带 finally 恢复原档案 + 删除测试档案）。

### 观察到的其他行为

- **SYS 风扇（3 脚，无 PWM 线）对占空比跟随很弱**：实验中 CPU0_FAN 从 1950 升到 4950 RPM，而 SYS_FAN1 始终 900 RPM；
  历史上不同档案间只见到 900 ↔ 1050 的小幅变化。占空比基本只对 4 脚的 CPU 风扇有明显作用。
- 切换运行档案后风扇约 5~15 秒内响应；曾遇到一次"创建+应用后 40 秒内未生效"的情形（重新应用后立即生效），
  排除该情形后三次实验结论一致。

### DTS ↔ CPU_TEMP 等效换算（实测）

- `CPU0_DTS` 是 AMD 温度余量（= 临界温度 100°C − CPU 实际温度），越小越热；60/60 组历史采样验证 **CPU0_TEMP + CPU0_DTS ≡ 100**
- 因此 default 档案曲线 `[43,30,20,7]` 在 CPU_TEMP 坐标下等效于 `[57,70,80,93]`，Duty `[30,75,90,100]` 不变
- `arrSensor` 用 **sensor_number**：CPU0_TEMP=1、CPU0_DTS=12；被控风扇 `arrFanSensor`=[184,186,187,188,189,190]（CPU0_FAN+SYS_FAN1~5）
- 曲线数组按「冷端→热端」排列（default 用 DTS 时因余量递减而呈降序；换 CPU_TEMP 后为升序），读值超出两端时钳位到端点对应 Duty

### 已知坑
- SMASH CLI 的 `set` 对风扇目标各种写法报语法错误 → 曲线只能在 Web API 层做（本项目的核心价值点）
- 原版编辑页即曲线编辑器，但极其简陋、无实时预览 → 新 UI 提供现代曲线编辑器 + 实时读数叠加

---

## 4. 日志

| 端点 | 说明 | 实测 |
|---|---|---|
| `/api/logs/event` | IPMI/SEL 全量事件 | ✅（数组，含 timestamp/sensor_name/description 等） |
| `/api/logs/event?LASTEVENTID=<n>` | 增量：只返回 id > n 的事件 | ✅ `[]`（无新事件时为空数组） |
| `/api/logs/dashboardevent` | 仪表盘摘要事件 | ✅ |
| `/api/logs/audit` | 审计日志 | ✅（dashboard 也拉它计"存取日志"数） |
| `/api/logs/system`、`/api/logs/video` | 系统/视频日志 | 【端点在 bundle 中，未逐一实测】 |
| `/api/logs/event-file` 等 `-file` 后缀 | 对应日志文件下载 | 【未实测】 |
| `/api/logs/video-log/delete`【写】 | 删除视频记录 | — |
| SEL 状态 | 实测 SEL 已满（1022 条），清除操作【未实测、不打算测】 | — |

---

## 5. 硬件清单（技嘉定制 `system_inventory_gbt` + IPMI host_interface）

全部 GET 实测 200：
`/api/system_inventory_gbt/`：`bios_info`、`cpu_info`、`dimm_info`、`dimm_info_ex`、`hdd_info`、`nic_info`、`pci_info`、`cpld_info`、`cmc_ip`、`smbios-file`、`bios-setup-file`
`/api/host_inventory/host_interface_*`：`system_info`、`thermal_info`、`processor_info`、`memory_info`、`power_info`、`storage_info`、`baseboard_info`、`pcie_device_function_info`

页面路由：`#system_inventory_info`（系统）、`#CPU_inventory_info`、`#DIMM_inventory_info`、`#PCI_inventory_info`、`#HDD_inventory_info`、`#NIC_inventory_info`。

---

## 6. 设置类

### 已实测（GET 200）
| 端点 | 说明 |
|---|---|
| `/api/settings/network` | 网卡数组（bond0/ch1、IPv4 静态 192.168.0.200/24 gw .1、IPv6 DHCP 开、MAC） |
| `/api/settings/network-link` | 链路状态 |
| `/api/settings/users` | 用户数组（anonymous id=1 无权限；admin id=2 administrator；含 kvm/vmedia/snmp 权限位、ssh_key、creation_time） |
| `/api/settings/date-time` | 时区/NTP |
| `/api/settings/services` | 服务清单：web/kvm/cd-media/hd-media/ssh…（含端口号、会话上限/当前数） |
| `/api/settings/media/general` | 媒体重定向全局设置 |
| `/api/settings/mouse` | KVM 鼠标模式设置 |
| `/api/settings/ssl/certificate-info` | HTTPS 证书信息 |
| `/api/fru` 与 `/api/settings/fru` | FRU 内容（BMC_FRU 设备：chassis/board/product 三区，含型号与序列号） |

### 设置页写端点【全部未实测，仅 bundle 逆向】
- 网络：`POST/PUT /api/settings/network`、`network-bond`、`network/activelancfg`、`settings/dns*`、`settings/static-ipv6`、`settings/ncsi*`
- 用户：`POST /api/settings/users`、`PUT /api/settings/users/:id`、`users_read_only`、`user/ssh-key-upload/:id`、`user-preference`
- 时间：`PUT /api/settings/date-time`
- 其他：`services`、`smtp`、`ldap-settings`、`active-directory-settings`、`radius/*`、`pef/*`、`firewall*`、`ssl/certificate`(+`generate`)、`log-policy`、`pam-order`、`sensor-threshold`、`license(s)`
- 维护【高危，v1 不做】：`/api/maintenance/*`（firmware/upgrade、reset、restore_defaults、backup/restore_config 等）

---

## 7. 远程控制 / KVM / 虚拟介质（传输层结论）

### HTML5 KVM（viewer.html + viewer.min.js）—— 2026-09-29 实测更新

**启动链路（已实测）**
1. `POST /api/session` 登录（拿 CSRFToken）
2. 取会话与 KVM 令牌（二选一，字段以 h5viewercfg 最全）：
   - `GET /api/settings/media/h5viewercfg` → `{token, session, client_ip, server_ip, kvm_service_status, num_cd/hd, ...}`
   - `GET /api/kvm/token` → `{client_ip, token, session}`（给 JNLP 路径用，token 与上者不同）
   - token 每次请求新发（实测两次调用值不同）；`session` 是 35 字符的 web 会话串
3. `GET /api/settings/media/adviser` → `{kvm_port:80, web_port:443, singleport_status:1, mouse_mode:2, retry_count:3, ...}`
   （single port 模式下 KVM 走 443 的 `/kvm` 路径，不单独开端口）
4. 打开 `wss://<bmc>/kvm`，子协议 `["binary","base64"]`（服务器选 `binary`）

**包格式（⚠️ 长度字段在偏移 2，很容易写错）**
```
偏移 0: u16 LE  cmd
偏移 2: u32 LE  len      ← 不是偏移 4！
偏移 6: u16 LE  status
偏移 8: len 字节 payload
```

**⚠️ 关键：校验消息前必须先写一个 `CMD_CONNECTION_COMPLETE_PKT(58) len=0 status=1` 头**
（原版源码：`if (1 == window.reconnect_enabled) { u.writeUint16(CMD_CONNECTION_COMPLETE_PKT); u.writeUint32(0); u.writeUint16(1); }`；
本机 `features` 含 `KVM_SESSION_RECONNECT`，故原版**每次都会**带这个 8 字节头）。
此前自建连接固定得到 `status=0(INVALID_SESSION)`，根因就是漏了它 —— 补上后服务器不再拒绝 ✓

**原版 viewer 实际发送的握手（Playwright 抓包，462 字节，逐字节核对）**
```
3a00000000000100            ← CMD_CONNECTION_COMPLETE_PKT(58) len=0 status=1
1200b60100000100            ← CMD_VALIDATE_VIDEO_SESSION(18) len=438 status=1
00 <token 129B> <client_ip 65B> <"domain/username" 129B> <"00-00-00-00-00-00" 49B> <server_ip 65B>
0600 00000000 0000          ← CMD_RESUME_REDIRECTION(6) len=0 status=0
```
随后（同一会话内）依次发送：
`CMD_DISPLAY_LOCK_SET(51) payload=[2]`、`CMD_GET_USER_MACRO(40)`、
**`CMD_GET_WEB_TOKEN(21) len=35 payload=session`**（35 字符 web 会话串）、
`CMD_POWER_STATUS(34)`、`CMD_GET_FULL_SCREEN(11) status=1`

**服务器响应序列（实测）**
```
CMD_CONNECTION_ALLOWED(23) len=0 status=2          ← 连接后立即主动发
CMD_VALIDATED_VIDEO_SESSION(19) len=2 status=2     ← 校验通过（status 2 表示部分权限/共存）
CMD_KVM_SHARING(32) len=134 status=2               ← 有其它 KVM 会话时：KVM_REQ_PARTIAL，载荷=对方会话信息
CMD_MEDIA_LICENSE_STATUS(53) / DISPLAY_CONTROL_STATUS(52) / GET_KBD_LED_STATUS(20) …
CMD_VIDEO_PACKETS(25)                              ← 首个视频包 len≈30002（1024x768）
CMD_KVM_MEDIA_INFO(38) / ACTIVE_CLIENTS(39) …
```
⚠️ 一个 WS 消息里可能**串接多个协议包**，解析必须按 `8+len` 循环切分（首次实测视频包被拆在 39793 字节的消息里）

**主从协商（CMD_KVM_SHARING）**
- `status` 低字节 = `STATUS_KVM_PRIV_*`（0 取消 / 1 请求 master / 2 等待 slave / 6 切换 master …），
  高字节 = `KVM_REQ_*`（0 ALLOWED / 1 DENIED / 2 PARTIAL / 3 TIMEOUT / 6 BLOCKED_PARTIAL …）
- 客户端把服务器 sharing 包的载荷 `btoa` 后存进 `sessionStorage.other_session_info`；
  请求完整权限时回发 `CMD_KVM_SHARING`，`status = STATUS_KVM_PRIV_REQ_MASTER + (KVM_REQ_PARTIAL << 8)`，
  payload = `atob(other_session_info)`
- 原版界面此时显示「请求完整访问」按钮（可在 viewer 工具栏看到，实测存在 ✓）

**✅ 端到端跑通（2026-09-29）**：按下面时序实现的自建客户端已成功收到视频流
（4 个 `CMD_VIDEO_PACKETS` 共 129718 字节，首包 30002 字节，1024x768）。
参考实现：`reverse/kvm_client_reference.mjs`（浏览器上下文运行；Node 原生 WebSocket 因自签证书会 1006，
移植需用 `ws` 之类的库或手写 TLS 升级）。
完整握手顺序：登录 → h5viewercfg → CONN_ALLOWED → CONN_COMPLETE+VALIDATE →
**KVM_SHARING(收到即回请求 master)** → VALIDATED(19) status=0 → MEDIA_LICENSE_STATUS(53)
（回 DISPLAY_LOCK_SET/GET_USER_MACRO/GET_WEB_TOKEN）→ KEEP_ALIVE(57) 定时保活 → 视频流。
注意 `status=0` 在 VALIDATED 上表示"已通过"（与原版一致），与内嵌枚举里的 `INVALID_SESSION` 同名但语义不同。

**握手时序（已实测：结构被服务器接受）**
1. 连接后服务器**主动**发 `CMD_CONNECTION_ALLOWED(23) len=0 status=2`
   （status 2 = `STATUS_FIRST_KVM_SESSION`）
2. 客户端发校验包（同一条 WS 消息里连续两段）：
   - `CMD_VALIDATE_VIDEO_SESSION(18) len=438 status=1`，payload =
     `u8(0)` + `CString(token,129)` + `CString(client_ip,65)` + `CString(username,129)`
     + `CString(mac,49)` + `CString(server_ip,65)`（CString 为 UTF-8 + 补零到指定长度）
   - 紧跟 `CMD_RESUME_REDIRECTION(6) len=0 status=0`
   - username/mac 用原版回退值 `domain/username`、`00-00-00-00-00-00`
     （`window.LOCAL_USERNAME/LOCAL_MAC` 在整份 bundle 里只读不写）
3. 服务器回 `CMD_VALIDATED_VIDEO_SESSION(19) len=1 status=…`：
   `0=INVALID_SESSION / 1=VALID_SESSION / 2=NOT_SUFFICIENT_PRIV / 3=INVALID_SESSION_INFO / 8=SESSION_UNREGISTERED`
   ⚠️ **我们自建连接的尝试均得到 status=0（INVALID_SESSION）**：包结构已被正确解析（服务器有回应），
   但会话关联未被接受。已排除：token 来源（h5viewercfg 与 /api/kvm/token 两者都试）、同源/同会话
   （在同一页面会话内登录→取 token→建 WS）、OEM 握手（本固件 OEM 钩子全是桩 `isOEMCommand(){return !1}`）、
   client_ip/username/mac 取值。**已解决**：Playwright 抓到原版握手原始字节（`reverse/kvm_capture_reference.txt`）
   逐字节核对后定位到缺 `CMD_CONNECTION_COMPLETE_PKT` 头（见上一节）
4. 校验通过后的流程（来自 viewer.min.js）：服务器发 `CMD_MEDIA_LICENSE_STATUS(53)` →
   客户端回 `CMD_DISPLAY_LOCK_SET(51,[2])`、`CMD_GET_USER_MACRO(40)`、
   **`CMD_GET_WEB_TOKEN(21) len=35 payload=session`**（把 web 会话串注册给 KVM 服务，实测长度 35 与 session 串长度一致）
5. 之后进入视频流：`CMD_VIDEO_PACKETS(25)`；帧头含
   `SourceMode/DestinationMode(X,Y)`、`FrameHdr{CompressionMode, JPEGScaleFactor, JPEGTableSelector,
   JPEGYUVTableMapping, RC4Enable, ...}`、`Mode420`、`CompressData{SourceFrameSize, CompressSize}`
   （原版在 `cmdOnVideoPackets` 里跳过 2 字节后按固定偏移读 72 字节帧头，`CompressSize` 决定该帧负载长度）
6. 解码：原版用 Web Worker **`./libs/kvm/ast/decode_worker.js`**（可从 BMC 直接下载复用）

### 自建 KVM 客户端（本项目已实现并真机验证，2026-09-29）

**架构（2026-09-29 定稿）**：服务端承担握手、**整帧重组**与键鼠编码；浏览器只做「解码 + 渲染 + 输入事件翻译」。
- 服务端把视频流按帧重组好再下发：文本帧 = `{type:'frame',header}`，紧随一个二进制帧 = 该帧压缩数据
  （另有 `{type:'state'|'reset'|'blank'|'power'}`）。
  **为什么不由浏览器重组**：视频帧是差分的（skip 码沿用上一帧像素），浏览器刷新/重连后是**从半途接入**的，
  自己解析裸字节流时帧边界永远对不齐 → 一帧都收不齐（实测踩过）。
- 浏览器重连/刷新时**复用**未断的 BMC 会话（`KvmSession` 生命周期不绑定浏览器 WS，断开后保留 60s），
  复用瞬间发 `CMD_PAUSE_REDIRECTION(4)` → 150ms → `CMD_RESUME_REDIRECTION(6)` 索取**整屏完整帧**
  （原版注释：resume 会得到 full screen video buffer；`CMD_REFRESH_VIDEO_SCREEN(5)` 只补变化区，不够用），
  并让浏览器重建解码缓冲。实测重连后画面与重连前**逐像素一致**。
- 用户点「断开」时浏览器先发 `{kind:'disconnect'}`，服务端立即关闭 BMC 会话（不做 60s 保留）——
  否则下次连接会复用一个可能是「只读从属」的旧会话。
- 服务端用 `ws` 库以 `rejectUnauthorized:false` 连 `wss://<bmc>/kvm`（自签证书），
  **必须显式带 `Origin: https://<bmc>`**（缺省 Node 不发 Origin 会被拒）
- 浏览器 `<->` 代理的 `/api/kvm`：二进制帧 = IVTP 协议字节，文本帧 = JSON 状态/键鼠指令
- 解码 worker 由服务端从 BMC 取回并缓存，经 `/api/kvm/decoder.js` 下发（浏览器用 Blob URL 起经典 worker）

**⚠️ 视频包与帧头偏移（实测解出，纠正了此前"72 字节帧头"的说法）**
```
包: cmd u16 | len u32 | status u16 | payload
payload[0..2)      跳过（2 字节）
payload[2..88)     帧头 86 字节，其中：
                    [4..5] 源宽  [6..7] 源高   (u16 LE)
                    [13..14] 目标宽 [15..16] 目标高
                    [44] JPEGTableSelector  [45] JPEGYUVTableMapping
                    [47] AdvanceTableSelector  [53] RC4Enable  [55] Mode420
                    [71..74) CompressSize（小端；原版 e[72] 越界恒为 0，实际只 3 字节有效）
payload[88..len)   该帧压缩数据
后续包(同帧):      数据自 payload[2] 起，长度 len-2
帧结束条件:        累计字节数 == CompressSize
```
**一帧可能整帧在一个包内**（实测 1024x768 的静态画面：CompressSize=39252、本包数据正好 39252）。

**⚠️ BMC 的 WS 是字节流，不是"一消息一包"**：包可跨多条消息、一条消息也可含多个包。
必须像原版那样用累积缓冲按 `8 + len` 流式消费（服务端与浏览器两侧都要这么做）。

**⚠️ 解码 worker 的输出缓冲必须跨帧持续存在**：AST2100 有 skip 码（块未变化时沿用上一帧像素），
每帧新建空白 `ImageData` 会把未变化区域抹成黑块（本项目的实际 bug）。
正确做法：分辨率变化时用 `{cmd:'resolution_changed', imageBuffer}` 送一次同尺寸缓冲，
之后每帧只送 `{header, buffer}`（`buffer` = 压缩字节按 4 字节打包成的 `Int32Array`），
worker 回 `{cmd:'draw', ibuf}` 时 `putImageData`。

**主控（master）与键鼠权限 —— 最关键的坑**
- `CMD_VALIDATED_VIDEO_SESSION(19)` 的 **payload[1] 是会话序号**：`0` = 我们是主控（键鼠有效），
  `>0` = 已存在别的会话占着主控，我们只是从属 —— **画面照常推送，但按键/鼠标全部无效**。
  现象极具迷惑性：状态显示"传输中"、视频正常，只有输入不生效。
- 从属申请完全控制：发 **`CMD_SET_NEXT_MASTER(0x32) len=0 status=0`**（原版 `#request_full` 按钮的行为）。
  主控侧收到后原版弹窗询问，用户同意则回
  `CMD_KVM_SHARING(32)` 与 `CMD_SET_NEXT_MASTER(50)`，status = `REQ_MASTER(1) | (ALLOWED<<8)`、payload 回带申请方信息；
  主控已消失则由 BMC 超时后把主控权交给申请方。
- 本项目：自身为主控时**自动同意**他人的完全控制申请（同机同用户的其它标签页/原版 viewer）。
- ⚠️ **不能把 `RESPONSE_TO_SLAVE` 一律当授权**：实测会收到 `resp-to-slave/master-terminated`（旧主控退出），
  那不是授权。只有 `RESPONSE_TO_SLAVE + high=ALLOWED(0)` 或 `SWITCH_MASTER` 才算拿到完全控制。
  误判会停在「画面正常但键鼠无效」且不再申请（踩过）。未获授权时本项目持续每 4s 重发申请，
  超过 12s 仍未获批就主动重连争取（最多 3 次）。
- **重连竞态**：上一个 KVM 连接断开后 BMC 需要数秒才释放主控。
  新连接若抢在这之前建立就会拿到序号 >0 变成从属。
  做法：替换旧连接时先发 `CMD_STOP_SESSION_IMMEDIATE(8)` 并**等旧 socket 真正关闭**再建新连接。

**键鼠报文（USB over IP，逐字节与原版一致，见 `reverse/verify_hid_layout.mjs`）**
```
IVTP: cmd=0x01 | len = 32 + 1 + 报告长度 | status=0
USB 头 32B: "IUSB    "(8) | major u8=1 | minor u8=0 | hdrSize u8=32 | 校验和 u8
            | dataLen u32 LE = 1 + 报告长度 | 0 | 设备(0x30 键盘/0x31 鼠标)
            | 协议(0x10/0x20) | 方向 0x80 | 设备号 2 | 接口号(键盘0/鼠标1) | 0 0
            | 序号 u32 LE | 0 0 0 0
后接 1 字节"报告长度" + 报告内容：
  键盘 8B: [修饰键位掩码][1][6 个 HID 键码]
  鼠标绝对 6B: [按键掩码][x u16 LE 0..32767][y u16 LE][滚轮 int8]
  鼠标相对 4B: [按键掩码][dx int8][dy int8][滚轮 int8]   ← 长度字节原版误写为 6，需照抄
校验和 = USB 头 32 字节求和取负（8 位），写在头上偏移 11
```
鼠标模式取 `/api/settings/media/adviser` 的 `mouse_mode`（本机 = 2 绝对定位）。

**其他**
- 键鼠/加密/IPMI 隧道同在这条 socket（`CMD_SEND_HID_PACKET`、`CMD_IPMI_REQ_COMMAND`、`CMD_ENABLE_ENCRYPTION`…）
- JNLP 路径：`GET /api/remote_control/get/kvm/launch` → `jviewer.jnlp`（Java Web Start），实测 403（KVM 会话槽计数器满）
- **实测确认原版 viewer 可用**：从原版"远程控制"页点「启动 KVM」能连上并显示画面

**真机验证记录（2026-09-29，主机为 MZ32-AR0 上的 ESXi 8.0 DCUI，1024x768）**
- 画面：新 UI 的 KVM 页渲染出真实 ESXi 控制台（版本/CPU/内存/管理地址文字清晰可读）
- 键盘：`F2` 唤出 DCUI「Authentication Required」登录框，输入 `root` 可见回显（截图存档）
- 鼠标：报文正确送达（服务端日志可见 btn/坐标/滚轮），但 **ESXi DCUI 本身不支持鼠标**，
  故无法在该画面观察指针移动；报文结构已与原版逐字节核对一致

### ⚠️⚠️ web 会话表被占满会让 KVM 静默降级 + 救场流程（2026-09-29 踩坑）

**两个不同的数字，别搞混**（实测澄清）：
- `/api/settings/services` 里的 `active_session` 是**虚的**：BMC 冷重置后立即显示
  `web 130/148 · kvm 128/130 · cd/hd-media 128/129`，而 `/api/settings/service-sessions` 实际只有 **0 条**。
  它不参与登录判定，别拿它当依据。
- **真正卡登录的是会话列表长度**（上限 `maximum_sessions`，web = 148）。
  列表满了新登录直接 401：`{"error":"Maximum number of sessions already in use","code":15000}`。

### 会话表是怎么被攒满的（2026-09-30 复盘）

除了脚本反复登录不注销，**开发时热重载是主要来源**：`tsx watch` 每次代码改动都会重启代理进程，
老进程来不及 `DELETE /api/session`，它持有的 BMC 会话就成了孤儿——一晚上改几十次代码就能攒满 148 格。
孤儿会话要到会话超时（web 服务 `time_out=1800`，即 30 分钟）才自然释放。

**踩到时的正确报告方式**：会话表满与"会话过期"在界面上是完全不同的问题，不能都报"会话已过期"
（会让人以为是超时，白查半天）。现已如此实现：
- `server/src/bmc.ts` 识别登录返回的 `code 15000` → 抛出带原因的 `BmcSessionExpiredError`，
  消息直接说明"web 会话表已满（148 条）"、成因与救援方式；
- 代理 `/bmc/*` 的 401 响应带上 `detail`；前端 `client.ts` 优先显示该 detail。
- 另注：`/api/settings/service-sessions` **不列 web 会话**（实测同账号连登 5 次后它仍返回 0 条），
  所以别用它判断 web 会话槽位占用——只能等登录被拒（`code 15000`）才知道满了。

**救援**（两条路）：

1. **Redfish 重置（首选，代理已做进登录页的「重置 BMC」按钮）**：
   `POST /redfish/v1/Sessions` 建会话 → `POST /redfish/v1/Managers/Self/Actions/Manager.Reset`，
   body `{"ResetType":"ForceRestart"}`（参数规格取自 `Managers/Self/ResetActionInfo`，只允许 ForceRestart）。
   ⚠️ 表满时经典接口全线被拒，**但 Redfish 仍能建会话**（2026-09-30 实测），所以这是唯一能"自己救自己"的通道。
   实测：发出后 19 秒下线、145 秒恢复，配置保留。实现见 `server/src/bmc-reset.ts`。
2. `reverse/ipmi_reset_bmc.py`（IPMI 冷复位，约 2.5 分钟，主机与虚拟机不受影响）——UI 完全起不来时用。

注：UI 上的「清理僵尸会话」按钮在表满时用不了（它自己也要求已登录）。

**表满之后的表现极具误导性**：
- `/kvm` 的 WebSocket 升级**看起来成功**：先回 `HTTP/1.1 101 Switching Protocols`，
  紧接着在同一连接里又发一个**完整的 `HTTP/1.1 200 OK` 响应**（`Content-Encoding: gzip`、
  `X-Frame-Options`、`Cache-Control: no-store...`、CSP、`Server: lighttpd`、`Connection: close`，
  正文为空）——这是 lighttpd 拿不到后端时的回退页面。客户端按 WS 帧解析这些 ASCII 字节就会报
  `Invalid WebSocket frame: RSV1 must be clear`（RSV1 其实是正文里的随机位），
  极易误判成 permessage-deflate 协商问题——**实测四种 deflate 报价全都报同样的错**，因为根本不是扩展的事。
- 注意：**表满不是 KVM 挂掉的唯一原因**。也遇到过"会话列表为 0 但 KVM 后端仍不服务"的情况，
  即 KVM 守护进程本身卡死，需要重启。

**排查顺序**：先 `GET /api/settings/service-sessions` 看**列表条数**（不是计数器）；
再看 `/kvm` 升级后第一个字节是 `0x48`（'H'，HTTP 回退页）还是二进制帧头。

**救场（按代价从低到高）**：
1. **清僵尸会话**：本项目代理提供 `POST /api/maintenance/clear-bmc-sessions`
   （删掉除本代理以外所有会话，只动会话记录不动配置）。也可以在能登录时用 UI。
2. **等超时**：web 服务 `time_out=1800`，孤儿会话约 30 分钟后被回收（实测有效，但泄漏速度快于回收就没用）。
3. **重启 KVM 服务**：`PUT /api/settings/services/<id>` 改 `state`（需登录，表满时走不通）。
4. **BMC 冷重置（最后手段，实测有效且彻底）**：
   web 通道已被自己锁死时只能走 IPMI——**IPMI 不走 web 会话表**：
   ```python
   from pyghmi.ipmi import command
   command.Command(bmc='192.168.0.200', userid='admin', password='…').reset_bmc()
   ```
   实测：BMC 约 2.5 分钟不可用后恢复，会话列表归零、**卡死的 KVM 守护进程也随之恢复**（视频流立刻正常）。
   ⚠️ BMC 冷重置**不影响主机与其上的虚拟机**，只中断 BMC 自身的 web/KVM/SOL 服务。
   本项目脚本：`reverse/ipmi_reset_bmc.py`（重置）、`reverse/ipmi_info.py`（只读状态/SEL）、`reverse/wait_bmc_up.py`（等待恢复）。

**⭐ 真正的元凶（2026-09-30 定位）：代理的「401 → 自动重登」死循环**
- 症状：BMC 会话表在 **十几分钟内**就被打满，随后连登录都被拒、KVM 也连带被拖坏。
- 机理：该 BMC 会出现"登录成功但请求仍 401"的状态；代理每次 401 都自动重登再试，
  而前端是定时轮询的 → 每次轮询都新建一条 BMC 会话，形成**建会话风暴**。
  实测 148 格 ≈ 10 次/分钟，正好吻合。
- 修法（`server/src/bmc.ts`）：① 登录**合并并发** + **15 秒冷却**；
  ② 连续 3 次"重登后仍 401"就**熔断**，不再自动重登（等用户重新登录）；
  ③ 成功一次即清零计数。
- 验证：修复后让前端持续轮询 4 分钟，登录仍正常、会话表 0 条（修复前同条件会满）。

**其余防泄漏加固**：
- 代理侧：同一 BMC 账号**只持一条会话**（按用户名池化，`server/src/sessions.ts`），
  N 个浏览器标签 = 1 条 BMC 会话；实测同账号再登录会让先前那条失效（旧会话请求返回
  `Invalid Authentication`），所以"每标签各登一次"本来也互相踢。
- 逆向探针脚本：用完即注销（`reverse/*.mjs` 文件头有醒目提示）。
### 会话计数器的历史记录（2026-09-29，已被上面一节取代）
`/api/settings/services` 的 `active_session` 与实际会话表**不一致**：

| 服务 | 计数器 | `service-sessions` 实际列表 |
|---|---|---|
| web | 148/148 → 清理后 131 | 20 个（清理后为 0，之后的新登录会再计入） |
| kvm | 128/130 | **0 个** |
| cd-media / hd-media | 128/129 | **0 个** |

- 后果：登录可能被拒（`Maximum number of sessions already in use`），尽管实际会话很少；
  且存在活跃 KVM 会话时 **web 会话超时会被忽略**（i18n 原文：web timeout would be ignored if there exists any alive KVM session）
- 清理接口（原版"服务"页同款，实测可用）：
  - 列出：`GET /api/settings/service-sessions?service_id=<1=web,2=kvm,4=cd-media,16=hd-media>`
  - 踢掉：`DELETE /api/settings/service-sessions/<会话id>`
- 清理脚本：`reverse/clear_bmc_sessions.mjs`

### SOL（串口重定向）
- `wss://<bmc>/sol?CSRFTOKEN=<garc>`，arraybuffer，文本终端绘制（原版 H5 SOL）
- SOL 配置：`GET/PUT /api/sol/solcfg`【写未实测】

### 虚拟媒体（挂 ISO）
- iusb 会话类默认 **端口 9667**（`wss://host:9667/`，9999 端口有特殊路径分支），CD/HD 两类重定向各自 socket
- REST 侧：`/api/settings/media/local|remote/*`（start-media、stop-media、images、configurations、lmediasizecheck 等）、`/api/settings/media/instance`、`active_redirections`
- 原版页面：`#image_redirection` 镜像重定向

### 视频记录/BSOD
- `#settings/video` + `/api/settings/video/*`（triggers、pre-event、remote-storage）、`/api/logs/video`
- `#settings/bsod` 捕获 BSOD（`/api/host/get_crash_dump`、`/api/acd/*`）

---

## 8. 其他任务/杂项

- `/api/tasks`：实测 GET 405（需特定参数/方法），任务页 `#tasks` 用
- `/api/scripts`：脚本管理（`#scripts` 页）
- `/api/GSM`：Gigabyte 专属?（bundle 中出现）
- `/api/ae_test`、`/api/aep_inventory/*`（Apache Pass 持久内存，本机无此硬件）
- `/api/settings/nvme_management/*`、`nvme_mi_management/*`、`raid_management/*`、`sasit_management/*`、`pcie_switch_management/*`：本机无对应硬件，页面虽在菜单但数据为空/不可用

---

## 9. 原版页面 → 接口映射（Playwright 走查实录）

| 原版路由 | 主要 XHR |
|---|---|
| `#login` | `POST /api/session` |
| `#dashboard` | `sensors`、`chassis-status`、`firmware-info`、`status/uptime`、`logs/audit`、`logs/dashboardevent`、`logs/event?LASTEVENTID=`、`settings/users`、`settings/date-time`、`configuration/project`、`configuration/runtime`、`system_inventory_gbt/cmc_ip` |
| `#sensors` | `sensors` + `chassis-status` 轮询 |
| `#power-control` | `chassis-status` 轮询；提交→`POST /api/actions/power`（未触发） |
| `#fan_profile`（含 edit/new/copy） | `settings/fanprofile/mode`、`settings/fanprofile/collection` |
| `#dcmi/power` | `dcmi/power` |
| `#fru` | `fru` |
| `#logs/event-log` | `logs/event` |
| `#settings/network` | `settings/network*` |
| `#settings/users` | `settings/users` |
| `#settings/date_time` | `settings/date-time` |
| `#remote_control` | KVM/SOL 启动逻辑（`remote_control/get/kvm/launch` 等） |
| `#image_redirection` | `settings/media/*` |
| `#system_inventory_info` 等 | `system_inventory_gbt/*`、`host_inventory/*` |
| `#maintenance` | `maintenance/*`（未展开操作） |
| `#logout` | `DELETE /api/session` |

## 10. 前端技术形态（原版）

- 入口 `/` → RequireJS 单页应用：`/source.min.js`（6.8MB，含全部 views/models/templates）+ `/styles.min.css`
- KVM 独立窗口 `/viewer.html` → `/viewer.min.js`（1.6MB）
- 服务器 `lighttpd`，强制 HTTPS（80 → 307 → 443），CSP/安全头齐全
- 原版前端为 Backbone + jQuery + i18next（含简体中文语言包），路由为 hash 路由

---

## 附：KVM 自研参考（从 UI 移至文档归档）

- 现成实现调研：未找到可直接复用的开源 SP-X KVM 库；最接近的参考是 [MagnaCapax/mcxBMCView](https://github.com/MagnaCapax/mcxBMCView)（AMI MegaRAC HTML5 KVM 截屏逆向实践）
- 协议研究背景：[Nozomi Networks — MegaRAC SP-X 协议研究](https://www.nozominetworks.com/blog/vulnerabilities-in-bmc-firmware-affect-ot-iot-device-security-part-2)
- 视频解码：原版 `viewer.min.js` 通过 Web Worker `./libs/kvm/ast/decode_worker.js` 解码；帧头含 `CompressionMode / JPEGScaleFactor / JPEGTableSelector / VQMode / RC4Enable`，编码器侧有 JPEG 结构（DHT/DQT、maxJPEGSize），`VIDEO_PACKET_SIZE=373`、`HDR_SIZE=8`
- 自研路线：Node 侧 ws 客户端连 wss/kvm → 复刻 createHeader 帧协议（`CMD_CONNECTION_COMPLETE_PKT` 74 字节会话信息 + `CMD_VALIDATE_VIDEO_SESSION` 校验）→ 逐帧取 `CMD_VIDEO_PACKETS` 载荷 → Canvas 渲染；键鼠用 `CMD_SEND_HID_PACKET`

## 8. 虚拟介质（Image Redirection）逆向结论 —— 2026-09-29

**协议已摸清（本地 ISO 重定向走 iusb over WebSocket）**，但**本机 BMC 未授权该功能**，
故未落地实现。留档备查：

**通道**：`wss://<bmc>/cd-server`（单口模式，实测 101 升级成功；非单口是 `:<kvm_port>/`）。
与 KVM 一样是**字节流**，帧格式：
```
[IUSB 头 32B][dataPacketLength 字节]     ← length 在头内偏移 12（u32 LE）
IUSB 头: 0..7 "IUSB    " | 8 major=1 | 9 minor=0 | 10 headerLength=32 | 11 checksum
         12..15 dataPacketLength | 16 serverCaps | 17 deviceType=0x05 | 18 protocol=0x01
         19 direction(0x80=fromClient) | 20 deviceNo | 21 interfaceNo | 22 clientData
         23 instance | 24..27 sequenceNo | 28..31 key
```
**SCSI 数据区**从包内偏移 32 开始：opcode 在 **偏移 41**（= 数据区偏移 9），LBA 在 43；
`DEVICE_REDIRECTION_ACK(0xf1)` 的 `connectionStatus` 在 **偏移 62**（= 数据区偏移 30），
其后 39 字节是占用方 IP。

**客户端启动序列**（取自 `libs/media/cdrom.js`）：
1. 连 `/cd-server`
2. 发 `AUTH(0xf2)`：载荷 = flag(0) + token（token 来自 `h5viewercfg.token` 或页面 SESSION_INFO）
3. 发 `DEVICE_INFO(0xf8)`：载荷 = u32(3=H5Viewer) + 文件名 + `\0`
4. 服务器回 `DEVICE_REDIRECTION_ACK`：`connectionStatus` 1=接受 / 3=登录失败 / 4=已被占用 /
   5=无权限 / 8=超过最大用户 / 9=无法连接
5. 之后服务器下发 SCSI 命令（READ(10) 等），客户端用本地 ISO 文件按块应答；
   另有 `KEEP_ALIVE(0xf3)`、`OPCODE_EJECT(0x1b)`、`OPCODE_KILL_REDIR(0xf6)`、
   `MEDIA_SESSION_DISCONNECT(0xf7)`
6. 客户端侧 SCSI 模拟参考实现：`libs/media/cdimage.js`（含 ISO/UDF 校验、READ CAPACITY、
   按块读文件）

**为什么本机做不了（实测证据）**：
- 介质支持开关是 **license 门控**（BMC UI 里 `data-feature="LMEDIA"/"RMEDIA" data-license="LMEDIA"`）
- `PUT /api/settings/media/general {"local_media_support":1}` 返回 200 并回显 1，但**再次 GET 仍是 0**（固件拒绝持久化）
- `GET /api/settings/media/active_redirections` → 500 `{"error":"Error while getting Media Info","code":16416}`
- `/cd-server` 握手：有时无任何响应，有时回 ACK 但状态非「接受」
- `remotesession` 里 `remote_media_enable: 0`、`local_media_enable: 4`

**结论**：需要 AMI 的 LMEDIA/RMEDIA 授权才能启用。已留下探针脚本
`reverse/media_probe.mjs`（通道探测）与 `reverse/media_handshake_probe.mjs`（auth/device-info 握手）。

**AMI 官方资料佐证（2026-09-30 查 ami.com.cn / SP-X 数据手册）**：
- 手册原文：*"administrators enjoy complete out-of-band, OS-independent server control including
  power management, **KVM redirection and virtual media**"*，并列出 *"Virtual KVM and Virtual Media"*、
  *"Remote & Local Media"*、*"Serial over LAN (SOL)"* 为标准能力。
- 关键一句：*"**Since licensing and intellectual property information can be limited to a package**,
  this modular approach ensures intellectual property protection."* —— 即 SP-X 采用
  **按服务/按包授权（Technology Pack + license key）**，vMedia 正是可被授权的模块，
  与本机 `data-license="LMEDIA"/"RMEDIA"` 且开关不持久化的现象一致。
- vMedia 官方描述含 USB 2.0 重定向、分区块逻辑驱动器重定向、SD/eMMC 与网络共享等；
  要启用需向 AMI/技嘉取得对应 license key（`/api/settings/licenses` 当前 405 未启用）。
- 数据手册 PDF 存于 `reverse/spx_datasheet.pdf`。

## 9. 设置页写操作实测（2026-09-29）

| 对象 | 结论 |
|---|---|
| **用户** | ✅ 已实测通过。新建/修改 = `PUT /api/settings/users/<id>`，**必须以 GET 到的槽位对象为底再覆盖改动字段**（字段不全 → 500），带 `UserOperation`(0=新增 1=修改)、`confirm_password`、`password_size`、`accessByChannel`、`privilegeByChannel`；删除 = `DELETE /api/settings/users/<id>`，body `{snmp_status,id}`（PUT 清空会 500）。用户是**固定槽位**模型（1=anonymous、2=admin、3..N 空），新建=占用空槽 |
| **服务** | ❌ 未通过。照抄 BMC UI 的字段集（state/interface_name/两个端口/time_out/maximum_sessions/active_session）PUT，BMC 回 500 `{"error":"Error setting service configuration","code":1198/1199}`；换用 `service_id` 作 URL 同样 500。疑似需要「扩展权限」。UI 已保留但标注未验证，失败不会改动配置 |
| **日期时间** | ✅ 已实测通过（2026-09-30）。`PUT /api/settings/date-time`，**必须自己算 UTC 偏移并带上**：<br>`{timezone, mode, utc_minutes, timestamp:-1, ntp_auto_date, primary_ntp, secondary_ntp}`<br>· `utc_minutes` = 该时区相对 UTC 的**分钟数**（Asia/Shanghai=480）——BMC 不会从时区名自己算，原版前端是用 moment-timezone 算好后一起提交的<br>· `mode`：时区名含 GMT/UTC 时为 1，否则 0<br>· `timestamp:-1` = 不改时钟（只改时区/NTP）<br>· ⚠️ **NTP 服务器必须填 IP**：这台 BMC **没有可用 DNS**，填 `pool.ntp.org` 这类域名会让整条写入 500 `{"error":"Could not set NTP configuration.","code":1022}`——**连时区也一起写不进去**，这就是"设时区却报 NTP 失败"的原因。实测可用：`203.107.6.88`、`120.25.115.20`（阿里）<br>· `ntp_auto_date`：0=关闭 / 1=已启用 / 2=**服务器无效**（BMC 自报不可达或无法解析），原版 UI 见 2 会弹 "invalid server"<br>· 生效后 BMC 时钟会同步（实测启用后约 1 分钟内对齐北京时间），**SEL 与审计日志的时间戳随之变准** |
| **网络** | ⚠️ 刻意不做实测（写错会失联，只能到机器前救）。UI 有强警告 + 格式校验 + 二次确认 |

**⚠️ 运维提示**：该 BMC 在 2026-09-29 傍晚起 web 接口稳定变慢（认证请求 5~27 秒，
IPMI 报硬件健康）。代理已做去重/优先级/排队上限以免雪崩；做写操作前请先确认响应时间。

## 10. BMC 固件升级（2026-09-30 已完成：12.41.11 → 12.61.39）

**结果**：升级**成功**。`fw_ver 12.61.39`、`date Jul 2 2025`、`active_image 1`（换到另一个镜像 bank），
CVE-2024-54085 / CVE-2023-34329/34330 随之修掉。**配置全部保留**（见文末对比），主机与虚拟机全程未受影响。

**固件来源**：技嘉 MZ32-AR0 支持页 → `server_firmware_ast2500_AMI_12.61.39.zip`（104.87 MB）
- `126139/fw/126139.bin`（66,060,552 B，md5 `84a19bbe0593636ad61a96fcd07b69c5`）
- `126139/fw/rom.ima_enc`（66,060,424 B，md5 `83b1b3b409a5cdbc85a18daebe1d6b48`）
  —— **两者前 66,060,424 字节完全相同**，`.bin` 只是尾部多了 128 字节（像是签名/校验块）。
  镜像开头是裸 ARM 异常向量表 + `*ASTHwStrap#`，**不是 HPM 包**。
- `126139/projects.txt` 列 1234 个平台，**`MZ32-AR0-00` 在列**（与本机 FRU 的板卡型号一致）
- `BMC_Release_Note_126139.doc`（183 页 changelog）：**12.61.35 修 CVE-2024-54085**；
  **12.61.17 合并 CVE-2023-34329/34330**；12.61.39 附带 Redfish 1.7→1.8 与**移除 SSH 服务**。
- ⚠️ 技嘉官方指南（`GBT_BMC_Firmware_Upgrade_User_Guide_v007`）**只写带内方式**
  （Linux/Windows/UEFI 跑 `gigaflash`），出带（web/Redfish）**官方没有任何文档** —— 这也解释了为什么路这么难走。

### ✅ 唯一实测走通的路径：让 BMC 自己从 TFTP 拉镜像

```
PUT  /api/maintenance/fwimage_location     {protocol_type:'tftp',
                                            server_address:'<你的服务器>',
                                            image_name:'rom.ima', retry_count:3}
PUT  /api/maintenance/flash                {flash_type:'BMC'}        ← body 必须带 flash_type！
PUT  /api/maintenance/firmware/dwldfwimg   {PROTO_TYPE:1}            ← 1=TFTP，让 BMC 去拉
GET  /api/maintenance/firmware/dwldfwstatus-progress                ← 下载进度，完成时 state=2 progress=Complete
GET  /api/maintenance/firmware/verification?flash_type=BMC          ← 校验，返回 verification_status 位掩码
PUT  /api/maintenance/firmware/upgrade     {flash_type:'BMC',
                                            preserve_config:1,       ← 1=保留全部配置
                                            flash_status:1}          ← 1=CONS_FORCE_FLASH 整镜像
GET  /api/maintenance/firmware/flash-progress                        ← "Flashing... N% done" → "Completed."
GET  /api/maintenance/fwupdate_keepalived                            ← 每 10s 保活，超 90s BMC 会放弃
```

实测时间线：准备 75 s → TFTP 传 66 MB 用 90 s（0.70 MB/s）→ 校验 25 s → 刷写 4.5 分钟 → BMC 重启约 2 分钟。

**TFTP 服务器有两个必须踩对的点**（`reverse/tftp_server.py` 已实现，可直接用）：

1. **必须从监听端口（69）回包**。用临时端口回包（TFTP 标准允许、多数实现也接受）时，
   这台 BMC 的客户端会把应答**全部忽略**：表现为它每 10 秒重发一次同样的 RRQ，服务端永远卡在「块 1 无 ACK」。
2. **要支持 blksize 协商**（RFC 2348）。BMC 会在 RRQ 里带 `blksize=1024`，按它给的值走。
   用默认 512 字节块传 66 MB 要 12.9 万个块，BMC 侧会在中途放弃并从头重来（实测走到 24% 就重来）。

**为什么必须让 BMC 来拉、而不是我们传上去**：见下面三条失败路径。

### ❌ 三条走不通的路径（都已定位到具体原因）

**① Redfish SimpleUpdate —— POST 无限挂起**
- 参数规格来自 `GET /redfish/v1/UpdateService/SimpleUpdateActionInfo`（`ImageURI` / `TransferProtocol` 必填，
  允许 HTTP|FTP；另有 `User`/`Password`/`UpdateComponent`/`ResetBMC`）
- target 是 **`/redfish/v1/UpdateService/Actions/SimpleUpdate`**（AMI 用短形式，写成 `UpdateService.SimpleUpdate` 会 404）
- 实测 3 次（含一次 BMC 冷复位后、含最小 body 与带 `UpdateComponent`/`ResetBMC` 的 body）：
  **POST 无限挂起，既不建任务、BMC 也从未发起连接**。BMC 侧 `fwupdate_check=0`、`flash-progress` 显示空闲，
  即它自认为什么都没发生。→ 这条 API 在这个固件版本上不可用。

**② 经典 web API 上传 —— 上传会「秒拒」或「收到后校验失败」**
- `PUT /api/maintenance/flash` 的 body **必须是 `{flash_type:'BMC'}`**（发空 `{}` 时后续上传必被秒拒）。
  这个细节是从原版 `source.min.js` 的 `downloadstart` 里读出来的 —— 官方 JS 就是带 `flash_type` 发的。
- 即便发对了：上传 66 MB 要 151 s，之后 `flash-progress` 报 **`Image Verification / Failed`**，
  且 `verification` 返回 500 `code 1306`。
- **刷写区是「一次性」的**：一次校验失败之后，后续上传一律 0 秒被拒（`{"cc":-1}`），
  **连 IPMI 冷复位都清不掉**（该状态似乎持久化在 flash 里）。
  之前所有「请求形态不对」的判断都源于此——实际是状态问题，不是形态问题。
- 结论：这条路在我们手上没有可用的镜像格式（`126139.bin` 与 `rom.ima_enc` 都被判校验失败）。

**③ HPM 路径 —— 原厂向导自己都走不通**
```
PUT  /api/maintenance/hpm/updatemode        {}  → {unique_id}
PUT  /api/maintenance/hpm/preparecomponents {FWUPDATEID, COMPONENT_ID, COMPONENT_DATA_LEN, IS_MMC}
POST /api/maintenance/hpm/biosfw            multipart fwimage → 200（上传成功）
PUT  /api/maintenance/hpm/flash             {COMPONENT_ID, COMPONENT_DATA_LEN, FWUPDATEID, SECTION_FLASH}
PUT  /api/maintenance/hpm/exitupdatemode
```
- **用 Playwright 驱动原厂 UI + 真镜像实测**：`updatemode` 200 → `preparecomponents` 200 →
  `biosfw` 上传 200 → **`hpm/flash` 500** `{"error":"Error in HPM Finish Firmware Upload","code":1373}`。
  浏览器控制台同时打出 **`Starting update for component: undefined`** —— 组件根本没识别出来。
- 根因（从 JS 读出）：向导按**文件扩展名**分派——
  `"hpm" == 扩展名` → 走 HPM 组件解析（`RAWBIOS=false`）；
  `"bin" == 扩展名` → **当成「裸 BIOS 镜像」**（`RAWBIOS=true`），用 `HPM_BIOS_CID=2` 去刷一个不存在的 BIOS 组件。
  我们的镜像是裸 `.bin`，于是必然落到错误分支；而改名成 `.hpm` 后组件表为空（镜像本来就不是 HPM 包）。
- `hpm/componentversions` 只有 `[{"id":0,...,"current_version":"0.0.0"}]`，组件表与实际镜像不匹配。
- 结论：**不是我们操作错，是原厂向导在这个固件上就是坏的**——这很可能就是这块板子从 2020 年起一直没升级的原因。

### 新固件带来的行为变化

| 变化 | 说明 |
|---|---|
| **SSH 服务被移除** | 发布说明原文 `[feature] Remove SSH service.`；`/api/settings/services` 里 ssh 条目消失（原来 secure_port=22）。以后只能走 Web/Redfish/IPMI |
| **Redfish 1.7 → 1.8** | `@odata.type` 从 `Message.v1_0_7` 变 `v1_0_8`；`firmware-info` 新增 `sku_ver`/`sdr_ver` 字段 |
| **Redfish 子资源访问不稳定** | 升级后探测中 `Managers/Self` 时而 200、其余资源时而 401「the service was denied access」时而 403（lighttpd HTML），同一会话内也不一致。经典 web 通道始终正常，本项目不依赖 Redfish，故未深究，留作后续观察项 |
| **配置保留** | 见下 |

**配置保留对比**（`reverse/config_diff.mjs`，逐字段递归比对）：

| 配置 | 结果 |
|---|---|
| 网络（静态 192.168.0.200/24、网关、MAC、IPv6） | ✅ 保留（仅 `ipv6_gateway` 由 `::` 变为自动填的链路本地地址） |
| 用户（admin 及各槽位权限） | ✅ 保留（仅 `creation_time` 随系统时钟变化） |
| 风扇档案（mode=CPU_TEMP、曲线集合） | ✅ 保留（曲线值一致；新固件风扇传感器列表少一项 `190`） |
| 介质设置（general / remotesession / adviser） | ✅ 完全一致 |
| 服务（端口、超时、最大会话数） | ✅ 保留（ssh 条目按新特性移除） |
| 日期时间（NTP、时区） | ✅ 保留（仅 timestamp 是时钟值） |

**升级后回归**：证书/登录、传感器、SEL、电源状态、会话表（0）、风扇模式、KVM（自研中继：握手→出流→
收到 1024×768 完整帧→在线客户端列表）全部正常。

### 复现所需脚本

| 脚本 | 用途 |
|---|---|
| `reverse/tftp_server.py` | **TFTP 服务**（69 端口回包 + blksize 协商，两个坑都已处理）。放 ESXi/任意 Linux 上跑 |
| `reverse/flash_via_tftp_full.mjs` | **一条命令走完**：配置位置 → 准备 → 触发下载 → 校验 → 刷写 → 监控到版本变化 |
| `reverse/pre_upgrade_backup.mjs` | 刷前配置快照（写 `reverse/pre_upgrade_snapshot.json`，产物不入库） |
| `reverse/config_diff.mjs` | 刷后逐字段对比配置是否保留 |
| `reverse/monitor_flash.mjs` / `wait_bmc_recover.mjs` | 刷写期间监控、BMC 重启等待 |
| `reverse/esxi_helper.cjs` | 从 Windows 操作 ESXi（`exec` / `put` / `get`）；⚠️ 路径要用 `MSYS_NO_PATHCONV=1`，否则 Git Bash 会把 `/vmfs/...` 改写成 Windows 路径 |
| `reverse/ipmi_reset_bmc.py` | IPMI 冷复位（web 通道自救不了时用） |
| `reverse/tftp_pull_flash2.mjs` | 只观察不刷写：持续轮询下载后的状态机（调试用） |

### 关键教训

1. **BMC 处在 `Firmware update is in progress`（code 17000）时会拒绝登录**，且这是**持久状态**：
   一次刷写准备+失败的上传会留下它，自清需要 2~5 分钟，期间 web 栈还会重启几次（表现为 ECONNRESET/ECONNREFUSED/超时）。
   所以重试之间必须留够时间，别以为是网络问题。
2. **别用短超时掐断 BMC 的操作**。第一次 SimpleUpdate 我在 120 s 处 abort，之后该 API 再没成功建过任务。
3. 这套 BMC 的 web 栈**本身就间歇性慢/挂**（`UpdateService`、`Chassis`、`TaskService` 都各挂过 20~90 s），
   写操作前先确认响应时间。
4. 判断「请求形态对不对」时，**先去读原版 `source.min.js`**：头部名（`X-CSRFTOKEN`）、
   body 字段（`flash_type`）、流程顺序（准备→上传→校验→升级）、保活节奏都在里面，比自己猜快得多。
5. 本机（Windows）**入站 TCP 全被拦**（连 3389 这种既有放行规则又在监听的端口从外部也连不上，
   非管理员查不到原因，无第三方安全软件）。所以任何「让 BMC 来拉」的方案都别指望这台机器，
   改把镜像放到 BMC 同网段的其他主机上（本次用的是它自己的 ESXi 主机，走 ESXi 自带 Python + 自定义防火墙规则集）。

---

## 11. Redfish 接口实测与「双数据源」数据层（2026-09-30 重写）

升级到 12.61.39 后 Redfish 升到 1.8（`@odata.type` 从 `Message.v1_0_7` 变 `v1_0_8`，`firmware-info`
多出 `sku_ver`/`sdr_ver`）。借此机会把新 UI 的数据层重写成「经典 web API 为骨干 + Redfish 为增补」。
下面全是实测结论，探针脚本：`reverse/redfish_reliability_test.mjs`、`reverse/redfish_abort_test.mjs`、
`reverse/redfish_401_diagnose.mjs`、`reverse/redfish_keepalive_test.mjs`、`reverse/redfish_ui_mapping.mjs`。

### 三条硬约束（决定了实现方式）

**① 客户端 abort 请求 → BMC 把该 Redfish 会话"毒死"**

对照实验（`redfish_abort_test.mjs`）：

| 步骤 | 结果 |
|---|---|
| 正常取 `Managers/Self` | 200（2.1s） |
| 用 3 秒超时取 `Chassis`（必然 abort） | TimeoutError |
| **同会话**再取 `Managers/Self` | 挂 30s → 再取 **401** `the service was denied access` |
| **重新登录**后再取 | 立刻 200（Systems 1.9s / Managers 2.5s） |
| 给足 120 秒超时取那三个"爱挂"的资源 | **全部 200，只用 0.8~2.1 秒** |

结论：那些"慢"和 401 大多不是 BMC 慢，而是**被客户端 abort 毒死的会话**。反过来说，
只要不 abort、失败就换会话，Redfish 是可用的。实现见 `server/src/redfish.ts`（超时 90 秒、
失败即丢 token 重登、绝不主动取消）。

**② 有些资源真的会挂，且一挂就污染后续请求**

- `/redfish/v1/Chassis`：一次实测**挂满 120 秒**（同一时刻经典 API 的 `/api/sensors` 只要 **193ms**，
  即数据源本身是健康的）→ 这是 Redfish 侧的问题，不是主机/传感器的问题。
- `/redfish/v1/Systems/Self`、`AccountService/Accounts`、`UpdateService` 也都各挂过一次；
  但换一轮往往 2 秒就回——**同一个资源时而秒回、时而挂死**。
- 失败后的下一个请求常直接 401（会话被污染），所以实现里"任何失败都换会话"。

**③ 新固件有防滥用限流：密集请求会封禁整个 IP**

实测：在几秒内连发约 40 次请求（Redfish + 经典 API 混着打）后，**连经典 `POST /api/session` 都返回 403**
（lighttpd 的 HTML 错误页，不是 JSON），且从别的机器也连不上 BMC 的 443；**约 3 分钟后自愈**。
实现对策：Redfish 请求**串行 + 最小间隔 250ms + 令牌桶（10 秒 25 次）**，并识别 403+HTML 为封禁、
退避 200 秒；经典通道本来就已串行化。

### Redfish 相比经典 API 的增量（真正有价值的几项）

| 数据 | 经典 web API | Redfish |
|---|---|---|
| BMC 固件版本 | ✅ | ✅ |
| **BIOS 版本** | ❌（`bios_ver` 为空） | ✅ `Systems/*/BiosVersion`（本机 **R38**） |
| **序列号 / UUID / 厂商** | 只在 FRU 里，且板卡与产品两条不同 | ✅ `Systems/*` |
| **CPU 与内存摘要** | ❌ | ✅ `ProcessorSummary` / `Memory`（本机 1×EPYC 7R32） |
| **健康状态（Status.State/Health）** | ❌ | ✅ |
| **固件组件清单 + 可更新标记** | ❌ | ✅ `UpdateService/FirmwareInventory`（BMC / BIOS / MB_CPLD1） |
| **Thermal 标准阈值** | 有 4 档阈值（够用） | ✅ 另有标准名与阈值，作为交叉校验 |
| 传感器实时值 | ✅ **快（193ms）** | 走 Chassis/Thermal，慢且会挂 |
| SEL / 用户 / 网络 | ✅ | ✅（结构更标准，但经典够用） |
| 风扇曲线（技嘉 OEM） | ✅ | ❌ **只有经典 API 有** |
| KVM（IVTP） | ✅ | ❌ Redfish 不含（OEM 扩展也没暴露可用入口） |

### 因此的数据层设计

```
页面  →  /api/overview | /api/sensors | /api/sel | /api/inventory   （归一化）
              ↓
        server/src/models.ts
        ├─ 骨干：经典 web API（bmc.ts，单会话池化 + 串行 + 冷却/熔断）
        └─ 增补：augment.ts 后台预热器 → redfish.ts（只读缓存，绝不阻塞请求）
```

**关键取舍：请求路径永不等 Redfish。** 直接等它的代价实测过：
`/api/overview` **101 秒**、`/api/inventory` **97 秒**；改成后台预热 + 读缓存后
`/api/overview` **2.2 秒**、`/api/inventory` **2.0 秒**、`/api/sensors` **166ms**。
增补数据（BIOS/序列号/CPU 摘要/固件清单）在登录后约 1~2 分钟由后台补齐，界面用
"数据来源徽标"如实显示"实时 / 数据可能过时 / 哪些字段降级了"。

### 归一化的两个细节（都是踩过的坑）

1. **健康判定必须以 BMC 的 `sensor_state` 为权威，阈值只用来加重**。
   本机只有 1 条内存（Group 0）、SYS_FAN5 空、电源是无 PMBus 的 ATX，所以
   `DIMMG1_TEMP` / `SYS_FAN5` / `PSU*_HOTSPOT` 读数恒为 0，而它们的下限阈值是 0 / 150 / 0 ——
   纯按阈值判会得到一堆假"严重告警"。BMC 自己对这 31 个模拟量的判断都是 `sensor_state=1`（正常），
   另外 5 个离散量（`CPU0_Status`/`PS*_Status`/`SEL`/`Watchdog`）是 `sensor_state=0`（不适用）。
   规则：`状态量→na`；`sensor_state=0→na`；`温度/风扇读数为 0→na（未安装）`；其余按阈值判 warn/crit。
2. **回退源要能兜住**：`/api/inventory` 的固件清单优先用 Redfish（含"可更新"），
   拿不到时退回经典 API 的 BMC 版本一项，并在 `sources.degraded` 里说明降级了什么。
