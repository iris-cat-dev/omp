/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDateCalendarModel, MONITOR_DATE_RANGE_PICKER_SCRIPT } from "./date-range-picker";

const dates = createDateCalendarModel();

describe("original Gregorian date-only model", () => {
  it("rejects impossible dates, handles Gregorian centuries and retains years below 100 without Date.UTC's offset", () => {
    expect(dates.parts("2024-02-29")).toEqual({ year: 2024, month: 2, day: 29 });
    for (const value of [
      "2023-02-29",
      "1900-02-29",
      "2100-02-29",
      "2024-04-31",
      "0000-01-01",
      "10000-01-01",
      "2024-2-01",
    ])
      expect(dates.parts(value)).toBeNull();
    expect(dates.parts("2000-02-29")).not.toBeNull();
    expect(dates.utc("0001-01-01")!.getUTCFullYear()).toBe(1);
    expect(dates.addDays("0099-12-31", 1)).toBe("0100-01-01");
    expect(dates.addDays("0001-01-01", -1)).toBeNull();
    expect(dates.addDays("9999-12-31", 1)).toBeNull();
  });

  it("moves days independently of daylight saving and clips month/year navigation to real month lengths", () => {
    expect(dates.addDays("2024-03-10", 1)).toBe("2024-03-11");
    expect(dates.addDays("2024-11-03", -1)).toBe("2024-11-02");
    expect(dates.addMonths("2024-01-31", 1)).toBe("2024-02-29");
    expect(dates.addMonths("2024-02-29", 12)).toBe("2025-02-28");
    expect(dates.addMonths("2024-02-29", -12)).toBe("2023-02-28");
    expect(dates.addMonths("0001-01-01", -1)).toBeNull();
    expect(dates.addMonths("9999-12-31", 1)).toBeNull();
  });

  it.each([
    ["en", "2/29/2024", 0],
    ["zh-Hans", "2024/2/29", 1],
    ["zh-Hant", "2024/2/29", 0],
    ["ja", "2024/02/29", 0],
  ] as const)(
    "uses the original %s culture's short format and first weekday",
    (locale, formatted, firstDay) => {
      expect(dates.shortDate("2024-02-29", locale)).toBe(formatted);
      expect(dates.parseText(formatted, locale)).toBe("2024-02-29");
      expect(dates.parseText("2024-02-29", locale)).toBe("2024-02-29");
      expect(dates.culture(locale).firstDay).toBe(firstDay);
    },
  );

  it("parses localized numeric text without browser heuristics, rolls no impossible day, and normalizes fullwidth input", () => {
    expect(dates.parseText("２/２９/２０２４", "en")).toBe("2024-02-29");
    expect(dates.parseText("2024年2月29日", "zh-Hans")).toBe("2024-02-29");
    expect(dates.parseText("02/29/24", "en")).toBe("2024-02-29");
    expect(dates.parseText("1/1/49", "en")).toBe("2049-01-01");
    expect(dates.parseText("1/1/50", "en")).toBe("1950-01-01");
    expect(dates.parseText("2/29/2023", "en")).toBeNull();
    expect(dates.parseText("13/1/2024", "en")).toBeNull();
    expect(dates.parseText("29/2/2024", "en")).toBeNull();
    expect(dates.parseText("2024/2/29 extra", "zh-Hans")).toBeNull();
    expect(dates.shortDate("0001-01-01", "en")).toBe("1/1/0001");
  });

  it("builds six genuine calendar weeks, including WPF's preceding week on a first-weekday month boundary", () => {
    const sunday = dates.grid("2026-02-15", 0),
      monday = dates.grid("2026-02-15", 1);
    expect(sunday).toHaveLength(42);
    expect(sunday[0]).toBe("2026-01-25");
    expect(sunday[7]).toBe("2026-02-01");
    expect(sunday[41]).toBe("2026-03-07");
    expect(monday[0]).toBe("2026-01-26");
    expect(monday[6]).toBe("2026-02-01");
    expect(dates.grid("0001-01-01", 1).slice(0, 7)).toEqual(Array(7).fill(null));
    expect(dates.grid("9999-12-31", 0)).toContain(null);
  });

  it("treats both bounds as inclusive ISO dates", () => {
    expect(dates.inside("2024-02-29", "2024-02-29", "2024-02-29")).toBe(true);
    expect(dates.inside("2024-03-01", "2024-02-29", "2024-02-29")).toBe(false);
    expect(dates.inside("2024-02-30", "2024-01-01", "2024-12-31")).toBe(false);
  });
});

