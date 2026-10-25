import React, { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ScrollView } from "react-native";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// The root Unistyles export is stubbed in this project. This is the real component
// entry emitted by its Babel plugin; importActual also supplies its missing public types.
const { ScrollView: StyledScrollView } = await vi.importActual<{ ScrollView: typeof ScrollView }>(
  "react-native-unistyles/components/native/ScrollView",
);

type ScrollRef = React.ComponentRef<typeof ScrollView>;
const mounted: { root: Root; container: HTMLDivElement }[] = [];
const reactTestEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
const previousActEnvironment = reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT;
const scrollStyles = {
  callbackInitial: { height: 71 },
  callbackReplacement: { height: 83 },
  callbackUpdated: { height: 97 },
  objectInitial: { height: 73 },
  objectReplacement: { height: 89 },
  original: { height: 79, width: 173, backgroundColor: "rgb(17, 31, 47)" },
  replacement: { height: 101, width: 181, backgroundColor: "rgb(53, 71, 89)" },
};

beforeAll(() => {
  reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
});

function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  return {
    container,
    render: async (children: React.ReactNode) => {
      await act(async () => root.render(children));
    },
    node: (testID: string) => {
      const node = container.querySelector<HTMLElement>(`[data-testid="${testID}"]`);
      if (!node) {
        throw new Error(`ScrollView did not mount: ${testID}`);
      }
      return node;
    },
  };
}

function expectScrollAPI(ref: ScrollRef | null, node: HTMLElement) {
  expect(ref).toBe(node);
  expect(ref?.scrollTo).toBeTypeOf("function");
  expect(ref?.scrollToEnd).toBeTypeOf("function");
  expect(ref?.flashScrollIndicators).toBeTypeOf("function");
  expect(ref?.getNativeScrollRef()).toBe(node);
  expect(ref?.getScrollableNode()).toBe(node);
  expect(ref?.getInnerViewNode()).toBe(node.firstElementChild);
}

function unistylesSelectors() {
  const sheet = document.querySelector<HTMLStyleElement>("style#unistyles-web")?.sheet;
  if (!sheet) {
    throw new Error("The real Unistyles browser stylesheet was not created");
  }
  return Array.from(sheet.cssRules)
    .filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule)
    .map((rule) => rule.selectorText);
}

function registeredSelector(node: HTMLElement) {
  const selectors = unistylesSelectors().filter((selector) =>
    Array.from(node.classList).some((className) => selector === `.${className}`),
  );
  expect(selectors).toHaveLength(1);
  return selectors[0]!;
}

