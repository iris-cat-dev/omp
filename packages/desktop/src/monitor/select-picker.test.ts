/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MONITOR_SELECT_PICKER_SCRIPT } from "./select-picker";

interface Picker {
  install(): void;
  close(restoreFocus?: boolean): boolean;
}
let frame: HTMLIFrameElement;
let realm: Window & typeof globalThis;
let picker: Picker;
let appearance: HTMLSelectElement;
let currency: HTMLSelectElement;

function mouse(element: Element, type: string, detail = 1) {
  const event = new realm.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, detail });
  element.dispatchEvent(event);
  return event;
}
function key(element: Element, value: string, options: KeyboardEventInit = {}, type = "keydown") {
  const event = new realm.KeyboardEvent(type, {
    bubbles: true,
    cancelable: true,
    key: value,
    ...options,
  });
  element.dispatchEvent(event);
  return event;
}
function popup() {
  return realm.document.querySelector<HTMLDivElement>('[role="listbox"]')!;
}
function option(value: string) {
  return Array.from(popup().querySelectorAll<HTMLButtonElement>('[role="option"]')).find(
    (button) => button.dataset.value === value,
  )!;
}
function open(select: HTMLSelectElement) {
  expect(mouse(select, "mousedown").defaultPrevented).toBe(true);
  expect(popup().hidden).toBe(false);
}

beforeEach(() => {
  frame = document.createElement("iframe");
  document.body.append(frame);
  realm = frame.contentWindow as Window & typeof globalThis;
  realm.document.body.innerHTML = `
    <select id="appearance" aria-label="Appearance">
      <option value="system">System</option><option value="light">Light</option>
      <option value="blocked" disabled>Unavailable</option><option value="dark">Dark</option>
    </select>
    <select id="currency" aria-label="Display currency">
      <option value="USD">USD · US Dollar</option><option value="CAD">CAD · Canadian Dollar</option>
      <option value="CNY">CNY · Chinese Yuan</option>
    </select><button id="outside">Another control</button>`;
  Object.defineProperty(realm.HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value() {},
  });
  picker = new Function(
    "document",
    "window",
    "Event",
    "performance",
    "getComputedStyle",
    MONITOR_SELECT_PICKER_SCRIPT + "\nreturn monitorSelectPicker;",
  )(realm.document, realm, realm.Event, realm.performance, realm.getComputedStyle.bind(realm));
  appearance = realm.document.getElementById("appearance") as HTMLSelectElement;
  currency = realm.document.getElementById("currency") as HTMLSelectElement;
  picker.install();
});
afterEach(() => {
  picker.close();
  frame.remove();
});

describe("in-window monitor select picker", () => {
  it("cancels native mousedown opening and commits a visible option once through the existing form value", () => {
    const changes: string[] = [];
    appearance.addEventListener("input", () => changes.push("input:" + appearance.value));
    appearance.addEventListener("change", () => changes.push("change:" + appearance.value));
    open(appearance);
    expect(appearance.value).toBe("system");
    expect(appearance.getAttribute("aria-expanded")).toBe("true");
    mouse(option("light"), "click");
    expect(appearance.value).toBe("light");
    expect(changes).toEqual(["input:light", "change:light"]);
    expect(popup().hidden).toBe(true);
    expect(appearance.getAttribute("aria-expanded")).toBe("false");
    expect(realm.document.activeElement).toBe(appearance);
    open(appearance);
    mouse(option("light"), "click");
    expect(changes).toEqual(["input:light", "change:light"]);
  });

  it("Escape cancels only the picker, preserves the value and allows the next selection", () => {
    let parentEscapes = 0;
    realm.document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") parentEscapes++;
    });
    open(appearance);
    key(appearance, "ArrowDown");
    expect(appearance.value).toBe("system");
    expect(key(appearance, "Escape").defaultPrevented).toBe(true);
    expect(parentEscapes).toBe(0);
    expect(popup().hidden).toBe(true);
    expect(appearance.value).toBe("system");
    open(appearance);
    mouse(option("dark"), "click");
    expect(appearance.value).toBe("dark");
  });

  it("outside pointer dismissal does not commit a highlighted choice and another selector stays usable", () => {
    open(appearance);
    key(appearance, "End");
    realm.document
      .getElementById("outside")!
      .dispatchEvent(new realm.Event("pointerdown", { bubbles: true }));
    expect(popup().hidden).toBe(true);
    expect(appearance.value).toBe("system");
    open(currency);
    mouse(option("CNY"), "click");
    expect(currency.value).toBe("CNY");
    expect(appearance.getAttribute("aria-expanded")).toBe("false");
  });

  it.each([
    ["F4", {}],
    ["ArrowDown", { altKey: true }],
    [" ", {}],
    ["Enter", {}],
  ] as const)(
    "intercepts the native %s opening gesture before its default handler",
    (value, options) => {
      expect(key(appearance, value, options).defaultPrevented).toBe(true);
      expect(popup().hidden).toBe(false);
      expect(appearance.getAttribute("aria-expanded")).toBe("true");
      for (const character of [" ", "Enter"]) {
        expect(key(appearance, character, {}, "keypress").defaultPrevented).toBe(true);
      }
      expect(appearance.value).toBe("system");
    },
  );

  it("skips disabled choices for both keyboard and pointer selection without duplicate changes", () => {
    let changes = 0;
    appearance.addEventListener("change", () => changes++);
    open(appearance);
    expect(option("blocked").disabled).toBe(true);
    mouse(option("blocked"), "click");
    expect(appearance.value).toBe("system");
    key(appearance, "ArrowDown");
    key(appearance, "ArrowDown");
    key(appearance, "Enter");
    expect(appearance.value).toBe("dark");
    expect(changes).toBe(1);
    expect(key(appearance, "ArrowUp").defaultPrevented).toBe(true);
    expect(appearance.value).toBe("light");
    expect(changes).toBe(2);
  });

  it("does not open a disabled selector", () => {
    appearance.disabled = true;
    mouse(appearance, "mousedown");
    expect(realm.document.querySelector('[role="listbox"]')).toBeNull();
    expect(appearance.getAttribute("aria-expanded")).toBe("false");
  });

  it("rejects a stale option when its native option list was replaced while open", () => {
    let changes = 0;
    appearance.addEventListener("change", () => changes++);
    open(appearance);
    const stale = option("light");
    appearance.replaceChildren(new realm.Option("A different current choice", "current"));
    mouse(stale, "click");
    expect(appearance.value).toBe("current");
    expect(changes).toBe(0);
    expect(popup().hidden).toBe(true);
  });

  it("typeahead uses the focused selector and can refine a prefix without opening a native popup", () => {
    appearance.focus();
    key(appearance, "s");
    currency.focus();
    key(currency, "c");
    expect(currency.value).toBe("CAD");
    key(currency, "n");
    expect(currency.value).toBe("CNY");
    expect(realm.document.querySelector('[role="listbox"]')).toBeNull();
  });

  it("Tab dismisses the picker without committing or preventing normal focus movement", () => {
    open(appearance);
    key(appearance, "End");
    expect(key(appearance, "Tab").defaultPrevented).toBe(false);
    expect(appearance.value).toBe("system");
    expect(popup().hidden).toBe(true);
  });
});