interface Picker {
  bind(root?: ParentNode, options?: { locale?: string }): void;
  render(options?: { locale?: string }): void;
  focus(id?: string): void;
  contains(target: EventTarget | null): boolean;
  close(restoreFocus?: boolean): boolean;
  destroy(): void;
}
let frame: HTMLIFrameElement;
let realm: Window & typeof globalThis;
let picker: Picker;
let from: HTMLInputElement;
let to: HTMLInputElement;

function mount(
  options: { from?: string; to?: string; min?: string; max?: string; locale?: string } = {},
) {
  picker?.destroy();
  realm.document.body.innerHTML = `<aside id="custom-range-popover"><label><span data-i18n="fromDate">From</span><input id="history-from" type="date" value="${options.from ?? "2024-02-27"}" min="${options.min ?? "2023-01-01"}" max="${options.max ?? "2026-10-31"}"></label><label><span data-i18n="toDate">To</span><input id="history-to" type="date" value="${options.to ?? "2024-03-05"}" min="${options.min ?? "2023-01-01"}" max="${options.max ?? "2026-10-31"}"></label><button id="history-apply">Apply</button></aside><button id="outside">Another control</button>`;
  picker = new Function(
    "document",
    "window",
    "Event",
    MONITOR_DATE_RANGE_PICKER_SCRIPT + "\nreturn monitorDateRangePicker;",
  )(realm.document, realm, realm.Event) as Picker;
  from = realm.document.getElementById("history-from") as HTMLInputElement;
  to = realm.document.getElementById("history-to") as HTMLInputElement;
  picker.bind(realm.document, { locale: options.locale ?? "en-US" });
}
function text(id = "history-from") {
  return realm.document.getElementById(id + "-text") as HTMLInputElement;
}
function popup() {
  return realm.document.getElementById("monitor-date-calendar") as HTMLDivElement;
}
function click(element: Element) {
  element.dispatchEvent(
    new realm.MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail: 1 }),
  );
}
function key(element: Element, value: string, options: KeyboardEventInit = {}) {
  const event = new realm.KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key: value,
    ...options,
  });
  element.dispatchEvent(event);
  return event;
}
function action(name: string) {
  return popup().querySelector<HTMLButtonElement>('[data-action="' + name + '"]')!;
}
function cell(value: string) {
  return popup().querySelector<HTMLButtonElement>('[data-date="' + value + '"]')!;
}
function open(id = "history-from") {
  const input = realm.document.getElementById(id)!;
  click(input.parentElement!.querySelector("button")!);
  expect(popup().hidden).toBe(false);
}
function focused() {
  return realm.document.activeElement!;
}
// Simulate a text edit at the editable textbox, never assign either authoritative ISO input's value.
function edit(value: string, id = "history-from") {
  const input = text(id);
  input.focus();
  input.select();
  input.setRangeText(value, 0, input.value.length, "end");
  input.dispatchEvent(
    new realm.InputEvent("input", { bubbles: true, inputType: "insertText", data: value }),
  );
}

beforeEach(() => {
  frame = document.createElement("iframe");
  document.body.append(frame);
  realm = frame.contentWindow as Window & typeof globalThis;
  mount();
});
afterEach(() => {
  picker.destroy();
  frame.remove();
});