describe("ScrollView web ref ownership", () => {
  it("detaches a replaced callback before attaching the same augmented node without churning stable refs", async () => {
    const view = mount();
    const transitions: [string, ScrollRef | null][] = [];
    const methodsAtAttach: unknown[] = [];
    const oldRef = vi.fn((node: ScrollRef | null) => {
      transitions.push(["old", node]);
      if (node) methodsAtAttach.push(node.scrollTo, node.getNativeScrollRef);
    });
    const newRef = vi.fn((node: ScrollRef | null) => {
      transitions.push(["new", node]);
      if (node) methodsAtAttach.push(node.scrollTo, node.getNativeScrollRef);
    });

    await view.render(
      <ScrollView ref={oldRef} testID="scroll" style={scrollStyles.callbackInitial} />,
    );
    const node = view.node("scroll");
    expect(node.isConnected).toBe(true);
    expect(transitions).toEqual([["old", node]]);
    expectScrollAPI(transitions[0]![1], node);

    await view.render(
      <ScrollView ref={newRef} testID="scroll" style={scrollStyles.callbackReplacement} />,
    );
    expect(view.node("scroll")).toBe(node);
    expect(transitions).toEqual([
      ["old", node],
      ["old", null],
      ["new", node],
    ]);
    expectScrollAPI(transitions[2]![1], node);
    expect(methodsAtAttach).toHaveLength(4);
    for (const method of methodsAtAttach) expect(method).toBeTypeOf("function");

    await view.render(
      <ScrollView ref={newRef} testID="scroll" style={scrollStyles.callbackUpdated} />,
    );
    expect(view.node("scroll")).toBe(node);
    expect(getComputedStyle(node).height).toBe("97px");
    expect(transitions).toEqual([
      ["old", node],
      ["old", null],
      ["new", node],
    ]);

    await view.render(null);
    expect(transitions).toEqual([
      ["old", node],
      ["old", null],
      ["new", node],
      ["new", null],
    ]);
    expect(node.isConnected).toBe(false);
    expect(view.container.childElementCount).toBe(0);
  });

  it("clears the previous object ref on replacement and the current object ref on unmount", async () => {
    const view = mount();
    const oldRef = createRef<ScrollRef>();
    const newRef = createRef<ScrollRef>();

    await view.render(
      <ScrollView ref={oldRef} testID="scroll" style={scrollStyles.objectInitial} />,
    );
    const node = view.node("scroll");
    expectScrollAPI(oldRef.current, node);
    expect(newRef.current).toBeNull();

    await view.render(
      <ScrollView ref={newRef} testID="scroll" style={scrollStyles.objectReplacement} />,
    );
    expect(view.node("scroll")).toBe(node);
    expect(oldRef.current).toBeNull();
    expectScrollAPI(newRef.current, node);

    await view.render(null);
    expect(oldRef.current).toBeNull();
    expect(newRef.current).toBeNull();
    expect(node.isConnected).toBe(false);
  });

  it("releases real Unistyles rules only after the last ScrollView owner detaches across style and ref changes", async () => {
    const view = mount();
    const oldValues: (ScrollRef | null)[] = [];
    const oldRef = (node: ScrollRef | null) => {
      oldValues.push(node);
    };
    const newRef = createRef<ScrollRef>();
    const originalStyle = scrollStyles.original;
    const replacementStyle = scrollStyles.replacement;
    const renderOwners = (changed: boolean, keepOriginalOwner: boolean) =>
      view.render(
        <>
          <StyledScrollView
            key="changing-owner"
            ref={changed ? newRef : oldRef}
            testID="styled-scroll"
            style={changed ? replacementStyle : originalStyle}
          />
          {keepOriginalOwner && (
            <StyledScrollView key="original-owner" testID="style-keeper" style={originalStyle} />
          )}
        </>,
      );

    await renderOwners(false, true);
    const node = view.node("styled-scroll");
    const keeper = view.node("style-keeper");
    const originalSelector = registeredSelector(node);
    expect(registeredSelector(keeper)).toBe(originalSelector);
    expect(oldValues).toEqual([node]);
    expect(getComputedStyle(node).backgroundColor).toBe("rgb(17, 31, 47)");

    await renderOwners(true, true);
    expect(view.node("styled-scroll")).toBe(node);
    expect(oldValues).toEqual([node, null]);
    expectScrollAPI(newRef.current, node);
    expect(getComputedStyle(node).backgroundColor).toBe("rgb(53, 71, 89)");
    const replacementSelector = registeredSelector(node);
    expect(replacementSelector).not.toBe(originalSelector);
    expect(unistylesSelectors()).toContain(originalSelector);

    // The changing ScrollView must no longer own its previous style. Keeping a
    // second real owner until now also guards against eager, global style clearing.
    await renderOwners(true, false);
    expect(keeper.isConnected).toBe(false);
    expect(unistylesSelectors()).not.toContain(originalSelector);
    expect(unistylesSelectors()).toContain(replacementSelector);
    expectScrollAPI(newRef.current, node);

    await view.render(null);
    expect(newRef.current).toBeNull();
    expect(oldValues).toEqual([node, null]);
    expect(node.isConnected).toBe(false);
    expect(view.container.childElementCount).toBe(0);
    expect(unistylesSelectors()).not.toContain(originalSelector);
    expect(unistylesSelectors()).not.toContain(replacementSelector);
  });
});
