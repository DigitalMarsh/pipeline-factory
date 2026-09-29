/**
 * 模块职责：共享"这个进程里能用哪些 agent"的目录 —— 从 `GET /api/v4/model-backends` 取一次，
 *   供 Project 设置页、设置弹窗与项目执行会话面板共同消费。
 *
 * 为什么是模块级缓存而不是每次挂载都取：目录由**服务端配置**决定，一次进程生命周期内不变；
 *   三个入口各取一次既浪费请求，也会让同一个页面上的两个下拉看到不同的清单。
 *
 * 维护提示：
 *   1) 取不到时**不抛错、不编造清单**：目录为空时下拉会退回"只显示当前值"（见 utils/modelCatalog.ts
 *      的维护提示 3）。API 重启期间设置页仍可打开只是清单空——这比整页报错好。
 *   2) `load()` 是幂等的：并发调用共享同一个 in-flight promise。传 `force` 才会重取
 *      （目前只有"保存后想确认新后端已生效"这类场景需要）。
 */
import { ref } from "vue";
import { api } from "../api";
import type { ModelBackendsResponse } from "../types";

const catalog = ref<ModelBackendsResponse | null>(null);
const loadError = ref<string | null>(null);
let pending: Promise<void> | null = null;

export function useModelBackends() {
  async function load(force = false): Promise<void> {
    if (!force && catalog.value) return;
    if (!force && pending) return pending;
    // Promise.resolve().then(...) 而不是直接调用：facade 上少了这个方法时同步抛错会打断挂载，
    // 而"目录取不到"应当是降级（下拉只显示当前值），不是让整个面板崩掉。
    pending = Promise.resolve()
      .then(() => api.modelBackends())
      .then((response) => { catalog.value = response; loadError.value = null; })
      .catch((caught: unknown) => {
        loadError.value = caught instanceof Error ? caught.message : "模型后端目录加载失败";
        if (force) catalog.value = null;
      })
      .finally(() => { pending = null; });
    return pending;
  }

  return { catalog, loadError, load };
}
