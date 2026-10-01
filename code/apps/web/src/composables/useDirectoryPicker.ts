/**
 * 模块职责：把"点按钮 → 让本地 API 弹系统文件夹选择框 → 回填绝对路径"这段交互收成一处，
 *   供两个新建 Project 的入口（ProjectCreateDialog 与 ProjectManagementDialog 的创建态）共用。
 *
 * 为什么不是纯前端：浏览器拿不到绝对路径（`showDirectoryPicker()` 只给目录句柄且 Firefox 没有，
 *   `<input webkitdirectory>` 只给相对路径），而 `repoRoot` 要的是本机绝对路径——对话框必须由
 *   本地 API 弹（见后端 `runtime/directory-dialog.ts` 的模块头）。
 *
 * 维护提示：
 *   1) **取消不是错误**：用户点了 Cancel 就返回 null，不提示、不写 error。把取消当失败是这类
 *      交互最常见的错法，用户看到的是"报错"而不是"我不想选"。
 *   2) 失败必须**说人话**：501（当前平台不支持）与 504（对话框超时）的后端文案要原样透出——
 *      这个按钮最容易变成"点了没反应"，那正是它存在的意义所在。
 *   3) 同一个按钮不要并发点：`picking` 期间直接忽略后续点击，否则会叠出多个系统对话框。
 */
import { ref, type Ref } from "vue";
import { api } from "../api";

export type DirectoryPickerDeps = {
  /** 失败时怎么展示：两个弹框各有自己的 error ref 与 ElMessage，由调用方决定。 */
  onError: (message: string) => void;
};

export type DirectoryPicker = {
  picking: Ref<boolean>;
  /** 弹框选目录。选到返回绝对路径；用户取消或出错返回 null（出错已经通过 onError 报过）。 */
  pickDirectory: () => Promise<string | null>;
};

export function useDirectoryPicker(deps: DirectoryPickerDeps): DirectoryPicker {
  const picking = ref(false);

  async function pickDirectory(): Promise<string | null> {
    if (picking.value) return null;
    picking.value = true;
    try {
      const result = await api.selectDirectory();
      return result.cancelled ? null : result.path;
    } catch (caught) {
      deps.onError(caught instanceof Error ? `打开文件夹选择框失败：${caught.message}` : "打开文件夹选择框失败");
      return null;
    } finally {
      picking.value = false;
    }
  }

  return { picking, pickDirectory };
}
