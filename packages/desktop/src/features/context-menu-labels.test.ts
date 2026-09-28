import { describe, expect, it } from "vitest";
import {
  getDesktopContextMenuLabels,
  setDesktopContextMenuLabels,
  type DesktopContextMenuLabels,
} from "./context-menu-labels.js";

const localizedLabels: DesktopContextMenuLabels = {
  addToDictionary: "添加到词典",
  clear: "清空",
  copy: "复制",
  copyAddress: "复制链接地址",
  copyImage: "复制图像",
  cut: "剪切",
  inspectElement: "检查元素",
  noSuggestions: "无建议",
  openExternal: "在浏览器中打开链接",
  openInDesktop: "在 OMP Desktop 中打开",
  paste: "粘贴",
  quitApp: "退出",
  saveImageAs: "图像另存为…",
  selectAll: "全选",
  showApp: "显示 OMP Desktop",
};

describe("desktop context menu labels", () => {
  it("switches every native context-menu label as one validated locale snapshot", () => {
    expect(setDesktopContextMenuLabels(localizedLabels)).toBe(true);
    expect(getDesktopContextMenuLabels()).toEqual(localizedLabels);
  });

  it("rejects partial snapshots without replacing the active labels", () => {
    expect(setDesktopContextMenuLabels({ copy: "Copy" })).toBe(false);
    expect(getDesktopContextMenuLabels()).toEqual(localizedLabels);
  });
});
