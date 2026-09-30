# 生产部署

MegaRAC-Next 是**一个 Node 进程**：既提供 Vue 构建产物（SPA），又代理 BMC 的 API 与 KVM。
所以生产部署只需要跑一个进程、开放一个端口（默认 5177）。

```
浏览器 ──HTTP/HTTPS──► MegaRAC-Next 进程（5177）
                          ├─ /            前端 SPA（web/dist）
                          ├─ /api/*       归一化数据、历史趋势、认证
                          ├─ /bmc/*       透传 BMC 原始接口（设置/风扇曲线等写操作）
                          └─ /api/kvm      KVM WebSocket 中继
                        ↓ 内部再走 https（自签证书，仅对此 BMC 关闭校验）
                      BMC（默认 https://192.168.0.200）
```

## 1. 前置要求

| 项 | 要求 | 说明 |
|---|---|---|
| Node | **≥ 24**（或 Docker） | 历史趋势用内置 `node:sqlite`，Node 23.4 之前需要 `--experimental-sqlite` |
| 网络 | 能访问 BMC 的 443 | 代理与 BMC 之间必须直连（BMC 不经过任何外部服务） |
| 系统 | Linux / Windows / macOS 均可 | 官方只在 Windows 上长期实测过 |

## 2. 最快路径（裸机 / 直接跑进程）

```bash
git clone https://github.com/truebigsand/MegaRAC-Next.git
cd MegaRAC-Next
npm ci                 # 安装依赖（含前端构建工具）
npm run build          # 构建前端 SPA + 编译服务端到 server/dist
BMC_BASE=https://192.168.0.200 npm start
```

打开 `http://<这台机器>:5177/`，用 **BMC 的账号密码**登录即可（凭据只经代理内存转发，不落盘）。

> 只跑 `npm run dev:server` 是**开发模式**（只有 API，没有 SPA，且是热重载）——生产不要这么用，
> 原因见第 7 节「不要频繁重启」。

## 3. 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `BMC_BASE` | `https://192.168.0.200` | BMC 地址 |
| `HOST` | `0.0.0.0` | 监听地址；**建议改成 `127.0.0.1` 并前置反代**（见第 5 节） |
| `PORT` | `5177` | 监听端口 |
| `WEB_DIST` | `web/dist`（相对本进程文件定位） | 前端产物目录；不存在时本进程只提供 API |
| `COOKIE_SECURE` | 关 | 置 `1` 时会话 cookie 带 `Secure`——**放在 HTTPS 后面时必须打开** |
| `HISTORY_DB` | `server/data/history.sqlite3` | 历史趋势库；相对路径按服务端目录解析 |
| `BMC_TIMEOUT_MS` | `30000` | 经典接口单请求超时 |
| `BMC_MAX_QUEUED` | `8` | 串行队列上限（防雪崩） |
| `BMC_LOGIN_COOLDOWN_MS` | `15000` | 两次 BMC 登录的最小间隔 |
| `RF_MIN_INTERVAL_MS` | `250` | 两次 Redfish 请求的最小间隔（防触发 BMC 的防滥用限流） |
| `RF_BUCKET_MAX` | `25` | Redfish 限流：每 10 秒最多请求数 |
| `RF_AUGMENT_INTERVAL_MS` | `90000` | Redfish 增补（BIOS/UUID/固件清单）的后台刷新间隔 |

## 4. 常驻运行

### Linux（systemd）

仓库里带了一份可直接用的 unit：[`deploy/megarac-next.service`](../deploy/megarac-next.service)

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin megarac-next
sudo mkdir -p /opt/megarac-next && sudo chown -R $USER /opt/megarac-next
git clone https://github.com/truebigsand/MegaRAC-Next.git /opt/megarac-next
cd /opt/megarac-next && npm ci && npm run build

sudo cp deploy/megarac-next.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now megarac-next
systemctl status megarac-next        # 看状态
journalctl -u megarac-next -f        # 看日志（pino 输出 JSON，可用 jq 过滤）
```

### Windows

三种方式，按需选一种：

```powershell
# 方式一：nssm（推荐，可配日志轮转与启动参数）
# 先装 nssm：winget install nssm
nssm install MegaRACNext "C:\Program Files\nodejs\node.exe" "server\dist\index.js"
nssm set MegaRACNext AppDirectory "C:\path\to\MegaRAC-Next"
nssm set MegaRACNext AppEnvironmentExtra BMC_BASE=https://192.168.0.200
nssm start MegaRACNext

# 方式二：Windows 自带 sc.exe（无自动重启，崩了要手动拉起）
sc.exe create MegaRACNext binPath= "\"C:\Program Files\nodejs\node.exe\" \"C:\path\to\MegaRAC-Next\server\dist\index.js\"" start= auto
sc.exe start MegaRACNext

# 方式三：计划任务（开机自启，最简单）
schtasks /create /tn MegaRACNext /sc onstart /ru SYSTEM /tr "\"C:\Program Files\nodejs\node.exe\" \"C:\path\to\MegaRAC-Next\server\dist\index.js\""
```

> Windows 下如果用服务方式，注意工作目录（`AppDirectory` / 计划任务的起始位置）——虽然 `HISTORY_DB`
> 已经按服务端目录解析、不依赖 cwd，但把 cwd 设对更省事。

### 容器

> ⚠️ **验证状态**：本机与手边可用的机器都没有 Docker，所以**镜像构建本身未实测**。
> 但它调的每一步（`npm ci`、`npm run build`、`node server/dist/index.js`、静态资源与 SPA 回退、
> `/api/health`）都在裸机路径上实测过，Dockerfile 只是把这些包进容器。首次使用请留意构建日志。

```bash
docker compose up -d          # 用仓库根的 docker-compose.yml

