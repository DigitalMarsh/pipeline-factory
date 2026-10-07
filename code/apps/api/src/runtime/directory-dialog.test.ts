/**
 * 测试职责：锁住"各平台的取消长什么样"与"选到的路径怎么取"——这两件事全在
 *   `interpretDialogOutcome` 这一个纯函数里，所以这里**不弹任何对话框**。
 *
 * 设计说明：取消判定是这段代码最容易出错的地方，而且错法很隐蔽——把取消当成失败，用户看到的
 *   是"点了没反应/报错"，而不是"我不想选"。所以三个平台各来一条取消用例，且特别锁住
 *   **中文系统的 AppleScript 文案**（错误号 -128 是唯一跨语言可靠的信号）。
 *
 * 维护提示：新增平台时，先加 `directoryDialogCandidates` 的候选与取消判据，再在这里补两条
 *   （取消 / 选到）用例；不要在这里启动子进程。
 */
import { describe, expect, it } from "vitest";
import {
  chooseDirectory,
  directoryDialogCandidates,
  DirectoryDialogError,
  interpretDialogOutcome,
  type DialogProcessResult,
} from "./directory-dialog.js";

const candidates = (platform: NodeJS.Platform) => directoryDialogCandidates(platform);
const first = (platform: NodeJS.Platform) => candidates(platform)[0]!;
const outcome = (platform: NodeJS.Platform, result: DialogProcessResult) => interpretDialogOutcome(first(platform), result);

describe("directoryDialogCandidates", () => {
  it("gives each supported platform a command, and none for the rest", () => {
    expect(first("darwin").command).toBe("osascript");
    expect(candidates("win32").map((candidate) => candidate.command)).toEqual(["powershell", "pwsh"]);
    // Linux 有两个候选：只有"没装"才轮到下一个（见 chooseDirectory 的 ENOENT 分支）。
    expect(candidates("linux").map((candidate) => candidate.command)).toEqual(["zenity", "kdialog"]);
    expect(candidates("aix")).toEqual([]);
  });

  it("refuses unsupported platforms with a message that tells the user what to do", async () => {
    await expect(chooseDirectory({ platform: "aix" })).rejects.toBeInstanceOf(DirectoryDialogError);
    await expect(chooseDirectory({ platform: "aix" })).rejects.toMatchObject({ code: "DIALOG_UNSUPPORTED" });
  });
});

describe("interpretDialogOutcome", () => {
  it("reads a chosen path from stdout and trims the newline", () => {
    expect(outcome("darwin", { exitCode: 0, stdout: "/Users/bill/repo\n", stderr: "" })).toEqual({
      kind: "path",
      path: "/Users/bill/repo",
    });
    expect(outcome("win32", { exitCode: 0, stdout: "C:\\repo\r\n", stderr: "" })).toEqual({ kind: "path", path: "C:\\repo" });
  });

  it("treats cancel as cancel on every platform — including a Chinese-locale AppleScript error", () => {
    // macOS：AppleScript 用错误号 -128 表示用户取消，文案随系统语言变。
    expect(outcome("darwin", { exitCode: 1, stdout: "", stderr: "execution error: 用户已取消。 (-128)" })).toEqual({ kind: "cancelled" });
    expect(outcome("darwin", { exitCode: 1, stdout: "", stderr: "execution error: User canceled. (-128)" })).toEqual({ kind: "cancelled" });
    // Windows：取消是"正常退出但没有输出"。
    expect(outcome("win32", { exitCode: 0, stdout: "", stderr: "" })).toEqual({ kind: "cancelled" });
    // Linux：zenity 取消是退出码 1 且无输出。
    expect(outcome("linux", { exitCode: 1, stdout: "", stderr: "" })).toEqual({ kind: "cancelled" });
  });

  it("reports a real failure with the command and its own words", () => {
    const failed = outcome("darwin", { exitCode: 1, stdout: "", stderr: "execution error: 找不到 Finder (-1728)" });
    expect(failed.kind).toBe("failed");
    expect(failed.kind === "failed" ? failed.message : "").toContain("osascript");
    expect(failed.kind === "failed" ? failed.message : "").toContain("-1728");
  });

  it("treats an interrupted process as a failure, not as a timeout", () => {
    // 退出码为 null = 进程被信号打断（外部关掉对话框、进程被杀）。它**不是**"等超时"，
    // 说成超时会让用户去等一个早就不在的对话框。
    const interrupted = outcome("darwin", { exitCode: null, stdout: "", stderr: "进程被信号中断（SIGTERM）" });
    expect(interrupted.kind).toBe("failed");
    expect(interrupted.kind === "failed" ? interrupted.message : "").toContain("SIGTERM");
    expect(interrupted.kind === "failed" ? interrupted.message : "").not.toContain("超时");
  });

  it("does not mistake a stderr-only success for a failure", () => {
    // 有的实现会把警告写到 stderr 但正常返回路径：只要退出码为 0 且有输出，就算选到了。
    expect(outcome("darwin", { exitCode: 0, stdout: "/Users/bill/repo\n", stderr: "warning: something" })).toEqual({
      kind: "path",
      path: "/Users/bill/repo",
    });
  });
});
