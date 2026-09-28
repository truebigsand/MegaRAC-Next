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

### HTML5 KVM（viewer.html + viewer.min.js）
- 启动：主 UI 打开 `/viewer.html` 独立窗口（H5Viewer）；会话信息存 sessionStorage（`garc` CSRF、`session_id`、privilege 等）
- **视频/键鼠 WebSocket：`wss://<bmc>/kvm`**（同 443 端口，lighttpd 反代），子协议 `["binary","base64"]`，`binaryType=arraybuffer`
- 协议为 AMI 私有二进制：`createHeader(cmd, len, status, payload)` 自定义包头；命令常量 `CMD_*`（KEEP_ALIVE_PKT、IPMI_REQ_COMMAND、POWER_CTRL_REQUEST(ON/OFF/CYCLE/HARD_RESET/SOFT_RESET)、KVM_SHARING、PAUSE_REDIRECTION、STOP_SESSION_IMMEDIATE 等）与状态机 `STATUS_KVM_PRIV_*` 全部内嵌于 `viewer.min.js`，可再逆向
- 会话协商含 master/slave 主从切换、键盘鼠标加密开关、带宽自适应包
- JNLP 路径：`GET /api/remote_control/get/kvm/launch` → 下载 `jviewer.jnlp`（Java Web Start）。**实测当前 403**——判断因 KVM 会话槽满（active 128/130），待会话表清空后复测
- 键鼠加密握手/IPMI 命令隧道也在同一 socket（`CMD_IPMI_REQ_COMMAND`）

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