# 国内网络：Docker Hub 与 npm 官方源通常不可达，改用镜像（已验证可达：daocloud / npmmirror）
NODE_IMAGE=docker.m.daocloud.io/library/node:24-alpine NPM_REGISTRY=https://registry.npmmirror.com docker compose up -d --build
# 或手工：
docker build -t megarac-next .
docker run -d --name megarac-next -p 5177:5177 \
  -e BMC_BASE=https://192.168.0.200 \
  -v megarac-data:/app/server/data \
  --restart unless-stopped megarac-next
```

镜像内置 `HEALTHCHECK`（打 `/api/health`，不依赖 BMC 是否在线）。

**构建时 `npm ci` 卡住不动怎么办**（2026-09-30 实测踩坑）：在 Ubuntu + Docker 29.7 的宿主上，
`RUN npm ci` 在 **buildkit 默认构建网络**里会一直挂着（进程无 I/O、无 socket，纯空转），
而**同样的命令在 `docker run` 里 7 秒就装完**。用 host 网络构建即可绕过：

```bash
docker build --network=host -t megarac-next .          # 命令行
# compose：在 build: 下加一行 network: host，再 docker compose up -d --build
```
这是宿主 Docker 构建网络的问题，与本项目无关。

## 5. 放在 TLS 反代后面（推荐）

代理与 BMC 之间本来就是 HTTPS，但**浏览器到代理这段默认是明文**。若要在内网之外访问，
请务必加一层 TLS，并把监听收到本机：

```caddy
# Caddy（自动证书）
bmc-ui.example.com {
    reverse_proxy 127.0.0.1:5177
}
```

```nginx
server {
    listen 443 ssl;
    server_name bmc-ui.example.com;
    ssl_certificate     /etc/ssl/bmc-ui.crt;
    ssl_certificate_key /etc/ssl/bmc-ui.key;
    location / {
        proxy_pass http://127.0.0.1:5177;
        proxy_http_version 1.1;
        # KVM 走 WebSocket，必须转发 Upgrade
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;   # KVM 长连接
    }
}
```

同时把进程改成 `HOST=127.0.0.1` 与 `COOKIE_SECURE=1`。

## 6. 安全须知（这个界面能做什么）

- **它等价于服务器的带外控制台**：能开机/关机/硬重启、能进 KVM 键盘、能改 BMC 配置。
  **不要直接暴露到公网**——请放在内网、VPN（如 Tailscale）或带鉴权与 TLS 的反代之后。
- **BMC 凭据只驻代理内存**：登录时透传给 BMC，不写磁盘、不进日志。
- 会话 cookie 是 `httpOnly` + `sameSite=strict`；HTTPS 部署请开 `COOKIE_SECURE=1`。
- 代理默认给 BMC 的自签证书关闭校验（`rejectUnauthorized:false`），这是与本机 BMC 通信的常规做法，
  但意味着**这段链路不做证书校验**——所以代理与 BMC 之间的网络必须可信（同一交换机/VLAN）。
- 应用本身没有多用户体系：每个浏览器各自持有自己的会话，**BMC 侧的权限就是该登录账号的权限**。

## 7. 运维与排错

**不要频繁重启**。每次非正常退出（含开发时 `tsx watch` 的每次热重载）都会在 BMC 侧留下**孤儿会话**，
要等 30 分钟超时才释放；web 会话表只有 148 格，**攒满后连登录都会被拒**（错误码 `15000`）。
界面现在会如实报「BMC 的 web 会话表已满」。救援有两条路：

1. **登录页的「重置 BMC」按钮（首选，无需登录）**：填上 BMC 账号密码 → 点它 → 确认后代理会用这组凭据
   向 BMC 的 **Redfish** 认证并调用 `Manager.Reset{ResetType:ForceRestart}`。
   之所以走 Redfish：会话表满时经典接口全线被拒，而 Redfish 仍能建会话（2026-09-30 实测），
   所以这是唯一还能自救的通道。实测：19 秒下线、145 秒恢复，配置（时区/NTP 等）保留。
2. IPMI 冷复位（UI 完全起不来时用）：

```bash
python reverse/ipmi_reset_bmc.py      # 需要 pyghmi 与 BMC_PASS；约 2.5 分钟，主机与虚拟机不受影响
```

其它常见现象：

| 现象 | 原因与处理 |
|---|---|
| 界面显示「数据可能过时」 | BMC 慢/短暂不可达，代理保留上一份好数据并自动重试；通常几十秒自愈 |
| 「Redfish 增补：… 暂不可用」 | 这台 BMC 的 Redfish 偶发挂起（`Chassis/Thermal` 尤甚），代理按资源熔断并后台重试，主干数据不受影响 |
| 登录报「BMC 的 web 会话表已满」 | 见上，冷复位 |
| KVM 连上但键鼠无效 | 说明本会话是从属（BMC 侧还有主控），代理会自动申请完全控制；若旧会话没释放，等它超时 |
| 历史趋势空 | 采样器借用登录会话，**需要至少有一个浏览器登录着**才会采样 |

**日志**：pino JSON 输出到 stdout（systemd → journald，Docker → `docker logs`）。
`GET /api/health` 返回代理自身状态、浏览器会话数、Redfish 客户端与增补各部分的就绪情况，适合做监控探针。

## 8. 升级

```bash
cd /opt/megarac-next
git pull
npm ci
npm run build
sudo systemctl restart megarac-next      # 或 docker compose up -d --build
```

升级不会动 BMC 的任何配置。若改了 BMC 固件/账号密码，只需在界面上重新登录。
