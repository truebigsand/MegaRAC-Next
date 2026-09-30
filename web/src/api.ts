// 兼容层：老页面从 './api' 或 '../api' 引入 login/logout/bmcGet/bmcSend/localGet。
// 实现已搬到 api/client.ts（新增归一化接口 apiGet、ApiError、请求去重），这里只做转出，
// 避免一次性改动所有页面；新页面请直接从 api/client 与 api/useResource 引入。
export { login, logout, bmcGet, bmcSend, localGet, apiGet, ApiError } from './api/client';
