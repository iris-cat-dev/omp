import { afterEach, describe, expect, it, vi } from "vitest";
import type { CSSState as CSSStateType } from "../../../../node_modules/react-native-unistyles/lib/typescript/src/web/css/state";

// Use the component entrypoint to initialize the dependency's cyclic service graph.
await vi.importActual("react-native-unistyles/components/native/ScrollView");
const { CSSState } = await vi.importActual<{ CSSState: typeof CSSStateType }>(
  "../../../../node_modules/react-native-unistyles/lib/module/web/css/state.js",
);

type Services = ConstructorParameters<typeof CSSState>[0];
const services = {
  runtime: {},
  state: { getConfig: () => ({}) },
} as Services;
const elements: HTMLElement[] = [];

function probe(className: string) {
  const node = document.createElement("div");
  node.className = className;
  document.body.appendChild(node);
  elements.push(node);
  return node;
}

function state() {
  document.getElementById("unistyles-web")?.remove();
  return new CSSState(services);
}

afterEach(() => {
  elements.splice(0).forEach((node) => node.remove());
  document.getElementById("unistyles-web")?.remove();
  document.documentElement.classList.remove("stylesheet-test-theme");
});

describe("Unistyles stylesheet updates", () => {
  it("preserves cascade order when updating, removing and remounting workspace styles", () => {
    const css = state();
    const node = probe("workspace shared");
    css.add("workspace", { color: "rgb(11, 22, 33)", width: 140 });
    css.add("shared", { color: "rgb(44, 55, 66)" });
    expect(getComputedStyle(node).color).toBe("rgb(44, 55, 66)");

    css.add("workspace", { color: "rgb(77, 88, 99)", width: 180 });
    expect(getComputedStyle(node).color).toBe("rgb(44, 55, 66)");
    expect(getComputedStyle(node).width).toBe("180px");

    css.remove("shared");
    expect(getComputedStyle(node).color).toBe("rgb(77, 88, 99)");
    css.add("shared", { color: "rgb(101, 112, 123)" });
    expect(getComputedStyle(node).color).toBe("rgb(101, 112, 123)");
  });

  it("keeps media-query precedence, pseudo-elements and child selectors while adding earlier groups", () => {
    const css = state();
    const node = probe("responsive");
    const child = document.createElement("span");
    node.appendChild(child);
    css.set({
      className: "responsive",
      propertyKey: "color",
      value: "rgb(44, 55, 66)",
      mediaQuery: "@media (min-width: 0px)",
      isMq: true,
    });
    css.recreate();
    css.add("responsive", { color: "rgb(11, 22, 33)" });
    css.set({ className: "responsive::before", propertyKey: "content", value: '"marker"' });
    css.add("responsive > *", { fontSize: 23 });
    css.set({
      className: "responsive",
      propertyKey: "color",
      value: "rgb(77, 88, 99)",
      mediaQuery: "@media (min-width: 100000px)",
    });
    css.recreate();
    expect(getComputedStyle(node).color).toBe("rgb(44, 55, 66)");
    expect(getComputedStyle(node, "::before").content).toBe('"marker"');
    expect(getComputedStyle(child).fontSize).toBe("23px");

    css.remove("responsive");
    expect(getComputedStyle(node).color).not.toBe("rgb(44, 55, 66)");
    expect(getComputedStyle(child).fontSize).toBe("23px");
  });

  it("retains hydrated styles and applies theme changes without losing later rules", () => {
    const original = state();
    original.addTheme("stylesheet-test-theme", { colors: { primary: "rgb(11, 22, 33)" } });
    original.add("hydrated", { color: "var(--colors-primary)" });
    const snapshot = original.getState();
    const serialized = original.getStyles();
    document.getElementById("unistyles-web")!.remove();
    const ssr = document.createElement("style");
    ssr.id = "unistyles-web";
    ssr.textContent = serialized;
    document.head.appendChild(ssr);
    document.documentElement.classList.add("stylesheet-test-theme");
    const node = probe("hydrated later");
    expect(getComputedStyle(node).color).toBe("rgb(11, 22, 33)");

    const css = new CSSState(services);
    css.addTheme("stylesheet-test-theme", { colors: { primary: "rgb(11, 22, 33)" } });
    css.hydrate(snapshot);
    css.add("later", { width: 171 });
    expect(getComputedStyle(node).color).toBe("rgb(11, 22, 33)");
    expect(getComputedStyle(node).width).toBe("171px");
    css.addTheme("stylesheet-test-theme", { colors: { primary: "rgb(77, 88, 99)" } });
    css.recreate();
    expect(getComputedStyle(node).color).toBe("rgb(77, 88, 99)");
    expect(getComputedStyle(node).width).toBe("171px");
  });

  it("removes cleared declarations and does not restore stale rules after a registry reset", () => {
    const css = state();
    const node = probe("workspace");
    css.add("workspace", { width: 140, color: "rgb(11, 22, 33)" });
    css.set({ className: "workspace", propertyKey: "color", value: undefined });
    css.recreate();
    expect(getComputedStyle(node).color).not.toBe("rgb(11, 22, 33)");
    expect(getComputedStyle(node).width).toBe("140px");

    css.reset();
    css.add("workspace", { width: 180, color: "rgb(77, 88, 99)" });
    expect(getComputedStyle(node).width).toBe("180px");
    expect(getComputedStyle(node).color).toBe("rgb(77, 88, 99)");
  });
});
