/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { currencySearchRank, MONITOR_SELECT_PICKER_SCRIPT } from "./select-picker";
import { MONITOR_POPUP_MOTION_SCRIPT } from "./popup-motion";

interface Picker {
  install(root?: ParentNode): void;
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
    MONITOR_POPUP_MOTION_SCRIPT + MONITOR_SELECT_PICKER_SCRIPT + "\nreturn monitorSelectPicker;",
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

  it("reinstalls idempotently without closing an open picker or dispatching duplicate changes", () => {
    let changes = 0;
    appearance.addEventListener("change", () => changes++);
    picker.install();
    picker.install(realm.document.body);
    open(appearance);
    picker.install();
    expect(popup().hidden).toBe(false);
    expect(appearance.getAttribute("aria-expanded")).toBe("true");
    mouse(option("light"), "click");
    expect(appearance.value).toBe("light");
    expect(changes).toBe(1);
    expect(popup().hidden).toBe(true);
  });

  it("installs a dynamically mounted section without intercepting an unrelated new select", () => {
    const section = realm.document.createElement("section");
    const select = realm.document.createElement("select");
    select.id = "dynamic-model";
    select.append(new realm.Option("Model A", "a"), new realm.Option("Model B", "b"));
    section.append(select);
    const unrelated = realm.document.createElement("select");
    unrelated.append(new realm.Option("Unrelated", "other"));
    realm.document.body.append(section, unrelated);
    picker.install(section);
    picker.install(section);
    expect(mouse(unrelated, "mousedown").defaultPrevented).toBe(false);
    let changes = 0;
    select.addEventListener("change", () => changes++);
    open(select);
    mouse(option("b"), "click");
    expect(select.value).toBe("b");
    expect(changes).toBe(1);
  });

  it("closes a disconnected owner and installs its replacement before another native open gesture", () => {
    open(appearance);
    const replacement = appearance.cloneNode(true) as HTMLSelectElement;
    appearance.replaceWith(replacement);
    picker.install(realm.document.body);
    expect(popup().hidden).toBe(true);
    expect(appearance.getAttribute("aria-expanded")).toBe("false");
    open(replacement);
    mouse(option("dark"), "click");
    expect(replacement.value).toBe("dark");
    expect(appearance.value).toBe("system");
  });
  it("searches the actual currency options, commits a highlighted filtered result and restores focus", () => {
    currency.dataset.searchable = "true";
    currency.dataset.searchLabel = "Search currencies";
    currency.dataset.emptyLabel = "No matching currency";
    currency.dataset.clearLabel = "Clear";
    for (const entry of Array.from(currency.options)) {
      entry.dataset.localizedName = entry.textContent!.split(" · ")[1]!;
      entry.dataset.englishName = entry.dataset.localizedName;
    }
    mouse(currency, "mousedown");
    const search = realm.document.getElementById("monitor-currency-search") as HTMLInputElement;
    expect(realm.document.activeElement).toBe(search);
    search.value = "yuan";
    search.dispatchEvent(new realm.Event("input", { bubbles: true }));
    const listed = realm.document.querySelectorAll("#monitor-select-picker [role=option]");
    expect(Array.from(listed, (entry) => (entry as HTMLElement).dataset.value)).toEqual(["CNY"]);
    expect(currency.value).toBe("USD");
    expect(key(search, "Enter").defaultPrevented).toBe(true);
    expect(currency.value).toBe("CNY");
    expect(realm.document.getElementById("monitor-select-picker")!.hidden).toBe(true);
    expect(realm.document.activeElement).toBe(currency);
  });

