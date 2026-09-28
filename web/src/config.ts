/** 全局开关：写操作（电源控制/风扇写入/设置保存）默认关闭。
 *  项目纪律：开发期间不对真实 BMC 触发任何写操作；
 *  待用户在原版 UI 对照验证后，把此开关改为 true 接通。 */
export const WRITE_OPS_ENABLED = false;
