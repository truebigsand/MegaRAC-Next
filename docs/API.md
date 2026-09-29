# Gigabyte MZ32-AR0 BMC（AMI MegaRAC SP-X 12.41.11）Web API 逆向文档

> 逆向对象：`https://192.168.0.200`（技嘉 MZ32-AR0-00 / EPYC 7R32 的 BMC）
> 固件：AMI MegaRAC SP-X "Scorpio"，Web 显示 12.41.11（fw-info 报 12.65，IPMI rev 12/65），构建日期 Mar 20 2020
> 逆向方法：前端 bundle 静态分析（`reverse/source.min.js`、`reverse/viewer.min.js`）+ Playwright 页面走查 + 只读 API 实测（`reverse/probe_api.mjs`，全部样本存于 `reverse/samples/probe_results.json`）
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
| `/api/fru` 与 `/api/settings/fru` | FRU 内容（BMC_FRU 设备：chassis/board/product 三区，MZ32-AR0-00、SN <board-sn>） |

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

**本项目已做的防泄漏加固**：
- 代理侧：同一 BMC 账号**只持一条会话**（按用户名池化，`server/src/sessions.ts`），
  N 个浏览器标签 = 1 条 BMC 会话；实测同账号再登录会让先前那条失效（旧会话请求返回
  `Invalid Authentication`），所以"每标签各登一次"本来也互相踢。
- 逆向探针脚本：用完即注销（`reverse/*.mjs` 文件头有醒目提示）；
  早期正是这些脚本泄漏的 ~148 条会话把表占满的。
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