  it("right-aligns the original currency flyout and centers its current row only after the list is visible", () => {
    currency.dataset.searchable = "true";
    currency.value = "CNY";
    Object.defineProperty(currency, "getBoundingClientRect", {
      value: () => ({ left: 500, right: 700, top: 120, bottom: 152, width: 200, height: 32 }),
    });
    const prototype = realm.HTMLElement.prototype,
      originalBounds = prototype.getBoundingClientRect;
    Object.defineProperty(prototype, "getBoundingClientRect", {
      value(this: HTMLElement) {
        if (this.classList.contains("monitor-currency-list") || this.dataset.value === "CNY") {
          const root = this.closest<HTMLElement>("#monitor-select-picker")!;
          expect(root.hidden).toBe(false);
          expect(root.style.visibility).not.toBe("hidden");
          if (this.classList.contains("monitor-currency-list"))
            return { left: 0, right: 320, top: 0, bottom: 300, width: 320, height: 300 };
          return { left: 0, right: 300, top: 600, bottom: 634, width: 300, height: 34 };
        }
        return originalBounds.call(this);
      },
    });
    Object.defineProperty(prototype, "clientHeight", {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains("monitor-currency-list") ? 300 : 0;
      },
    });
    mouse(currency, "mousedown");
    const root = realm.document.getElementById("monitor-select-picker")!;
    expect(root.hidden).toBe(false);
    expect(root.style.left).toBe("380px");
    expect(root.style.top).toBe("156px");
    expect(currency.getAttribute("aria-haspopup")).toBe("dialog");
    expect(realm.document.activeElement).toBe(
      realm.document.getElementById("monitor-currency-search"),
    );
    expect(realm.document.querySelector(".monitor-currency-list")!.scrollTop).toBe(467);
  });

  it("cycles Tab through search and the highlighted real currency row, with filtered list keyboard commit", () => {
    currency.dataset.searchable = "true";
    currency.options[2]!.dataset.localizedName = "Chinese Yuan";
    mouse(currency, "mousedown");
    const search = realm.document.getElementById("monitor-currency-search") as HTMLInputElement;
    const current = option("USD");
    key(search, "Tab");
    expect(realm.document.activeElement).toBe(current);
    expect(realm.document.getElementById("monitor-select-picker")!.hidden).toBe(false);
    key(current, "ArrowDown");
    expect(realm.document.activeElement).toBe(option("CAD"));
    key(option("CAD"), "Tab", { shiftKey: true });
    expect(realm.document.activeElement).toBe(search);
    search.value = "yuan";
    search.dispatchEvent(new realm.Event("input", { bubbles: true }));
    key(search, "Tab");
    expect(realm.document.activeElement).toBe(option("CNY"));
    key(option("CNY"), "Home");
    expect(realm.document.activeElement).toBe(option("CNY"));
    key(option("CNY"), "End");
    expect(realm.document.activeElement).toBe(option("CNY"));
    expect(currency.value).toBe("USD");
    key(option("CNY"), " ");
    expect(currency.value).toBe("CNY");
    expect(realm.document.activeElement).toBe(currency);
    expect(realm.document.getElementById("monitor-select-picker")!.hidden).toBe(true);
  });

  it("keeps current-currency check separate from highlight and ignores a row scrolling under a resting pointer", () => {
    currency.dataset.searchable = "true";
    mouse(currency, "mousedown");
    const search = realm.document.getElementById("monitor-currency-search") as HTMLInputElement;
    const move = (row: HTMLElement, x: number) =>
      row.dispatchEvent(
        new realm.MouseEvent("pointermove", { clientX: x, clientY: 200, bubbles: true }),
      );
    move(option("CAD"), 50);
    key(search, "ArrowDown");
    expect(option("CNY").dataset.active).toBe("true");
    expect(option("CNY").getAttribute("aria-selected")).toBe("true");
    expect(option("USD").dataset.current).toBe("true");
    expect(option("USD").getAttribute("aria-current")).toBe("true");
    expect(option("USD").getAttribute("aria-selected")).toBe("false");
    move(option("USD"), 50);
    expect(option("CNY").dataset.active).toBe("true");
    move(option("USD"), 51);
    expect(option("USD").dataset.active).toBe("true");
    expect(currency.value).toBe("USD");
  });

  it("keeps an empty currency search open on Enter and Escape never changes the real selection", () => {
    currency.dataset.searchable = "true";
    currency.dataset.searchLabel = "Search currencies";
    currency.dataset.emptyLabel = "No matching currency";
    mouse(currency, "mousedown");
    const search = realm.document.getElementById("monitor-currency-search") as HTMLInputElement;
    search.value = "nothing-matches";
    search.dispatchEvent(new realm.Event("input", { bubbles: true }));
    expect(realm.document.querySelector(".monitor-currency-empty")!.textContent).toBe(
      "No matching currency",
    );
    key(search, "Enter");
    expect(realm.document.getElementById("monitor-select-picker")!.hidden).toBe(false);
    expect(currency.value).toBe("USD");
    key(search, "Escape");
    expect(realm.document.getElementById("monitor-select-picker")!.hidden).toBe(true);
    expect(currency.value).toBe("USD");
  });

  it.each([
    ["ＣＮ", { code: "CNY", name: "人民币", englishName: "Chinese Yuan", symbol: "¥" }, 0],
    ["民", { code: "CNY", name: "人民币", englishName: "Chinese Yuan", symbol: "¥" }, 1],
    ["yuan", { code: "CNY", name: "人民币", englishName: "Chinese Yuan", symbol: "¥" }, 1],
    ["zlo", { code: "PLN", name: "Polish Złoty", englishName: "Polish Złoty", symbol: "zł" }, -1],
    ["nt", { code: "TWD", name: "新台币", englishName: "New Taiwan Dollar", symbol: "NT$" }, 1],
    ["ollar", { code: "USD", name: "US Dollar", englishName: "US Dollar", symbol: "$" }, -1],
  ] as const)("matches native currency word boundaries for %s", (query, definition, rank) => {
    expect(currencySearchRank(query, definition)).toBe(rank);
  });
});
