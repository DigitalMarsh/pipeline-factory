/**
 * 模块职责：让**本地 API 进程**弹出操作系统的"选择文件夹"对话框，把本机绝对路径交回浏览器。
 *
 * 为什么必须在服务端这一侧：浏览器拿不到绝对路径。`showDirectoryPicker()` 只给一个目录句柄
 *   （且 Firefox 没有这个接口），`<input webkitdirectory>` 只给相对路径——规范刻意不暴露路径，
 *   免得任意网页刺探你的目录结构。而 Project 的 `repoRoot` 必须是本机绝对路径（服务端要拿它
 *   跑 git、建 Worktree），所以只能由同一台机器上的本地进程去问操作系统。
 *
 * 维护提示：
 *   1) **取消不是错误**：用户点 Cancel 时命令以非零码退出（macOS 的 AppleScript 是 `-128`，
 *      zenity/kdialog 是 1，PowerShell 是空输出），这里统一映射成 `{ cancelled: true }`，
 *      由路由回 200。把它当 5xx 会让前端把"我不想选"显示成故障。
 *   2) **超时是真的会发生**：对话框等人点，子进程会一直挂着。到点杀进程并抛 `DIALOG_TIMEOUT`，
 *      不能让 HTTP 请求无限占着连接。**只有 Node 自己按 timeout 杀的才算超时**（`killed` 标志）；
 *      别的信号只说明子进程被外部打断，如实报 `DIALOG_FAILED`——把两者混为一谈会让用户
 *      等一个"其实早就结束"的对话框。
 *   3) 命令都缺（没装 zenity/kdialog、平台不认识）时抛 `DIALOG_UNSUPPORTED`，路由回 501 让前端
 *      提示手输。**不要静默失败**——"点了没反应"在这个仓库里已经被判定为缺陷，不是降级。
 *   4) 标题文案由本模块自己持有，**不从请求体取**：它会拼进 AppleScript / PowerShell 的命令字符串，
 *      接受外部输入就等于接受命令注入。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** 对话框标题；三个平台共用。改它等于改三个平台的 UI 文案。 */
export const DIRECTORY_DIALOG_PROMPT = "选择 Git 仓库根目录";

/** 等人点的时间上限：到点杀子进程并报超时。 */
export const DIRECTORY_DIALOG_TIMEOUT_MS = 5 * 60 * 1000;

export type DirectoryDialogResult = { path: string } | { cancelled: true };

export type DirectoryDialogErrorCode = "DIALOG_UNSUPPORTED" | "DIALOG_TIMEOUT" | "DIALOG_FAILED";

export class DirectoryDialogError extends Error {
  constructor(readonly code: DirectoryDialogErrorCode, message: string) {
    super(message);
    this.name = "DirectoryDialogError";
  }
}

/** 子进程的原始结果；`interpretDialogOutcome` 是把它翻译成业务语义的**唯一**地方。 */
export type DialogProcessResult = { exitCode: number | null; stdout: string; stderr: string };

type DialogCandidate = {
  command: string;
  args: string[];
  /** 这个平台的"用户取消了"长什么样。各平台不一样，且**不能靠英文文案**（系统可能是中文）。 */
  cancelled: (result: DialogProcessResult) => boolean;
};

/**
 * 一个平台可以有多个候选（Linux 的 zenity / kdialog）：按顺序尝试，只有 ENOENT（没装）才轮到下一个，
 * 装了的那个一旦报错就如实上报，不要静默换一个再弹一次。
 */
