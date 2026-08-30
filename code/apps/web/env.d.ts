/**
 * 模块职责：承载 Pipeline Factory 的工程配置或入口边界。
 *
 * 维护提示：本文件的公共契约或关键状态约束变化时，应同步更新说明。
 */
/// <reference types="vite/client" />

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<object, object, unknown>;
  export default component;
}
