# MegaRAC-Next

技嘉 MZ32-AR0（EPYC 7R32）BMC（AMI MegaRAC SP-X 12.x @ 192.168.0.200）Web UI 的现代化重制版。

## 设计共识（2026-09-28 grill 定稿）

- **架构**：Fastify (Node/TypeScript) 代理（仅绑 127.0.0.1，持有单个 BMC 会话多路复用）+ Vue 3 / Vite / Naive UI / ECharts SPA
- **认证**：登录页透传 BMC 账密，代理代登录；凭证仅驻代理内存，不落盘
- **功能 v1**：仪表盘/传感器/电源控制/SEL 日志、风扇控制页（含曲线编辑器）、系统设置页、传感器历史趋势（`HistoryStore` 接口 + SQLite 实现，保留 30 天，后续可换库）、KVM（最后做：先查现成实现 → 自研 → 跳转原版兜底）
- **纪律**：开发期间对 BMC **全程只读实测**，所有写操作只逆向协议、代码里实现但不在真实 BMC 上触发，上线前由用户在原版 UI 手动操作对照验证
- **工作流**：git 仓库，每完成一个可验证里程碑自动 commit
- **界面**：简体中文，暗色默认可切亮色

## 开发顺序

1. ✅ 逆向 + API 文档（`docs/API.md`）
2. Fastify 代理 + 透传登录
3. 仪表盘 / 传感器 / 电源页
4. 风扇控制页（曲线编辑器）
5. 传感器历史落盘（HistoryStore 接口 + SQLite）
6. 设置页（FRU/用户/网络/NTP）
7. KVM（现成库调研 → 自研 → 跳转兜底）

## 目录

```
docs/       逆向文档（API.md）
reverse/    逆向工作区（分析脚本 + API 响应样本；AMI 的 bundle 文件不入库）
server/     Fastify 代理（阶段②）
web/        Vue3 前端（阶段③起）
```