export function directoryDialogCandidates(platform: NodeJS.Platform): DialogCandidate[] {
  if (platform === "darwin") {
    return [{
      command: "osascript",
      args: ["-e", `POSIX path of (choose folder with prompt "${DIRECTORY_DIALOG_PROMPT}")`],
      // AppleScript 的"用户取消"是错误号 -128；文案会随系统语言变（中文是"用户已取消。"），
      // 所以先认错误号，再兜一层中英文关键词。
      cancelled: (result) => result.exitCode !== 0 && /-128|cancel|取消/i.test(result.stderr),
    }];
  }
  if (platform === "win32") {
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
      `$dialog.Description = '${DIRECTORY_DIALOG_PROMPT}'`,
      "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.SelectedPath }",
    ].join("; ");
    // 取消时正常退出、只是没有输出。
    const cancelled = (result: DialogProcessResult) => result.exitCode === 0 && !result.stdout.trim();
    return [{ command: "powershell", args: ["-NoProfile", "-STA", "-Command", script], cancelled }, { command: "pwsh", args: ["-NoProfile", "-Command", script], cancelled }];
  }
  if (platform === "linux") {
    const cancelled = (result: DialogProcessResult) => result.exitCode === 1 && !result.stdout.trim();
    return [{ command: "zenity", args: ["--file-selection", "--directory", `--title=${DIRECTORY_DIALOG_PROMPT}`], cancelled }, { command: "kdialog", args: ["--getexistingdirectory", process.env.HOME ?? "."], cancelled }];
  }
  return [];
}

/** 把一次子进程结果翻译成"选到了 / 取消了 / 失败了"。纯函数，便于按平台单测。 */
export function interpretDialogOutcome(candidate: DialogCandidate, result: DialogProcessResult): { kind: "path"; path: string } | { kind: "cancelled" } | { kind: "failed"; message: string } {
  if (candidate.cancelled(result)) return { kind: "cancelled" };
  const path = result.stdout.trim();
  if (result.exitCode === 0 && path) return { kind: "path", path };
  const detail = result.stderr.trim() || (result.exitCode === null ? "命令被信号中断" : `退出码 ${result.exitCode}`);
  return { kind: "failed", message: `${candidate.command} 未能返回目录：${detail}` };
}

/**
 * 弹对话框并等用户选。
 * `platform` / `timeoutMs` 只为测试留的口子；生产走缺省值（当前平台、5 分钟）。
 */
export async function chooseDirectory(options: { platform?: NodeJS.Platform; timeoutMs?: number } = {}): Promise<DirectoryDialogResult> {
  const candidates = directoryDialogCandidates(options.platform ?? process.platform);
  if (!candidates.length) throw new DirectoryDialogError("DIALOG_UNSUPPORTED", `当前平台（${options.platform ?? process.platform}）不支持弹出系统目录选择框，请手动输入绝对路径。`);
  let lastMissing = "";
  for (const candidate of candidates) {
    let result: DialogProcessResult;
    try {
      const output = await execFileAsync(candidate.command, candidate.args, { timeout: options.timeoutMs ?? DIRECTORY_DIALOG_TIMEOUT_MS });
      result = { exitCode: 0, stdout: String(output.stdout), stderr: String(output.stderr) };
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { code?: string | number; killed?: boolean; signal?: string; stdout?: string; stderr?: string };
      // 没装这个命令：换下一个候选，全都没装才报 UNSUPPORTED。
      if (failure.code === "ENOENT") { lastMissing = candidate.command; continue; }
      // **只有 Node 自己按 timeout 杀的才算超时**（那时 `killed` 为真）。别的信号只说明这个子进程
      // 被外部打断了（用户关了对话框、系统回收、进程被杀）——报成"等待选择超时"是在说谎，
      // 而且会把"再试一次就好"错写成"你等了五分钟"。
      if (failure.killed) throw new DirectoryDialogError("DIALOG_TIMEOUT", `等待选择超时（${Math.round((options.timeoutMs ?? DIRECTORY_DIALOG_TIMEOUT_MS) / 1000)} 秒），对话框已关闭。请重试或手动输入路径。`);
      result = {
        exitCode: typeof failure.code === "number" ? failure.code : null,
        stdout: failure.stdout ?? "",
        stderr: failure.stderr?.trim() ? failure.stderr : failure.signal ? `进程被信号中断（${failure.signal}）` : "",
      };
    }
    const outcome = interpretDialogOutcome(candidate, result);
    if (outcome.kind === "cancelled") return { cancelled: true };
    if (outcome.kind === "failed") throw new DirectoryDialogError("DIALOG_FAILED", outcome.message);
    return { path: outcome.path };
  }
  throw new DirectoryDialogError("DIALOG_UNSUPPORTED", `找不到可用的目录选择命令（缺 ${lastMissing}），请手动输入绝对路径。`);
}
