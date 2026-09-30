// Windows 控制台默认代码页是 GBK(936)，而 Node 往 stdout 写的是 UTF-8 字节，
// 于是中文日志在 cmd / PowerShell 里会显示成乱码（例如「代理已启动」变成「浠ｇ悊宸插惎鍔?」）。
// 这里在真正的服务进程启动前，把当前控制台切到 UTF-8。
//
// 只在 Windows 上做；没有控制台（输出被重定向或走管道）时 chcp 会失败，忽略即可——
// 那种情况下编码由读端决定，本来就没问题。
import { execSync } from 'node:child_process';

if (process.platform === 'win32') {
  try {
    execSync('chcp 65001', { stdio: 'ignore' });
  } catch {
    /* 无控制台或不允许修改，忽略 */
  }
}
