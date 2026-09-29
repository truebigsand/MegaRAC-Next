# MegaRAC-Next

技嘉 MZ32-AR0（EPYC 7R32）BMC（AMI MegaRAC SP-X 12.x @ 192.168.0.200）Web UI 的现代化重制版。

## 设计共识（2026-09-28 grill 定稿）

- **架构**：Fastify (Node/TypeScript) 代理（仅绑 127.0.0.1，持有单个 BMC 会话多路复用）+ Vue 3 / Vite / Naive UI / ECharts SPA
- **认证**：登录页透传 BMC 账密，代理代登录；凭证仅驻代理内存，不落盘
- **功能 v1**：仪表盘/传感器/电源控制/SEL 日志、风扇控制页（含曲线编辑器）、系统设置页、传感器历史趋势（`HistoryStore` 接口 + SQLite 实现，保留 30 天，后续可换库）、KVM（最后做：先查现成实现 → 自研 → 跳转原版兜底）
- **纪律**：写操作已全部启用（有二次确认弹窗兜底）；逆向阶段的关键结论都区分「实测」与「推断」
- **工作流**：git 仓库，每完成一个可验证里程碑自动 commit
- **界面**：简体中文，暗色默认可切亮色

## 开发顺序（全部完成 ✅，写操作待验证后开放）

1. ✅ 逆向 + API 文档（`docs/API.md`）
2. ✅ Fastify 代理 + 透传登录
3. ✅ 仪表盘 / 传感器 / 电源页
4. ✅ 风扇控制页（曲线编辑器）
5. ✅ 传感器历史落盘（HistoryStore 接口 + SQLite，`server/data/history.sqlite3`）
6. ✅ 设置页（FRU/用户/网络/NTP/服务，只读）
7. ✅ KVM（**自研播放器已真机跑通**：服务端中继 + AST2100 解码 + 画面渲染 + 键鼠输入）

## 启动

```bash
npm install
npm run dev:server   # Fastify 代理，监听 0.0.0.0:5177（HOST/PORT 可用环境变量覆盖）
npm run dev:web      # Vue3 开发服务器，监听 0.0.0.0:5173
```

两端默认监听所有网卡，同一局域网（或 Tailscale 网段）内可直接用本机 IP 访问，
例如 `http://192.168.0.101:5173`。访问者仍需输入 BMC 账号密码登录，代理不保存凭证。

写操作：已全部启用（电源控制/风扇写入均有二次确认弹窗兜底）。

## KVM 自研播放器

不复用原版 `viewer.min.js`，只复用 BMC 自带的 AST2100 解码 worker。结构：

```
server/src/kvm.ts       与 BMC 的 /kvm 建连 + IVTP 握手 + 字节中继
server/src/kvm-route.ts /api/kvm（WebSocket 中继）、/api/kvm/decoder.js（解码 worker 代理）
server/src/hid.ts       键鼠 HID 报文构造（与原版逐字节一致）
web/src/kvm/client.ts   协议流重组 → 帧重组 → 解码 worker → ImageData
web/src/kvm/keymap.ts   KeyboardEvent.code → USB HID 键码
web/src/pages/Kvm.vue   canvas 渲染 + 全局键鼠/触屏输入
```

为什么要服务端中继：BMC 用自签证书，浏览器直连要先导入证书；
且握手需要 token/会话串/客户端 IP，放服务端可让浏览器不持有第二套凭证。

**已验证**（2026-09-29，主机为 MZ32-AR0 上的 ESXi 8.0 DCUI）：画面渲染正常，
`F2` 能唤出 DCUI 登录框并输入账号回显；`Esc` 能关闭。
鼠标报文已与原版逐字节核对并送达，但 ESXi DCUI 不支持鼠标，指针效果待在有鼠标的客机上验证。

**已知限制**：同时只允许一个主控会话。若已有别的会话占着主控，
本代理会发 `CMD_SET_NEXT_MASTER` 申请完全控制并等待（此期间画面可见、键鼠无效），
自身为主控时则自动同意他人的申请。详见 `docs/API.md` 第 7 节。

## 目录

```
docs/       逆向文档（API.md）
reverse/    逆向工作区（分析脚本 + API 响应样本；AMI 的 bundle 文件不入库）
server/     Fastify 代理（阶段②）
web/        Vue3 前端（阶段③起）
```
