export type WorkbenchLayout = {
  mode: "wide" | "compact" | "stacked";
  showHistory: boolean;
  showContext: boolean;
  showMobileTabs: boolean;
};

/** Workbench 的断点契约；实际面板切换由同一断点下的 CSS/移动端 tabs 完成。 */
export function workbenchLayoutForWidth(width: number): WorkbenchLayout {
  if (width <= 720) return { mode: "stacked", showHistory: true, showContext: true, showMobileTabs: true };
  if (width <= 1_120) return { mode: "compact", showHistory: true, showContext: false, showMobileTabs: false };
  return { mode: "wide", showHistory: true, showContext: true, showMobileTabs: false };
}