describe("in-document original-style range DatePickers", () => {
  it("replaces only native popup appearance, keeping original inclusive ISO elements and localized real text controls", () => {
    expect(from.type).toBe("hidden");
    expect(to.type).toBe("hidden");
    expect(realm.document.querySelector('input[type="date"]')).toBeNull();
    expect(from.value).toBe("2024-02-27");
    expect(to.value).toBe("2024-03-05");
    expect(text().value).toBe("2/27/2024");
    expect(text().getAttribute("aria-label")).toBe("From");
    expect(picker.contains(null)).toBe(false);
    expect(picker.contains(text())).toBe(true);
    expect(picker.contains(realm.document.getElementById("outside"))).toBe(false);
    picker.focus();
    expect(focused()).toBe(text());
    open();
    expect(picker.contains(cell("2024-02-29"))).toBe(true);
    expect(focused()).toBe(cell("2024-02-27"));
  });

  it("selects a genuine leap day once through input/change and returns focus without applying the parent range", () => {
    const events: string[] = [];
    let applied = 0;
    from.addEventListener("input", () => events.push("input:" + from.value));
    from.addEventListener("change", () => events.push("change:" + from.value));
    realm.document.getElementById("history-apply")!.addEventListener("click", () => applied++);
    open();
    click(cell("2024-02-29"));
    expect(from.value).toBe("2024-02-29");
    expect(to.value).toBe("2024-03-05");
    expect(events).toEqual(["input:2024-02-29", "change:2024-02-29"]);
    expect(popup().hidden).toBe(true);
    expect(focused()).toBe(text());
    expect(applied).toBe(0);
    open();
    click(cell("2024-02-29"));
    expect(events).toHaveLength(2);
  });

  it("synchronizes crossed From/To dates in both directions like OnFromChanged/OnToChanged, including a one-day range", () => {
    open();
    click(cell("2024-03-05"));
    expect([from.value, to.value]).toEqual(["2024-03-05", "2024-03-05"]);
    open("history-to");
    click(cell("2024-02-29"));
    expect([from.value, to.value]).toEqual(["2024-02-29", "2024-02-29"]);
    expect(text().value).toBe("2/29/2024");
    expect(text("history-to").value).toBe("2/29/2024");
  });

  it("moves real selected days with arrows and Page keys, with Home/End selecting the month's first/last date", () => {
    open();
    key(focused(), "ArrowRight");
    expect(from.value).toBe("2024-02-28");
    key(focused(), "ArrowRight");
    expect(from.value).toBe("2024-02-29");
    key(focused(), "PageDown");
    expect(from.value).toBe("2024-03-29");
    key(focused(), "PageUp");
    expect(from.value).toBe("2024-02-29");
    key(focused(), "Home");
    expect(from.value).toBe("2024-02-01");
    key(focused(), "End");
    expect(from.value).toBe("2024-02-29");
    key(focused(), "ArrowUp");
    expect(from.value).toBe("2024-02-22");
    key(focused(), "ArrowDown");
    expect(from.value).toBe("2024-02-29");
    expect(key(focused(), "Enter").defaultPrevented).toBe(true);
    expect(popup().hidden).toBe(true);
    expect(focused()).toBe(text());
  });

  it("Escape restores only the opened picker's pre-open date and consumes Escape before the outer flyout", () => {
    mount({ to: "2024-02-28" });
    let outerEscapes = 0;
    realm.document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") outerEscapes++;
    });
    open();
    key(focused(), "ArrowDown");
    expect([from.value, to.value]).toEqual(["2024-03-05", "2024-03-05"]);
    expect(key(focused(), "Escape").defaultPrevented).toBe(true);
    expect(from.value).toBe("2024-02-27");
    // The original WPF Escape restores SelectedDate on this DatePicker, not the other DatePicker.
    expect(to.value).toBe("2024-03-05");
    expect(outerEscapes).toBe(0);
    expect(popup().hidden).toBe(true);
    expect(focused()).toBe(text());
  });

  it("outside dismissal, Tab and switching fields keep keyboard selection without a fake Apply", () => {
    open();
    key(focused(), "ArrowRight");
    realm.document
      .getElementById("outside")!
      .dispatchEvent(new realm.Event("pointerdown", { bubbles: true }));
    expect(popup().hidden).toBe(true);
    expect(from.value).toBe("2024-02-28");
    open();
    key(focused(), "ArrowRight");
    expect(key(focused(), "Tab").defaultPrevented).toBe(false);
    expect(popup().hidden).toBe(true);
    expect(from.value).toBe("2024-02-29");
    open();
    open("history-to");
    expect(text().getAttribute("aria-expanded")).toBe("false");
    expect(text("history-to").getAttribute("aria-expanded")).toBe("true");
    expect(focused()).toBe(cell("2024-03-05"));
  });

  it("navigates calendar headers and month/year grids without changing the range until a genuine day selection", () => {
    open();
    click(action("next"));
    expect(action("up").textContent).toBe("March 2024");
    expect([from.value, to.value]).toEqual(["2024-02-27", "2024-03-05"]);
    click(action("previous"));
    click(action("up"));
    expect(popup().dataset.mode).toBe("year");
    expect(popup().querySelectorAll('[role="gridcell"]')).toHaveLength(12);
    click(action("up"));
    expect(popup().dataset.mode).toBe("decade");
    expect(action("up").disabled).toBe(true);
    click(cell("2025-01-01"));
    expect(popup().dataset.mode).toBe("year");
    click(cell("2025-02-01"));
    expect(popup().dataset.mode).toBe("month");
    expect(action("up").textContent).toBe("February 2025");
    expect(from.value).toBe("2024-02-27");
    click(cell("2025-02-28"));
    expect([from.value, to.value]).toEqual(["2025-02-28", "2025-02-28"]);
  });

  it("supports Ctrl+Up/Down zoom, four-column month/year arrows and period paging without committing an intermediate period", () => {
    open();
    key(focused(), "ArrowUp", { ctrlKey: true });
    expect(popup().dataset.mode).toBe("year");
    key(focused(), "ArrowRight");
    expect(focused().getAttribute("data-date")).toBe("2024-03-01");
    key(focused(), "ArrowDown");
    expect(focused().getAttribute("data-date")).toBe("2024-07-01");
    key(focused(), "PageDown");
    expect(focused().getAttribute("data-date")).toBe("2025-07-01");
    key(focused(), "ArrowUp", { ctrlKey: true });
    expect(popup().dataset.mode).toBe("decade");
    key(focused(), "ArrowDown", { ctrlKey: true });
    expect(popup().dataset.mode).toBe("year");
    key(focused(), "ArrowDown", { ctrlKey: true });
    expect(popup().dataset.mode).toBe("month");
    expect(from.value).toBe("2024-02-27");
    key(focused(), " ");
    expect(from.value).toBe("2025-07-27");
    expect(popup().hidden).toBe(true);
  });

  it("keeps actual history bounds inclusive, hides unselectable days, and blocks keyboard or pointer escape past either bound", () => {
    mount({ from: "2024-02-28", to: "2024-03-02", min: "2024-02-27", max: "2024-03-02" });
    open();
    expect(action("previous").disabled).toBe(true);
    expect(cell("2024-02-26").disabled).toBe(true);
    expect(cell("2024-02-26").dataset.unavailable).toBe("true");
    click(cell("2024-02-26"));
    expect(from.value).toBe("2024-02-28");
    key(focused(), "Home");
    expect(from.value).toBe("2024-02-28");
    key(focused(), "ArrowLeft");
    expect(from.value).toBe("2024-02-27");
    key(focused(), "ArrowLeft");
    expect(from.value).toBe("2024-02-27");
    key(focused(), "Home");
    expect(from.value).toBe("2024-02-27");
    click(action("next"));
    expect(action("next").disabled).toBe(true);
    expect(cell("2024-03-03").disabled).toBe(true);
    click(cell("2024-03-02"));
    expect([from.value, to.value]).toEqual(["2024-03-02", "2024-03-02"]);
  });

  it("coerces month/year browsing to partial-period data bounds without changing the selected range", () => {
    mount({ from: "2024-02-28", to: "2024-03-02", min: "2023-10-20", max: "2024-03-02" });
    open();
    key(focused(), "ArrowUp", { ctrlKey: true });
    key(focused(), "ArrowRight");
    expect(focused().getAttribute("data-date")).toBe("2024-03-01");
    key(focused(), "ArrowDown", { ctrlKey: true });
    expect(focused().getAttribute("data-date")).toBe("2024-03-02");
    expect(from.value).toBe("2024-02-28");
    key(focused(), "End");
    expect(from.value).toBe("2024-02-28");
    key(focused(), "ArrowUp", { ctrlKey: true });
    key(focused(), "PageUp");
    expect(action("up").textContent).toBe("2023");
    expect(focused().getAttribute("data-date")).toBe("2023-10-01");
    expect(from.value).toBe("2024-02-28");
  });

  it("formats localized text and week headings on render without altering authoritative ISO dates", () => {
    picker.render({ locale: "zh-Hans" });
    expect(text().value).toBe("2024/2/27");
    open();
    expect(action("up").textContent).toBe("2024年2月");
    expect(popup().querySelector('[role="columnheader"]')!.textContent).toBe("一");
    picker.render({ locale: "zh-Hant" });
    expect(popup().lang).toBe("zh-TW");
    expect(popup().querySelector('[role="columnheader"]')!.textContent).toBe("日");
    picker.render({ locale: "ja" });
    expect(text().value).toBe("2024/02/27");
    expect([from.value, to.value]).toEqual(["2024-02-27", "2024-03-05"]);
  });

  it("commits genuine localized text edits on Enter/blur and restores the last valid date for invalid or out-of-bounds text", () => {
    edit("2/29/2024");
    key(text(), "Enter");
    expect(from.value).toBe("2024-02-29");
    edit("2/29/2023");
    key(text(), "Enter");
    expect(from.value).toBe("2024-02-29");
    expect(text().value).toBe("2/29/2024");
    edit("12/31/2022");
    key(text(), "Enter");
    expect(from.value).toBe("2024-02-29");
    edit("3/1/2024");
    text("history-to").focus();
    expect(from.value).toBe("2024-03-01");
    edit("");
    key(text(), "Enter");
    expect(from.value).toBe("");
    expect(text().value).toBe("");
  });

  it("opens the real calendar with the original Alt+Down gesture without asking the browser for a native popup", () => {
    const event = key(text(), "ArrowDown", { altKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(popup().hidden).toBe(false);
    expect(focused()).toBe(cell("2024-02-27"));
  });

  it("matches WPF's Ctrl-modified day movement, including Ctrl+Shift+Down without drilling up", () => {
    open();
    key(focused(), "ArrowRight", { ctrlKey: true });
    expect(from.value).toBe("2024-02-28");
    key(focused(), "ArrowDown", { ctrlKey: true });
    expect(from.value).toBe("2024-02-28");
    key(focused(), "ArrowDown", { ctrlKey: true, shiftKey: true });
    expect(from.value).toBe("2024-03-06");
    expect(popup().dataset.mode).toBe("month");
    key(focused(), "Home", { ctrlKey: true });
    expect(from.value).toBe("2024-03-01");
  });

  it("does not open disabled fields and disables both period directions for an actual one-day history bound", () => {
    from.disabled = true;
    picker.render();
    click(from.parentElement!.querySelector("button")!);
    expect(realm.document.getElementById("monitor-date-calendar")).toBeNull();
    mount({ from: "2024-02-29", to: "2024-02-29", min: "2024-02-29", max: "2024-02-29" });
    open();
    expect(action("previous").disabled).toBe(true);
    expect(action("next").disabled).toBe(true);
    expect(popup().querySelectorAll('[data-action="day"]:not(:disabled)')).toHaveLength(1);
    expect(
      Array.from(
        popup().querySelectorAll('[role="columnheader"]'),
        (element) => element.textContent,
      ),
    ).toEqual(["S", "M", "T", "W", "T", "F", "S"]);
    key(focused(), "ArrowLeft");
    expect(from.value).toBe("2024-02-29");
    click(cell("2024-02-29"));
    expect([from.value, to.value]).toEqual(["2024-02-29", "2024-02-29"]);
  });

  it("rebinds idempotently and destroys all popup/listener/wrapper state while preserving selected values and external listeners", () => {
    let changes = 0;
    from.addEventListener("change", () => changes++);
    picker.bind();
    picker.bind(realm.document.body);
    expect(realm.document.querySelectorAll(".monitor-date-field")).toHaveLength(2);
    open();
    picker.bind();
    expect(popup().hidden).toBe(false);
    click(cell("2024-02-29"));
    expect(changes).toBe(1);
    picker.destroy();
    expect(realm.document.querySelector(".monitor-date-field")).toBeNull();
    expect(realm.document.getElementById("monitor-date-calendar")).toBeNull();
    expect(from.type).toBe("date");
    expect(from.value).toBe("2024-02-29");
    picker.bind();
    open();
    click(cell("2024-03-01"));
    expect(from.value).toBe("2024-03-01");
    expect(changes).toBe(2);
  });

  it("keeps the browsed month, drill-up mode and focused native action stable across unchanged parent renders", () => {
    picker.destroy();
    picker.render({ locale: "en-US" });
    picker.bind();
    open();
    click(action("next"));
    const next = action("next");
    next.focus();
    picker.render({ locale: "en-US" });
    picker.render({ locale: "en-US" });
    expect(action("up").textContent).toBe("March 2024");
    expect(action("next")).toBe(next);
    expect(focused()).toBe(next);
    click(action("up"));
    click(action("up"));
    const year = focused();
    picker.render();
    expect(popup().dataset.mode).toBe("decade");
    expect(focused()).toBe(year);
    expect(from.value).toBe("2024-02-27");
  });

  it("preserves an uncommitted text edit and caret on unchanged renders, including before a calendar is ever opened", () => {
    edit("2/2");
    const caret = text().selectionStart;
    picker.render({ locale: "en-US" });
    expect(text().value).toBe("2/2");
    expect(text().selectionStart).toBe(caret);
    expect(from.value).toBe("2024-02-27");
    expect(picker.contains(realm)).toBe(false);
  });

  it("closes for parent teardown, window blur/resize and a disconnected owner without stealing outside focus", () => {
    open();
    realm.dispatchEvent(new realm.Event("resize"));
    expect(popup().hidden).toBe(true);
    open();
    realm.dispatchEvent(new realm.Event("blur"));
    expect(popup().hidden).toBe(true);
    open();
    realm.document.getElementById("outside")!.focus();
    expect(popup().hidden).toBe(true);
    expect(focused().id).toBe("outside");
    open();
    from.closest("label")!.remove();
    picker.render();
    expect(popup().hidden).toBe(true);
    expect(picker.close()).toBe(false);
  });
});
