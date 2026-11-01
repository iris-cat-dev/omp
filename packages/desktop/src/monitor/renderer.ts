import { MONITOR_UI_STRINGS } from "./ui-strings.js";
import { MONITOR_PERF_SCRIPT } from "./performance-ui.js";
import { MONITOR_BOARD_SCRIPT } from "./board-ui.js";
import { MONITOR_TITLE_THEMES_SCRIPT } from "./title-themes-ui.js";
import { MONITOR_DATE_RANGE_PICKER_SCRIPT } from "./date-range-picker.js";
import { MONITOR_HISTORY_MOTION_SCRIPT } from "./history-motion.js";
import { MONITOR_POPUP_MOTION_SCRIPT } from "./popup-motion.js";
import type { OmpMonitorModeBreakdown, OmpMonitorModelBreakdown } from "./types.js";
import { BUNDLED_CURRENCY_TABLE } from "./pricing-assets.js";

interface DisplayCurrency {
  code: string;
  digits: number;
  symbol: string;
  symbols?: Record<string, string>;
  common: number | null;
}
// The build-owned vendored asset is also validated by pricing; downloaded data never enters this script.
const CURRENCY_ASSET = BUNDLED_CURRENCY_TABLE as { currencies: DisplayCurrency[] };
const DISPLAY_CURRENCIES = CURRENCY_ASSET.currencies;

/** Native Layout spring (.45 s response, .82 damping), preserving velocity on retarget. */
export function dashboardSpringStep(
  value: number,
  velocity: number,
  target: number,
  seconds: number,
): { value: number; velocity: number } {
  const dt = Math.max(0, Math.min(1 / 30, seconds)),
    w = (2 * Math.PI) / 0.45,
    z = 0.82,
    wd = w * Math.sqrt(1 - z * z),
    x = value - target,
    e = Math.exp(-z * w * dt),
    cos = Math.cos(wd * dt),
    sin = Math.sin(wd * dt);
  const next = target + e * (x * cos + ((velocity + z * w * x) / wd) * sin),
    speed = e * (velocity * cos - ((z * w * velocity + w * w * x) / wd) * sin);
  return Math.abs(next - target) < 0.25 && Math.abs(speed) < 2.5
    ? { value: target, velocity: 0 }
    : { value: next, velocity: speed };
}

/** Core/SpeedFormat: invariant, three significant digits, including carry to the next unit. */
export function nativeSpeedText(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  if (value <= 0) return "0";
  const fixed = (amount: number, digits: number) =>
    (Math.round(amount * 10 ** digits) / 10 ** digits).toFixed(digits);
  if (value < 10) return Math.round(value * 10) / 10 >= 10 ? "10" : fixed(value, 1);
  if (value < 1000) return Math.round(value) >= 1000 ? "1.00k" : fixed(value, 0);
  const units: readonly [number, string][] = [
    [1000, "k"],
    [1000000, "M"],
    [1000000000, "B"],
  ];
  for (let index = 0; index < units.length; index++) {
    const [scale, unit] = units[index]!,
      scaled = value / scale;
    if (Math.round(scaled * 100) / 100 < 10) return fixed(scaled, 2) + unit;
    if (Math.round(scaled * 10) / 10 < 100) return fixed(scaled, 1) + unit;
    if (Math.round(scaled) < 1000 || index === units.length - 1) return fixed(scaled, 0) + unit;
  }
  return fixed(value, 0);
}

export interface HistoryModeBucket {
  value: string;
  requests: number;
  outputTokens: number;
  measuredOutputTokens: number;
  measuredDurationMs: number;
  share: number;
  topModels: { model: string; share: number }[];
}

/** Windows ModeHistory.Build: sum attribution dimensions, pool timing, keep unknown last. */
export function historyModeBuckets(
  rows: readonly OmpMonitorModeBreakdown[],
  kind: "effort" | "speed",
  start: string,
  end: string,
): HistoryModeBucket[] {
  const buckets = new Map<string, HistoryModeBucket & { models: Map<string, number> }>();
  let output = 0;
  for (const row of rows) {
    if (row.kind !== kind || row.date < start || row.date > end) continue;
    const value = row.value || "unknown";
    let bucket = buckets.get(value);
    if (!bucket) {
      bucket = {
        value,
        requests: 0,
        outputTokens: 0,
        measuredOutputTokens: 0,
        measuredDurationMs: 0,
        share: 0,
        topModels: [],
        models: new Map(),
      };
      buckets.set(value, bucket);
    }
    bucket.requests += row.requests;
    bucket.outputTokens += row.outputTokens;
    bucket.measuredOutputTokens += row.measuredOutputTokens;
    bucket.measuredDurationMs += row.measuredDurationMs;
    output += row.outputTokens;
    if (row.model && row.outputTokens > 0)
      bucket.models.set(row.model, (bucket.models.get(row.model) || 0) + row.outputTokens);
  }
  if (!buckets.size)
    return [
      {
        value: "unknown",
        requests: 0,
        outputTokens: 0,
        measuredOutputTokens: 0,
        measuredDurationMs: 0,
        share: 0,
        topModels: [],
      },
    ];
  const order =
    kind === "effort"
      ? ["ultracode", "ultra", "max", "xhigh", "high", "medium", "low", "minimal", "off"]
      : ["ultrafast", "fast", "highspeed", "standard"];
  const rank = (value: string) => {
    if (value === "unknown") return order.length + 1;
    const index = order.indexOf(value);
    return index < 0 ? order.length : index;
  };
  return Array.from(buckets.values())
    .sort((a, b) => {
      const difference = rank(a.value) - rank(b.value);
      if (difference || a.value === b.value) return difference;
      return a.value < b.value ? -1 : 1;
    })
    .map(({ models, ...bucket }) => {
      let named = 0;
      for (const value of models.values()) named += value;
      bucket.share = output > 0 ? bucket.outputTokens / output : 0;
      bucket.topModels = Array.from(models, ([model, value]) => ({
        model,
        share: value / Math.max(bucket.outputTokens, named),
      }))
        .sort((a, b) => {
          const difference = b.share - a.share;
          if (difference || a.model === b.model) return difference;
          return a.model < b.model ? -1 : 1;
        })
        .slice(0, 3);
      return bucket;
    });
}

/** One OMP source's real per-model day breakdown; missing model attribution stays a final row. */
export function historyModelBuckets(
  rows: readonly OmpMonitorModelBreakdown[],
  date: string,
  metric: "output" | "recorded" | "catalog",
): (OmpMonitorModelBreakdown & { share: number; fraction: number })[] {
  const buckets = new Map<
    string | null,
    OmpMonitorModelBreakdown & { share: number; fraction: number }
  >();
  for (const row of rows) {
    if (row.date !== date) continue;
    const existing = buckets.get(row.model);
    if (!existing) {
      buckets.set(row.model, { ...row, share: 0, fraction: 0 });
      continue;
    }
    existing.requests += row.requests;
    existing.outputTokens += row.outputTokens;
    existing.measuredOutputTokens += row.measuredOutputTokens;
    existing.measuredDurationMs += row.measuredDurationMs;
    existing.costUsd += row.costUsd;
    existing.unpricedRequests += row.unpricedRequests;
    existing.estimatedCostUsd += row.estimatedCostUsd;
    existing.unestimatedRequests += row.unestimatedRequests;
  }
  const value = (row: OmpMonitorModelBreakdown) => {
    if (metric === "recorded") return row.costUsd;
    if (metric === "catalog") return row.estimatedCostUsd;
    return row.outputTokens;
  };
  const sorted = Array.from(buckets.values()).sort((a, b) => {
    if (a.model === null) return b.model === null ? 0 : 1;
    if (b.model === null) return -1;
    const difference =
      (metric === "output" ? 0 : value(b) - value(a)) ||
      b.outputTokens - a.outputTokens ||
      b.requests - a.requests;
    if (difference) return difference;
    if (a.model === b.model) return 0;
    return a.model < b.model ? -1 : 1;
  });
  let total = 0,
    maximum = 0;
  for (const row of sorted) {
    const amount = value(row);
    total += amount;
    maximum = Math.max(maximum, amount);
  }
  for (const row of sorted) {
    const amount = value(row);
    row.share = total > 0 ? amount / total : 0;
    row.fraction = maximum > 0 ? amount / maximum : 0;
  }
  return sorted;
}

const EFFECTS_PREVIEW_KEYS = [
  [0, 0],
  [0.08, 0],
  [0.2, 0.12],
  [0.35, 0.3],
  [0.5, 0.6],
  [0.68, 1.3],
  [0.86, 1.05],
  [0.97, 0],
  [1, 0],
] as const;

/** Windows Core/DemoDriver.SpeedCurve, used only by the explicitly labelled visual preview. */
export function effectsPreviewValue(elapsedSeconds: number, redline: number): number {
  const seconds = Math.max(0, Math.min(20, elapsedSeconds)),
    progress = seconds / 20;
  let value = 0;
  for (let index = 1; index < EFFECTS_PREVIEW_KEYS.length; index++) {
    const [at, target] = EFFECTS_PREVIEW_KEYS[index]!;
    if (progress > at) continue;
    const [previousAt, previous] = EFFECTS_PREVIEW_KEYS[index - 1]!;
    const ratio = (progress - previousAt) / Math.max(at - previousAt, 0.0001);
    value = previous + (target - previous) * ratio * ratio * (3 - 2 * ratio);
    break;
  }
  return Math.max(
    0,
    value * redline * (1 + 0.05 * Math.sin(seconds * 7.3) + 0.03 * Math.sin(seconds * 17.1)),
  );
}

/** Native close locks input before flushing and holds that lock until close or explicit recovery. */
export function createTitleDraftCloseLock(
  surface: { inert: boolean },
  flushDrafts: () => Promise<void>,
): { flush: () => Promise<void>; release: () => void } {
  let previousInert: boolean | null = null;
  let request: Promise<void> | null = null;
  const release = () => {
    if (previousInert !== null) {
      surface.inert = previousInert;
      previousInert = null;
    }
    request = null;
  };
  const flush = () => {
    if (request) return request;
    previousInert = surface.inert;
    surface.inert = true;
    const current: Promise<void> = Promise.resolve()
      .then(flushDrafts)
      .catch((error) => {
        if (request === current) release();
        throw error;
      });
    request = current;
    return current;
  };
  return { flush, release };
}

// Executed only inside MONITOR_HTML's nonce-authorized static script.
// Agent Speed's original Windows surface geometry and interactions are adapted under MIT.
// Log-derived values are inserted only through textContent or numeric SVG attributes.
export const MONITOR_RENDERER_SCRIPT = String.raw`
const bridge = window.ompMonitor;
const monitorStrings = ${JSON.stringify(MONITOR_UI_STRINGS).replace(/</g, "\\u003c")};
const svgNamespace = 'http://www.w3.org/2000/svg';
const systemAppearance = window.matchMedia('(prefers-color-scheme: dark)');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const artInstances = new Map();
const orbRows = new Map();
const scopeOptions = new Map();
const titleThresholds = [0, .5, .02, .03, .04, .06, .08, .12, .17, .24, .34, .5, .7, 1];
let view = null, language = 'en', appearance = 'light', settingsPage = 'general';
let formatters = {}, timeFormatters = {};
let unsubscribe = null, unsubscribePointer = null, unsubscribeDrag = null, toastTimer = null, selectedDayTimer = null, peakBadgeTimer = null, titleDeadlineTimer = null;
let chartSeconds = 120, agentsExpanded = false, historyRange = '30', historyMetric = 'output', historyModeKind = 'effort';
let customStart = null, customEnd = null, historySort = 'date', historyDescending = true;
let selectedHistoryDate = null, chartPoints = [], historyChartDays = [], liveChartBounds = null, liveChartHover = null;
let popoverAnchor = null, dragging = null, dragEnding = false, orbHovered = false, lastPointer = null, interactive = null, orbIdleSince = null;
let titleTracker = { level: 0, candidate: 0, pending: null, pendingSince: 0, belowFirstSince: null }, orbRowSerial = 0;
let activityBaseline = null, pendingActivity = { responsePulse: false, newPeak: false };
let ladderOptions = null, currencyOptions = null, titleOptionsKey = null;
let previewInitialization = null, previewsReady = false, rendererDestroyed = false;
let settingsLayoutObserver = null, settingsMeasurement = null;
let effectsDemoTimer = null;
let historyModeTooltip = null;
let orbHoverScale = 1, orbLadderKey = '';
let dashboardObserver = null, dashboardResizeRaf = 0, dashboardResizePending = null, dashboardResizeBusy = false, dashboardHeightSent = null;
let dashboardDisclosure = {value:0,velocity:0,target:0,frame:0,time:0,fromOffset:0,fromHeight:0};
const dashboardSpringStep = ${dashboardSpringStep.toString()};
const nativeSpeedText = ${nativeSpeedText.toString()};
const displayCurrencies = ${JSON.stringify(DISPLAY_CURRENCIES).replace(/</g, "\\u003c")};
const EFFECTS_PREVIEW_KEYS = ${JSON.stringify(EFFECTS_PREVIEW_KEYS)};
const effectsPreviewValue = ${effectsPreviewValue.toString()};
const historyModeBuckets = ${historyModeBuckets.toString()};
const historyModelBuckets = ${historyModelBuckets.toString()};
const createTitleDraftCloseLock = ${createTitleDraftCloseLock.toString()};
${MONITOR_POPUP_MOTION_SCRIPT}
${MONITOR_DATE_RANGE_PICKER_SCRIPT}
${MONITOR_HISTORY_MOTION_SCRIPT}
${MONITOR_TITLE_THEMES_SCRIPT}
${MONITOR_PERF_SCRIPT}
${MONITOR_BOARD_SCRIPT}
function node(id) { return document.getElementById(id); }
function t(key) { return monitorStrings[language][key] || monitorStrings.en[key] || key; }
function text(id, value) { const element = node(id), next = String(value); if (element.textContent !== next) element.textContent = next; }
function finite(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null; }
function number(value, digits = 0) { const n = finite(value); return n === null ? '—' : formatters[digits].format(n); }
function compact(value) { const n = finite(value); return n === null ? '—' : n < 1000 ? String(Math.round(n)) : nativeSpeedText(n); }
function speedNumber(value) { return nativeSpeedText(finite(value)); }
function speed(value, unit = false) {
  const n = finite(value); if (n === null || n < .05) return '–';
  return speedNumber(n) + (unit ? ' tok/s' : '');
}
function percent(value) { const n = finite(value); return n === null ? '—' : number(Math.min(1, n) * 100, 1) + '%'; }
function timestamp(value, full = false) {
  const n = finite(value); if (n === null || !n) return '—';
  const parsed = new Date(n); return Number.isFinite(parsed.getTime()) ? (full ? timeFormatters.full : timeFormatters.time).format(parsed) : '—';
}
function localDate(date) { return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0'); }
function parseDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(value + 'T12:00:00'); return Number.isFinite(parsed.getTime()) && localDate(parsed) === value ? parsed : null;
}
function shiftDate(value, days) { const date = parseDate(value); date.setDate(date.getDate() + days); return localDate(date); }
function dateLabel(value) {
  if (!value) return t('unknown');
  const parsed = parseDate(value) || new Date(value); return Number.isFinite(parsed.getTime()) ? timeFormatters.date.format(parsed) : t('unknown');
}
function todayDate() { return localDate(new Date(view && view.snapshot ? view.snapshot.updatedAt : Date.now())); }
function average(usage) {
  return usage && finite(usage.measuredDurationMs) > 0 && finite(usage.measuredOutputTokens) !== null ? usage.measuredOutputTokens * 1000 / usage.measuredDurationMs : null;
}
function money(value, currency = 'USD') {
  const amount = finite(value),definition = displayCurrencies.find(item => item.code === currency); if (amount === null || !definition) return '—';
  const symbol = definition.symbols && definition.symbols[language === 'zh' ? 'zh-Hans' : 'en'] || definition.symbol,number = boardModel.amountNumber(amount,definition.digits),separator = /\p{L}$/u.test(symbol) ? '\u00a0' : '';
  return number.startsWith('<') ? '<'+symbol+separator+number.slice(1) : symbol+separator+number;
}
function costValue(usage, mode) {
  if (!usage) return null;
  const missing = mode === 'catalog' ? usage.unestimatedRequests : usage.unpricedRequests;
  return usage.requests > 0 && missing >= usage.requests ? null : finite(mode === 'catalog' ? usage.estimatedCostUsd : usage.costUsd);
}
function costText(usage, mode, converted = true) {
  const amount = costValue(usage, mode); if (amount === null) return '—';
  const missing = mode === 'catalog' ? usage.unestimatedRequests : usage.unpricedRequests;
  const pricing = view && view.snapshot ? view.snapshot.pricing : null;
  const currency = converted && pricing ? pricing.currency : 'USD';
  const rate = currency === 'USD' ? 1 : pricing ? finite(pricing.exchangeRate) : null;
  return rate === null ? '—' : (missing > 0 ? '≥' : '') + money(amount * rate, currency);
}
function snapshotFacts() {
  const snapshot = view && view.snapshot;
  return snapshot && !['unavailable', 'error'].includes(snapshot.status) && !(snapshot.status === 'scanning' && snapshot.coverage.readFiles === 0) ? snapshot : null;
}
function hasLiveSnapshot(snapshot) { return snapshot && (snapshot.status === 'ready' || snapshot.status === 'partial'); }
function liveFacts() { const snapshot = snapshotFacts(); return snapshot && !(view.ompSource && !view.ompSource.enabled) && !view.workerError && !view.refreshing && hasLiveSnapshot(snapshot) ? snapshot : null; }
function currentStatus() { return view && view.workerError ? 'error' : !view || view.refreshing ? 'scanning' : view.snapshot ? view.snapshot.status : 'scanning'; }
function measuredRate(sample) { return view.preferences.metric === 'total' ? sample.measuredTotalTps : sample.measuredTps; }
function estimatedRate(sample) { return view.preferences.metric === 'total' ? sample.estimatedTotalTps : sample.estimatedTps; }
function liveValue() { const snapshot = liveFacts(); return snapshot ? measuredRate(snapshot.rate)+estimatedRate(snapshot.rate) : null; }
function liveEstimated() { const snapshot = liveFacts(); return !!snapshot && estimatedRate(snapshot.rate) > 0; }
function liveReadout(value,unit = false) { return value === null ? '—' : speedNumber(value)+(unit ? ' tok/s' : ''); }
function orbName() { return !view ? 'OMP' : view.orbName; }
function artRedline() { return view.surface === 'orb' || view.surface === 'settings' && settingsPage === 'orb' ? view.effectiveRedline : view.preferences.redline; }
function artTitleTheme() { return view.surface === 'orb' || view.surface === 'settings' && settingsPage === 'orb' ? view.effectiveTitleTheme : view.preferences.titleTheme; }
function applyLanguage() {
  document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
  const locale = language === 'zh' ? 'zh-CN' : 'en-US';
  formatters = { 0: new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }), 1: new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }), 2: new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }) };
  timeFormatters = { time: new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' }), full: new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'medium' }), date: new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric' }), weekday: new Intl.DateTimeFormat(locale, { weekday: 'short' }), shortDate: new Intl.DateTimeFormat(locale, { month: 'numeric', day: 'numeric' }) };
  for (const element of document.querySelectorAll('[data-i18n]')) element.textContent = t(element.dataset.i18n);
  for (const element of document.querySelectorAll('[data-i18n-label]')) element.setAttribute('aria-label', t(element.dataset.i18nLabel));
  for (const element of document.querySelectorAll('[data-i18n-title]')) element.title = t(element.dataset.i18nTitle);
  const currency = node('currency'); currency.dataset.searchLabel = t('currencySearch'); currency.dataset.emptyLabel = t('noCurrencyMatch'); currency.dataset.clearLabel = t('dismiss');
  fillVisualChoices();
  monitorDateRangePicker.render({locale});
}
function toast(message) {
  clearTimeout(toastTimer); text('toast', message);
  toastTimer = setTimeout(() => { text('toast', ''); toastTimer = null; }, 4200);
}
async function action(work) { try { return await work(); } catch { renderView(); toast(t('actionFailed')); return undefined; } }
function fillVisualChoices() {
  const key = JSON.stringify([language,view && view.titleThemes ? view.titleThemes.custom.map(theme => [theme.id,theme.name]) : []]);
  if (titleOptionsKey === key) return;
  const titleSelect = node('title-theme'), titleOptions = document.createDocumentFragment();
  const follow = document.createElement('option'); follow.value = ''; follow.textContent = t('followGeneral'); titleOptions.append(follow);
  for (const [id, theme] of Object.entries(agentSpeedVisuals.themes)) {
    const option = document.createElement('option'); option.value = id; option.textContent = theme.name[language === 'zh' ? 0 : 1]; titleOptions.append(option);
  }
  for (const custom of view && view.titleThemes ? view.titleThemes.custom : []) {
    const option = document.createElement('option'); option.value = custom.id; option.textContent = custom.name; titleOptions.append(option);
  }
  titleSelect.replaceChildren(titleOptions);
  for (const [id, names] of Object.entries(agentSpeedVisuals.styles)) {
    let card = node('style-' + id);
    if (!card) {
      card = document.createElement('button'); card.id = 'style-' + id; card.type = 'button'; card.className = 'style-card'; card.dataset.style = id; card.setAttribute('role', 'radio');
      const previewWrap = document.createElement('div'); previewWrap.className = 'style-preview-wrap';
      const preview = document.createElement('div'); preview.id = 'preview-' + id; preview.className = 'style-preview'; preview.setAttribute('aria-hidden', 'true'); previewWrap.append(preview);
      const label = document.createElement('span'); label.className = 'style-card-label'; card.append(previewWrap, label); node('style-cards').append(card);
      card.addEventListener('click', () => action(() => bridge.configure({ style: id })));
    }
    card.lastChild.textContent = names[language === 'zh' ? 0 : 1]; card.title = t('style_' + id); card.setAttribute('aria-label', names[language === 'zh' ? 0 : 1] + '. ' + t('style_' + id));
  }
  titleOptionsKey = key;
}
function fitSettingsPresentation() {
  if (!view || view.surface !== 'settings' || document.hidden) return;
  if (!settingsMeasurement) settingsMeasurement = document.createElement('canvas').getContext('2d');
  if (!settingsMeasurement) return;
  for (const id of settingsPage === 'general' ? ['title-ladder'] : settingsPage === 'orb' && node('orb-advanced').open ? ['orb-title-ladder'] : []) {
    const ladder = node(id),rows = Array.from(ladder.children),available = ladder.parentElement.clientWidth;
    if (rows.length && available > 0) {
      const widths = rows.map(row => {
        const label = row.firstChild.textContent, style = getComputedStyle(row); settingsMeasurement.font = style.font || style.fontSize + ' ' + style.fontFamily;
        const labelWidth = settingsMeasurement.measureText(label).width;
        settingsMeasurement.font = '600 12px ' + style.fontFamily;
        return Math.ceil(labelWidth+Math.max(settingsMeasurement.measureText('2,000').width,row.lastElementChild.getBoundingClientRect().width)+16);
      });
      for (const columns of [4,3,2]) {
        const sizes = Array.from({length:columns},() => 0); widths.forEach((width,index) => { sizes[index%columns] = Math.max(sizes[index%columns],width); });
        if (sizes.reduce((total,width) => total+width,0)+12*(columns-1) <= available+.5 || columns === 2) { ladder.style.gridTemplateColumns = sizes.map(width => width + 'px').join(' '); break; }
      }
    }
  }
}
function sameOptionValues(previous, next) {
  if (previous === next) return true;
  if (!previous || previous.length !== next.length) return false;
  for (let index = 0; index < next.length; index++) if (previous[index] !== next[index]) return false;
  return true;
}
function fillScope(id, values, selected, allLabel) {
  const select = node(id); if (document.activeElement === select && select.options.length) return;
  const missing = selected !== null && !values.includes(selected) ? selected : null, previous = scopeOptions.get(id);
  if (!previous || previous.language !== language || previous.allLabel !== allLabel || previous.missing !== missing || !sameOptionValues(previous.values, values)) {
    const fragment = document.createDocumentFragment(), all = document.createElement('option'); all.value = ''; all.textContent = t(allLabel); fragment.append(all);
    for (const value of values) { const option = document.createElement('option'); option.value = value; option.textContent = value; fragment.append(option); }
    if (missing !== null) { const option = document.createElement('option'); option.value = missing; option.textContent = missing + ' ' + t('unavailableOption'); fragment.append(option); }
    select.replaceChildren(fragment);
    scopeOptions.set(id, { values, language, allLabel, missing });
  }
  const value = selected === null ? '' : selected; if (select.value !== value) select.value = value;
}
function syncPreferences() {
  if (!view) return;
  const preferences = view.preferences;
  const redlineSlider = node('redline'),totalMetric = preferences.metric === 'total';
  redlineSlider.min = totalMetric ? String(Math.log10(20000)) : '50'; redlineSlider.max = totalMetric ? String(Math.log10(2000000)) : '2000'; redlineSlider.step = totalMetric ? '.025' : '50';
  for (const input of document.querySelectorAll('[data-preference]')) {
    const key = input.dataset.preference;
    if (input.type === 'checkbox') input.checked = preferences[key];
    else if (document.activeElement !== input) input.value = String(key === 'opacity' ? Math.round(preferences.opacity*100) : key === 'redline' && totalMetric ? Math.log10(preferences.redline) : preferences[key] ?? '');
  }
  const displayCurrency = boardCurrency(view.snapshot);
  for (const group of document.querySelectorAll('[data-unit-preference]')) for (const button of group.children) { button.setAttribute('aria-pressed',String(button.dataset.unit === preferences[group.dataset.unitPreference])); if (button.dataset.unit === 'cost') button.textContent = (language === 'zh' ? '金额' : 'Money')+' ('+displayCurrency.symbol+'/s)'; }
  node('orb-size').min = preferences.style === 'minimal' ? '64' : '96';
  node('orb-visible').checked = view.orbVisible;
  node('preference-error').hidden = !view.preferenceError;
  text('redline-value',speedNumber(preferences.redline)+' tok/s'); text('orb-size-value',number(preferences.size)+' DIP'); text('opacity-value',number(preferences.opacity*100)+'%');
  for (const button of node('size-presets').querySelectorAll('button')) button.setAttribute('aria-pressed', String(Number(button.dataset.size) === preferences.size));
  for (const button of node('style-cards').children) { const selected = button.dataset.style === preferences.style; button.setAttribute('aria-checked', String(selected)); button.tabIndex = selected ? 0 : -1; }
  text('style-description', t('style_' + preferences.style));
  text('window-count', number(view.windowCount) + ' / ' + number(view.maxWindows));
  node('new-window').disabled = view.windowCount >= view.maxWindows;
  text('settings-orb-name', orbName()); text('settings-orb-detail', agentSpeedVisuals.styles[preferences.style][language === 'zh' ? 0 : 1] + ' · ' + number(preferences.size) + ' DIP');
  const startup = view.launchAtLogin,launch = node('launch-at-login');
  launch.disabled = !startup || !startup.supported; launch.checked = !!startup && startup.enabled;
  text('launch-at-login-note',t(!startup || !startup.supported ? 'launchAtLoginUnsupported' : startup.error ? 'launchAtLoginFailed' : 'launchAtLoginNote'));
  node('orb-duplicate').disabled = view.windowCount >= view.maxWindows; node('orb-remove').disabled = view.windowCount <= 1;
  node('orb-split').disabled = true; node('orb-split').title = t('splitSingleSource');
  node('orb-merge').disabled = !view.orbManagement || !view.orbManagement.canMerge; node('orb-merge').title = t('mergeAllScopes');
  node('orb-undo-banner').hidden = !view.orbUndo; text('orb-undo-text',t(view.orbUndo && view.orbUndo.kind === 'merge' ? 'orbsMerged' : 'orbRemoved'));
  const previewing = !!view.effectsPreview && view.effectsPreview.active;
  text('effects-preview',t(previewing ? 'effectsPreviewing' : 'effectsPreview')); node('effects-preview').disabled = previewing; node('effects-demo').hidden = !previewing;
  const automaticName = preferences.nameMode === 'always' || preferences.nameMode === 'auto' && (view.windowCount > 1 || view.scope.profile || view.scope.project);
  node('orb-show-name').options[0].textContent = t('automatic')+' ('+t(automaticName ? 'nameOn' : 'nameOff')+')';
  const nameInput = node('orb-custom-name'); if (document.activeElement !== nameInput) nameInput.value = preferences.orbName || ''; nameInput.placeholder = view.scope.project || (view.scope.profile ? 'OMP · '+view.scope.profile : 'OMP');
  const overrideKey = totalMetric ? 'orbRedlineTotal' : 'orbRedlineOutput',customRedline = preferences[overrideKey] !== null,orbRedline = view.effectiveRedline,slider = node('orb-redline');
  for (const button of node('orb-redline-mode').children) button.setAttribute('aria-pressed',String((button.dataset.redlineMode === 'custom') === customRedline));
  node('orb-redline-custom').hidden = !customRedline; slider.min = redlineSlider.min; slider.max = redlineSlider.max; slider.step = redlineSlider.step;
  if (document.activeElement !== slider) slider.value = String(totalMetric ? Math.log10(orbRedline) : orbRedline); text('orb-redline-value',speedNumber(orbRedline)+' tok/s');
  text('orb-advanced-summary',orbName()+' · '+speedNumber(orbRedline)+' tok/s');
  const ladderKey = JSON.stringify([view.effectiveTitleTheme,view.titleThemes && view.titleThemes.revision,orbRedline,language,appearance]);
  if (orbLadderKey !== ladderKey) { fillTitleLadder('orb-title-ladder','orb-title-heat-strip',monitorTitleThemes.resolve(view.titleThemes,view.effectiveTitleTheme,language),orbRedline); orbLadderKey = ladderKey; }
  renderOrbList();
  if (settingsPage === 'orb') for (const [id, kind] of [['profile', 'profile'], ['project', 'project']]) fillScope(id, view.scopes[kind === 'profile' ? 'profiles' : 'projects'], view.scope[kind], kind === 'profile' ? 'allProfiles' : 'allProjects');
  const resolvedTheme = monitorTitleThemes.resolve(view.titleThemes,preferences.titleTheme,language), titleRevision = view.titleThemes ? view.titleThemes.revision : 0;
  if (!ladderOptions || ladderOptions.theme !== preferences.titleTheme || ladderOptions.revision !== titleRevision || ladderOptions.redline !== preferences.redline || ladderOptions.language !== language || ladderOptions.appearance !== appearance) {
    fillTitleLadder('title-ladder','title-heat-strip',resolvedTheme,preferences.redline);
    ladderOptions = {theme:preferences.titleTheme,revision:titleRevision,redline:preferences.redline,language,appearance};
    fillVisualChoices(); node('title-theme').value = preferences.orbTitleTheme || '';
  }
  node('reduced-motion-note').hidden = !reducedMotion.matches;
  fitSettingsPresentation();
}
function fillTitleLadder(id,stripId,theme,redline) {
  const labels = theme.texts || theme.labels,strip = document.createDocumentFragment(),ladder = document.createDocumentFragment();
  for (let level = 2; level <= 13; level++) {
    const threshold = titleThresholds[level]*redline,tick = document.createElement('i'); tick.dataset.level = String(level); tick.style.left = Math.min(1,Math.pow(threshold/redline,.6))*100+'%'; strip.append(tick);
    const row = document.createElement('span'); row.dataset.level = String(level); row.tabIndex = 0; row.setAttribute('role','listitem'); row.append(document.createTextNode(labels[level]));
    const value = document.createElement('strong'); value.textContent = compact(threshold); value.style.color = agentSpeedVisuals.color(agentSpeedVisuals.heat(threshold,redline),appearance); row.append(value); row.setAttribute('aria-label',labels[level]+', '+value.textContent+' tok/s'); ladder.append(row);
  }
  node(id).replaceChildren(ladder); node(stripId).replaceChildren(strip);
}
function renderOrbList() {
  if (!view || view.surface !== 'settings') return;
  const list = node('orb-list'), present = new Set(view.orbs.map(summary => summary.instanceId));
  for (const [id, entry] of orbRows) {
    if (present.has(id)) continue;
    const art = artInstances.get(entry.preview.id); if (art) { art.instance.destroy(); artInstances.delete(entry.preview.id); }
    entry.row.remove(); orbRows.delete(id);
  }
  for (let index = 0; index < view.orbs.length; index++) {
    const summary = view.orbs[index], selected = summary.instanceId === view.instanceId;
    let entry = orbRows.get(summary.instanceId);
    if (!entry) {
      const row = document.createElement('div'); row.className = 'orb-choice orb-identity'; row.id = 'orb-choice-' + (++orbRowSerial); row.setAttribute('role','option'); row.dataset.instanceId = summary.instanceId; row.draggable = true;
      const holder = document.createElement('span'); holder.className = 'orb-preview-small';
      const preview = document.createElement('span'); preview.id = row.id + '-preview'; preview.className = 'orb-list-art'; preview.setAttribute('aria-hidden', 'true'); holder.append(preview);
      const copy = document.createElement('span'); copy.className = 'identity-text'; const name = document.createElement('strong'), detail = document.createElement('small'); copy.append(name, detail);
      const rate = document.createElement('span'); rate.className = 'orb-count';
      const indicators = document.createElement('span'); indicators.className = 'symbol orb-choice-indicators'; indicators.setAttribute('aria-hidden', 'true');
      const eye = document.createElement('button'); eye.type = 'button'; eye.className = 'subtle symbol orb-eye'; eye.tabIndex = -1;
      eye.addEventListener('click',event => { event.stopPropagation(); const current = view && view.orbs.find(orb => orb.instanceId === summary.instanceId); if (current) action(() => bridge.commandOrb({type:'visible',instanceId:current.instanceId,visible:!current.visible})); });
      row.append(holder,copy,rate,indicators,eye);
      row.addEventListener('click',() => { if (view && view.surface === 'settings') action(() => bridge.selectOrb(summary.instanceId)); });
      row.addEventListener('dragstart',event => { event.dataTransfer.setData('application/x-omp-orb',summary.instanceId); event.dataTransfer.effectAllowed = 'move'; });
      row.addEventListener('dragover',event => { if (event.dataTransfer.types.includes('application/x-omp-orb')) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; } });
      row.addEventListener('drop',event => { const id = event.dataTransfer.getData('application/x-omp-orb'),target = view.orbs.findIndex(orb => orb.instanceId === summary.instanceId); if (id && target >= 0) { event.preventDefault(); action(() => bridge.commandOrb({type:'move',instanceId:id,index:target})); } });
      entry = {row,preview,name,detail,rate,indicators,eye}; orbRows.set(summary.instanceId,entry);
    }
    const name = summary.name;
    const status = [t(summary.visible ? 'visibleOrb' : 'hiddenOrb')]; if (summary.clickThrough) status.push(t('clickThrough')); if (summary.pinned) status.push(t('pin'));
    entry.name.textContent = name; entry.detail.textContent = agentSpeedVisuals.styles[summary.style][language === 'zh' ? 0 : 1] + ' · ' + number(summary.size) + ' DIP';
    if (selected && view.preferences.orbUnit === 'cost') { const facts = liveFacts(),cost = boardCost(facts ? boardModel.aggregate(facts.agents,facts.performance.current,view.preferences.metric) : {cost:null,costPartial:false},boardCurrency(view.snapshot)); entry.rate.textContent = (cost.partial ? '≥' : '')+cost.text+' '+cost.unit; }
    else entry.rate.textContent = selected ? liveReadout(liveValue(),true) : '—';
    entry.indicators.textContent = (summary.pinned ? '\uE718 ' : '')+(summary.clickThrough ? '\uE7C9' : '');
    entry.eye.textContent = summary.visible ? '\uE890' : '\uED1A'; entry.eye.setAttribute('aria-pressed',String(summary.visible)); entry.eye.setAttribute('aria-label',t(summary.visible ? 'hiddenOrb' : 'visibleOrb')+' · '+name); entry.eye.title = entry.eye.getAttribute('aria-label');
    entry.row.dataset.shown = String(summary.visible); entry.row.setAttribute('aria-selected', String(selected)); entry.row.tabIndex = selected ? 0 : -1;
    entry.row.title = t('orb') + ' ' + number(index + 1) + ' · ' + name + '\n' + t('profile') + ': ' + (summary.scope.profile || t('allProfiles')) + '\n' + t('project') + ': ' + (summary.scope.project || t('allProjects')) + '\n' + status.join(' · ');
    entry.row.setAttribute('aria-label', t('orb') + ' ' + number(index + 1) + ': ' + name + ', ' + entry.detail.textContent + ', ' + status.join(', '));
    if (selected) list.setAttribute('aria-activedescendant', entry.row.id);
    if (list.children[index] !== entry.row) list.insertBefore(entry.row, list.children[index] || null);
  }
}
function resetTitleTracker() {
  clearTimeout(titleDeadlineTimer); titleDeadlineTimer = null;
  titleTracker = { level: 0, candidate: 0, pending: null, pendingSince: 0, belowFirstSince: null };
}
function trackedTitle(value) {
  if (!view || value === null) { resetTitleTracker(); return { label: t('unknown'), level: 0 }; }
  // Frozen Windows LadderTracker: hysteresis follows Candidate, including intermediate exit levels.
  const resolved = monitorTitleThemes.resolve(view.titleThemes,artTitleTheme(),language),now = performance.now(),redline = artRedline(),raw = agentSpeedVisuals.title(value,resolved.base,language,redline).level;
  if (value < .5) { if (titleTracker.belowFirstSince === null) titleTracker.belowFirstSince = now; }
  else titleTracker.belowFirstSince = null;
  let candidate;
  if (value < .5) candidate = now - titleTracker.belowFirstSince + 1e-6 >= 3000 || titleTracker.candidate === 0 ? 0 : 1;
  else if (raw >= titleTracker.candidate) candidate = raw;
  else {
    candidate = 1;
    for (let level = titleTracker.candidate; level > 1; level--) {
      if (value >= titleThresholds[level]*redline*.9) { candidate = level; break; }
    }
  }
  titleTracker.candidate = candidate;
  if (candidate === titleTracker.level) titleTracker.pending = null;
  else {
    if (titleTracker.pending !== candidate) { titleTracker.pending = candidate; titleTracker.pendingSince = now; }
    if (now - titleTracker.pendingSince + 1e-6 >= (candidate === 0 ? 0 : 800)) { titleTracker.level = candidate; titleTracker.pending = null; }
  }
  let deadline = titleTracker.pending === null ? null : titleTracker.pendingSince + (titleTracker.pending === 0 ? 0 : 800);
  if (titleTracker.belowFirstSince !== null && candidate !== 0) deadline = deadline === null ? titleTracker.belowFirstSince + 3000 : Math.min(deadline, titleTracker.belowFirstSince + 3000);
  clearTimeout(titleDeadlineTimer); titleDeadlineTimer = null;
  if (deadline !== null && !document.hidden) titleDeadlineTimer = setTimeout(() => { titleDeadlineTimer = null; if (view && !document.hidden) renderArt(); }, Math.max(1, deadline - performance.now()));
  return {label:resolved.labels[titleTracker.level],level:titleTracker.level};
}
function cancelPreviewInitialization() {
  const pending = previewInitialization; if (!pending) return;
  previewInitialization = null;
  if (pending.raf) cancelAnimationFrame(pending.raf);
  clearTimeout(pending.timer);
}
function initializePreviewsAfterPaint() {
  if (previewsReady || previewInitialization || rendererDestroyed) return;
  const pending = { raf: 0, timer: 0 }; previewInitialization = pending;
  // Let the tab's controls and labels paint before the first shader/preview initialization.
  pending.raf = requestAnimationFrame(() => {
    pending.raf = 0; if (previewInitialization !== pending) return;
    pending.timer = setTimeout(() => {
      pending.timer = 0; if (previewInitialization !== pending) return;
      previewInitialization = null;
      if (rendererDestroyed || document.hidden || !view || view.surface !== 'settings' || settingsPage !== 'orb') return;
      previewsReady = true; renderArt();
    }, 0);
  });
}
function ensureArt(id, embedded, thumbnail, sharedGpu) {
  let entry = artInstances.get(id);
  if (!entry) { entry = { instance: agentSpeedVisuals.create(node(id), { embedded, thumbnail, sharedGpu }), visible: false }; artInstances.set(id, entry); }
  return entry;
}
function updateArt(id, embedded, frame, visible, thumbnail = false, sharedGpu = false) {
  if (!visible && !artInstances.has(id)) return;
  frame.perfReadout = perfOrbReadoutFrame(id);
  const entry = ensureArt(id, embedded, thumbnail, sharedGpu); entry.instance.setVisible(visible); entry.visible = visible; if (visible) entry.instance.update(frame);
}
function renderHeroTitle(title) {
  const host = node('speed-title'),previous = host.dataset.label,previousLevel = Number(host.dataset.level),renamed = previousLevel === title.level;
  if (previous === title.label) return;
  host.dataset.label = title.label; host.dataset.level = String(title.level); host.setAttribute('aria-label',title.label);
  const incoming = document.createElement('span'); incoming.className = 'speed-title-incoming'; incoming.textContent = title.label;
  if (previous === undefined || document.hidden || view.surface !== 'dashboard') { host.replaceChildren(incoming); return; }
  const outgoing = document.createElement('span'); outgoing.className = 'speed-title-outgoing'; outgoing.textContent = previous; outgoing.setAttribute('aria-hidden','true'); host.replaceChildren(outgoing,incoming);
  const travel = reducedMotion.matches || renamed ? 0 : Math.max(18,host.clientHeight);
  perfAnimate(outgoing,renamed ? [{opacity:1},{opacity:0}] : [{opacity:1,transform:'translateY(0)'},{opacity:0,transform:'translateY(-'+travel+'px)',offset:.4},{opacity:0,transform:'translateY(-'+travel+'px)'}],{duration:renamed ? 250 : 350,easing:'ease-out'});
  perfAnimate(incoming,renamed ? [{opacity:0},{opacity:1}] : [{opacity:0,transform:'translateY('+travel+'px)'},{opacity:0,transform:'translateY('+travel+'px)',offset:.35},{opacity:1,transform:'translateY(0)'}],{duration:renamed ? 250 : 350,easing:'ease-out'});
}
function renderArt() {
  if (!view || rendererDestroyed) return;
  const preferences = view.preferences,facts = liveFacts(),value = liveValue(),title = trackedTitle(value),resolvedTheme = monitorTitleThemes.resolve(view.titleThemes,artTitleTheme(),language),redline = artRedline();
  const agents = facts ? facts.agents : [], active = agents.filter(agent => agent.phase === 'generating').length, tools = agents.filter(agent => agent.phase === 'tools').length;
  const currency = boardCurrency(view.snapshot),totals = facts ? boardModel.aggregate(agents,facts.performance.current,preferences.metric) : null;
  const moneyValue = boardCost(totals || {cost:null,costPartial:false},currency),orbMoney = preferences.orbUnit === 'cost',heroMoney = preferences.liveUnit === 'cost';
  if (value === null || value >= .05) orbIdleSince = null;
  else if (orbIdleSince === null) orbIdleSince = performance.now();
  const faded = preferences.fadeWhenIdle && orbIdleSince !== null && performance.now() - orbIdleSince >= 60000 && !orbHovered;
  const dimmed = (value === null ? .55 : 1) * (faded ? .45 : 1);
  const base = {value,formattedValue:liveReadout(value),unit:'tok/s',title:title.label,titleLevel:title.level,titleBase:resolvedTheme.base,titleLabels:resolvedTheme.labels,showsVehicleArt:resolvedTheme.showsVehicleArt,style:preferences.style,titleTheme:preferences.titleTheme,language,redline:preferences.redline,appearance,effects:preferences.effects,reduceMotion:reducedMotion.matches,maxFps:view.maxFps,size:preferences.size,opacity:preferences.opacity*dimmed,hovered:view.surface === 'orb' && orbHovered,activeAgents:active,toolsAgents:tools,responsePulse:pendingActivity.responsePulse && preferences.responsePulses,newPeak:pendingActivity.newPeak && preferences.celebratePeaks,hoverLabel:orbName() + ' · ' + (value === null ? t('unknown') : liveReadout(value,true) + (liveEstimated() ? ' (' + t('estimated') + ')' : ''))};
  const visible = !document.hidden;
  base.redline = redline; base.titleTheme = artTitleTheme();
  const orbReadout = {formattedValue:orbMoney ? moneyValue.text : base.formattedValue,unit:orbMoney ? moneyValue.unit : base.unit,atLeast:orbMoney && moneyValue.partial,valueMuted:orbMoney && (totals === null || totals.cost === null || currency.rate === null),readoutValue:orbMoney ? totals && totals.cost !== null && currency.rate !== null ? totals.cost*currency.rate : null : value};
  updateArt('orb-art',false,{...base,...orbReadout},visible && view.surface === 'orb' && view.orbVisible);
  updateArt('hero-art',true,{...base,size:112,opacity:1,hovered:false,readoutValue:heroMoney ? totals && totals.cost !== null && currency.rate !== null ? totals.cost*currency.rate : null : value},visible && view.surface === 'dashboard');
  const previewPageVisible = visible && view.surface === 'settings' && settingsPage === 'orb';
  if (previewPageVisible) initializePreviewsAfterPaint(); else cancelPreviewInitialization();
  const previewsVisible = previewPageVisible && previewsReady;
  for (const summary of view.orbs) {
    const row = orbRows.get(summary.instanceId); if (!row) continue;
    const selected = summary.instanceId === view.instanceId,theme = monitorTitleThemes.resolve(view.titleThemes,summary.titleTheme,language);
    updateArt(row.preview.id,false,{...base,...orbReadout,value:selected ? value : null,readoutValue:selected ? orbReadout.readoutValue : null,formattedValue:selected ? orbReadout.formattedValue : '—',unit:selected ? orbReadout.unit : '',valueMuted:!selected || orbReadout.valueMuted,atLeast:selected && orbReadout.atLeast,title:selected ? title.label : t('unknown'),titleLevel:selected ? title.level : 0,titleTheme:summary.titleTheme,titleBase:theme.base,titleLabels:theme.labels,showsVehicleArt:theme.showsVehicleArt,redline:summary.effectiveRedline,style:summary.style,size:38,opacity:1,effects:'off',reduceMotion:true,hovered:false,activeAgents:selected ? active : 0,toolsAgents:selected ? tools : 0,responsePulse:false,newPeak:false},previewsVisible && previewOnScreen(row.preview.id),true);
  }
  for (const style of Object.keys(agentSpeedVisuals.styles)) updateArt('preview-'+style,false,{...base,...orbReadout,style,size:64,opacity:1,effects:'off',reduceMotion:true,hovered:false,responsePulse:false,newPeak:false},previewsVisible && previewOnScreen('preview-'+style),false,true);
  clearTimeout(effectsDemoTimer); effectsDemoTimer = null;
  const demo = view.effectsPreview,demoVisible = visible && view.surface === 'settings' && settingsPage === 'effects' && demo && demo.active && demo.startedAt !== null;
  if (demoVisible) {
    const demonstration = effectsPreviewValue((Date.now()-demo.startedAt)/1000,preferences.redline),level = agentSpeedVisuals.title(demonstration,resolvedTheme.base,language,preferences.redline).level;
    updateArt('effects-preview-art',false,{...base,value:demonstration,formattedValue:speedNumber(demonstration),unit:'tok/s',atLeast:false,title:resolvedTheme.labels[level],titleLevel:level,size:148,opacity:1,hovered:false,activeAgents:0,toolsAgents:0,responsePulse:false,newPeak:false},true,false,true);
    effectsDemoTimer = setTimeout(() => { effectsDemoTimer = null; if (!rendererDestroyed) renderArt(); },50);
  } else updateArt('effects-preview-art',false,base,false,false,true);
  if (pendingActivity.newPeak && preferences.celebratePeaks && preferences.effects !== 'off' && view.surface === 'dashboard') { node('peak-badge').hidden = false; clearTimeout(peakBadgeTimer); peakBadgeTimer = setTimeout(() => { node('peak-badge').hidden = true; },1800); }
  pendingActivity = { responsePulse: false, newPeak: false };
  text('speed-value',heroMoney ? moneyValue.text : liveReadout(value)); text('speed-unit',heroMoney ? moneyValue.unit : 'tok/s'); node('hero-at-least').hidden = !heroMoney || !moneyValue.partial; renderHeroTitle(title);
  node('hero').style.setProperty('--heat', agentSpeedVisuals.color(value === null ? 0 : agentSpeedVisuals.heat(value, preferences.redline), appearance));
  text('hero-context', facts ? t('generating') + ' ' + number(active) + ' · ' + t('tools') + ' ' + number(tools) : view.workerError ? t('stale') : t('status_' + currentStatus()));
  const heroPerfDescription = perfOrbReadoutFrame('hero-art').description || '', orbPerfDescription = perfOrbReadoutFrame('orb-art').description || '';
  const tokensDescription = value === null ? t('unknown') : liveReadout(value,true)+(liveEstimated() ? ', '+t('estimated') : ''),moneyDescription = (moneyValue.partial ? '≥ ' : '')+moneyValue.text+' '+moneyValue.unit;
  node('hero').setAttribute('aria-label',t('liveChart')+': '+(heroMoney ? moneyDescription : tokensDescription)+', '+title.label+(heroPerfDescription ? ', '+heroPerfDescription : ''));
  const orb = node('orb-surface'); orb.dataset.clickThrough = String(preferences.clickThrough); orb.dataset.hovered = String(base.hovered); orb.setAttribute('aria-label',orbName()+': '+(orbMoney ? moneyDescription : tokensDescription)+', '+title.label+(orbPerfDescription ? ', '+orbPerfDescription : '')); orb.title = orbName()+' · '+(orbMoney ? moneyDescription : tokensDescription);
  text('orb-name',orbName()); const plate = node('orb-nameplate'),showName = preferences.showName === 'on' || preferences.showName !== 'off' && (preferences.nameMode === 'always' || preferences.nameMode === 'auto' && (view.windowCount > 1 || view.scope.profile || view.scope.project)); plate.hidden = preferences.size < 80 || !showName;
  const font = Math.max(9, Math.min(12, Math.round(preferences.size * .066 * 2) / 2)), height = Math.round(1.78 * font), gap = Math.max(4, Math.min(7, Math.round(.034 * preferences.size))), dot = Math.max(5, .6 * font);
  if (view.nameplateMaxWidth < height + dot + .42 * font) plate.hidden = true;
  plate.dataset.unavailable = String(value === null); plate.dataset.cjk = String(/[\u3400-\u9fff]/.test(orbName())); plate.style.fontSize = font + 'px'; plate.style.height = height + 'px'; plate.style.borderRadius = height / 2 + 'px'; plate.style.gap = .42 * font + 'px';
  plate.style.paddingLeft = height / 2 - dot / 2 + 'px'; plate.style.paddingRight = .52 * height + 'px'; plate.style.maxWidth = Math.max(0, Math.min(1.5 * preferences.size - 6, view.nameplateMaxWidth)) + 'px';
  const hoverGrowth = .5*preferences.size*(orbHoverScale-1); node('orb-hit').style.transform = 'scale('+orbHoverScale+')';
  plate.style.top = (view.nameplatePlacement === 'above' ? .25*preferences.size-hoverGrowth-gap-height : 1.25*preferences.size+hoverGrowth+gap)+'px'; plate.style.opacity = String(preferences.opacity*dimmed);
  plate.firstElementChild.style.width = dot + 'px'; plate.firstElementChild.style.height = dot + 'px';
  syncInteraction();
}
function previewOnScreen(id) {
  const bounds = node(id).getBoundingClientRect(), scrollBounds = node('settings-scroller').getBoundingClientRect();
  return bounds.bottom > scrollBounds.top && bounds.top < scrollBounds.bottom;
}
function renderStatus() {
  const status = currentStatus(), banner = node('banner');
  for (const id of ['coverage-status', 'history-status']) { const element = node(id); element.dataset.status = status; element.textContent = t('status_' + status); element.title = view.workerError ? t('workerError') : t('status_' + status); }
  banner.hidden = status === 'ready' && !view.preferenceError; banner.dataset.error = String(status === 'error');
  banner.textContent = view.preferenceError ? t('preferenceError') : view.workerError ? t('workerError') : t(status === 'error' ? 'snapshotError' : status);
  node('orb-visible').checked = view.orbVisible; node('settings-orb-visible').checked = view.preferences.showOrbs;
  for (const element of document.querySelectorAll('#refresh,[data-refresh]')) { element.setAttribute('aria-busy', String(view.refreshing)); element.disabled = view.refreshing; }
  node('export').disabled = !snapshotFacts();
  document.title = 'OMP · ' + t(view.surface === 'orb' ? 'orb' : view.surface);
}
function renderToday(snapshot) {
  const usage = snapshot ? snapshot.today : null, live = liveFacts(), value = liveValue();
  text('today-input',compact(inputWithCache(usage))); text('today-output',compact(usage ? usage.outputTokens : null)); text('today-requests',compact(usage ? usage.requests : null)); text('today-average',speedNumber(average(usage)));
  for (const [id,key] of [['today-output','outputTokens'],['today-requests','requests']]) node(id).title = number(usage ? usage[key] : null); node('today-input').title = number(inputWithCache(usage));
  const totalMetric = view.preferences.metric === 'total',peak = usage ? totalMetric ? usage.peakTotalTps : usage.peakOutputTps : null;
  const peakAt = snapshot && peak > 0 ? finite(totalMetric ? snapshot.activity.totalPeakAt : snapshot.activity.peakAt) : null;
  const provenance = peakAt !== null ? t('peakMeasurement')+' '+timestamp(peakAt,true) : t('peakTimeUnknown');
  text('session-peak',speed(peak,true)); text('peak-time',peakAt !== null ? timestamp(peakAt) : '—'); node('session-peak').title = provenance; node('peak-time').title = provenance; text('peak-provenance',provenance);
  text('today-cost', costText(usage, 'recorded')); node('today-cost').title = t('recordedCost') + ' · ' + costText(usage, 'recorded', false);
  text('recorded-usd', costText(usage, 'recorded', false)); text('catalog-cost', costText(usage, 'catalog', false));
  text('today-unpriced', usage ? number(usage.unpricedRequests) + ' ' + t('unpriced') : t('unknown'));
  text('catalog-note', (usage ? number(usage.unestimatedRequests) + ' ' + t('unestimated') + ' · ' : '') + t('catalogNote'));
  text('measured-speed',number(live ? measuredRate(live.rate) : null,1)); text('estimated-speed',number(live ? estimatedRate(live.rate) : null,1)); text('estimated-fraction',percent(live && value > 0 ? estimatedRate(live.rate)/value : live ? 0 : null));
  node('estimate-legend').hidden = !live || estimatedRate(live.rate) <= 0;
  const listed = !!usage && (usage.outputTokens > 0 || value > 0); node('source-omp').hidden = !listed; node('sources-empty').hidden = listed;
  text('source-today', usage ? compact(usage.outputTokens) + ' · ' + costText(usage, 'recorded') : '—'); text('source-live', value !== null && value >= .05 ? liveReadout(value) : '–');
  const scoped = !!view.scope.profile || !!view.scope.project; node('selected-scope').hidden = !scoped;
  text('selected-scope', (view.scope.profile || t('allProfiles')) + ' · ' + (view.scope.project || t('allProjects'))); node('selected-scope').title = node('selected-scope').textContent;
  const pricing = view.snapshot ? view.snapshot.pricing : null;
  for (const [id, mode] of [['recorded-converted', 'recorded'], ['catalog-converted', 'catalog']]) {
    if (!pricing) text(id, t('unknown'));
    else if (pricing.currency === 'USD') text(id, t('noConversion'));
    else text(id, pricing.currency + ': ' + (finite(pricing.exchangeRate) === null ? t('rateUnavailable') : costText(usage, mode) + ' · ' + t('conversionAsOf') + ' ' + dateLabel(pricing.rates.updatedAt)));
  }
}
function svgElement(tag, attributes = {}, value = null) {
  const element = document.createElementNS(svgNamespace, tag);
  for (const [key, attribute] of Object.entries(attributes)) element.setAttribute(key, String(attribute));
  if (value !== null) element.textContent = String(value); return element;
}
function smoothPath(points) {
  let path = '', segment = [];
  function flush() {
    if (!segment.length) return;
    path += ' M ' + segment[0][0].toFixed(2) + ' ' + segment[0][1].toFixed(2);
    for (let i = 0; i < segment.length - 1; i++) {
      const p0 = segment[Math.max(0, i - 1)], p1 = segment[i], p2 = segment[i + 1], p3 = segment[Math.min(segment.length - 1, i + 2)];
      const lo = Math.min(p1[1], p2[1]), hi = Math.max(p1[1], p2[1]);
      const c1y = Math.max(lo, Math.min(hi, p1[1] + (p2[1] - p0[1]) / 6)), c2y = Math.max(lo, Math.min(hi, p2[1] - (p3[1] - p1[1]) / 6));
      path += ' C ' + (p1[0] + (p2[0] - p0[0]) / 6).toFixed(2) + ' ' + c1y.toFixed(2) + ' ' + (p2[0] - (p3[0] - p1[0]) / 6).toFixed(2) + ' ' + c2y.toFixed(2) + ' ' + p2[0].toFixed(2) + ' ' + p2[1].toFixed(2);
    }
    segment = [];
  }
  for (const point of points) { if (point === null) flush(); else segment.push(point); } flush(); return path;
}
function renderChart(snapshot) {
  const root = node('rate-chart-content'), fragment = document.createDocumentFragment();
  const end = snapshot ? snapshot.updatedAt : Date.now(), start = end - chartSeconds * 1000;
  chartPoints = snapshot ? snapshot.series.filter(point => finite(point.timestamp) !== null && point.timestamp >= start && point.timestamp <= end).slice(-320) : [];
  const peak = snapshot ? finite(view.preferences.metric === 'total' ? snapshot.today.peakTotalTps : snapshot.today.peakOutputTps) : null;
  let dataMax = 0;
  for (const point of chartPoints) dataMax = Math.max(dataMax,measuredRate(point)+estimatedRate(point));
  // Frozen ChartMath.ComputeScale/NiceCeiling: do not flatten live data under an unrelated old daily peak.
  const peakInRange = peak !== null && peak > 0 && peak <= Math.max(dataMax * 2.5, 20);
  const target = Math.max(10, dataMax * 1.15, peakInRange ? peak * 1.08 : 0), magnitude = Math.pow(10, Math.floor(Math.log10(target))), fraction = target / magnitude;
  const maximum = (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10) * magnitude;
  const chartTop = 14,chartBottom = 96,width = 328;
  liveChartBounds = { maximum, left: 0, right: width, top: chartTop, bottom: chartBottom };
  const gradient = document.createDocumentFragment(),areaGradient = document.createDocumentFragment();
  for (let index = 0; index <= 8; index++) {
    const offset = index / 8,color = agentSpeedVisuals.color(agentSpeedVisuals.heat(maximum * (1-offset), view.preferences.redline), appearance);
    gradient.append(svgElement('stop', { offset, 'stop-color': color }));
    areaGradient.append(svgElement('stop', { offset, 'stop-color': color, 'stop-opacity': .42*(1-offset*.8) }));
  }
  node('rate-line-gradient').replaceChildren(gradient); node('rate-area-gradient').replaceChildren(areaGradient);
  fragment.append(svgElement('line',{x1:0,x2:width,y1:chartBottom-.5,y2:chartBottom-.5,class:'chart-grid'}),svgElement('text',{x:0,y:10,class:'chart-label'},compact(maximum)));
  const measured = [], total = []; let estimatedFrom = -1;
  for (let index = 0; index < chartPoints.length; index++) {
    const point = chartPoints[index],x = chartPoints.length > 1 ? index / (chartPoints.length-1) * width : 0;
    measured.push([x,chartBottom-Math.min(maximum,measuredRate(point))/maximum*(chartBottom-chartTop)]);
    total.push([x,chartBottom-Math.min(maximum,measuredRate(point)+estimatedRate(point))/maximum*(chartBottom-chartTop)]);
    if (estimatedFrom < 0 && estimatedRate(point) > .05) estimatedFrom = index;
  }
  if (measured.length) {
    if (measured.length === 1) { measured.push([width,measured[0][1]]); total.push([width,total[0][1]]); }
    const area = points => smoothPath(points) + ' L ' + width + ' ' + chartBottom + ' L 0 ' + chartBottom + ' Z';
    if (estimatedFrom >= 0) fragment.append(svgElement('path', { d: area(total), class: 'chart-estimated-area', fill: 'url(#rate-area-gradient)', opacity: .45 }));
    fragment.append(svgElement('path', { d: area(measured), class: 'chart-measured-area', fill: 'url(#rate-area-gradient)' }));
    fragment.append(svgElement('path', { d: smoothPath(measured), class: 'chart-measured', stroke: 'url(#rate-line-gradient)' }));
    if (estimatedFrom >= 0) fragment.append(svgElement('path', { d: smoothPath(total.slice(Math.max(0,estimatedFrom-1))), class: 'chart-estimated', stroke: 'url(#rate-line-gradient)' }));
  }
  if (peakInRange && peak <= maximum) {
    const y = chartBottom - Math.min(maximum, peak) / maximum * (chartBottom - chartTop);
    const color = agentSpeedVisuals.color(agentSpeedVisuals.heat(peak,view.preferences.redline),appearance);
    fragment.append(svgElement('line',{x1:0,x2:width,y1:y,y2:y,class:'chart-peak',stroke:color}),svgElement('text',{x:width,y:y < 14 ? y+12 : y-3,'text-anchor':'end',class:'chart-peak-label'},t('peak')+' '+compact(peak)));
  }
  root.replaceChildren(fragment);
  if (chartPoints.length && (liveChartHover !== null || document.activeElement === node('rate-chart') && !node('rate-chart-cursor').hidden)) showLivePoint(liveChartHover === null ? Number(node('rate-chart').dataset.index || 0) : Math.round(liveChartHover*(chartPoints.length-1)));
  else { node('rate-chart-tooltip').hidden = true; node('rate-chart-cursor').hidden = true; }
}
function showLivePoint(index) {
  if (!chartPoints.length || !liveChartBounds) return;
  const selected = Math.max(0, Math.min(chartPoints.length - 1, index)),point = chartPoints[selected],bounds = liveChartBounds;
  const value = measuredRate(point)+estimatedRate(point),x = chartPoints.length > 1 ? selected / (chartPoints.length-1) * bounds.right : 0;
  const y = bounds.bottom-Math.min(bounds.maximum,value)/bounds.maximum*(bounds.bottom-bounds.top),color = agentSpeedVisuals.color(agentSpeedVisuals.heat(value,view.preferences.redline),appearance);
  node('rate-chart-cursor').replaceChildren(svgElement('line', { x1: x, x2: x, y1: 0, y2: bounds.bottom, class: 'chart-crosshair' }),svgElement('circle', {cx:x,cy:y,r:3.5,fill:color,stroke:'var(--popup)','stroke-width':1.5})); node('rate-chart-cursor').hidden = false;
  const tooltip = node('rate-chart-tooltip'); tooltip.textContent = timestamp(point.timestamp)+' · '+speedNumber(value)+' tok/s'; tooltip.hidden = false;
  const width = node('rate-chart').getBoundingClientRect().width,anchor = x / bounds.right * width;
  tooltip.style.left = Math.max(0,Math.min(width-tooltip.offsetWidth,anchor-tooltip.offsetWidth/2)) + 'px'; tooltip.style.top = '-2px';
}
function renderAgents(agents,disclose = false) {
  if (view.ompSource && !view.ompSource.enabled) agents = [];
  const focused = document.activeElement instanceof Element ? document.activeElement.closest('.agent-row[data-perf-agent-id]') : null, focusedId = focused ? focused.dataset.perfAgentId : null;
  const byId = new Map(agents.map(agent => [agent.id, agent])), children = new Map(), roots = [], visited = new Set(), ordered = [];
  const phaseOrder = { generating: 0, tools: 1, idle: 2 };
  const compare = (left,right) => phaseOrder[left.phase]-phaseOrder[right.phase] || boardModel.rate(right,view.preferences.metric)-boardModel.rate(left,view.preferences.metric) || right.lastActivityAt-left.lastActivityAt || left.id.localeCompare(right.id);
  for (const agent of agents) {
    if (agent.parentId && agent.parentId !== agent.id && byId.has(agent.parentId)) { const list = children.get(agent.parentId) || []; list.push(agent); children.set(agent.parentId, list); }
    else roots.push(agent);
  }
  function visit(agent, depth) { if (visited.has(agent.id)) return; visited.add(agent.id); ordered.push({ agent, depth }); for (const child of (children.get(agent.id) || []).sort(compare)) visit(child, depth + 1); }
  for (const root of roots.sort(compare)) visit(root, 0);
  for (const agent of agents.slice().sort(compare)) if (!visited.has(agent.id)) visit(agent, 0);
  const shown = agentsExpanded || disclose || dashboardDisclosure.frame ? ordered : ordered.slice(0,6),fragment = document.createDocumentFragment();
  for (const { agent, depth } of shown) {
    const row = document.createElement('div'); row.className = 'agent-row'; row.dataset.child = String(depth > 0); row.style.setProperty('--indent', Math.min(depth, 8) * 12 + 'px');
    const copy = document.createElement('div'); copy.className = 'agent-copy'; const project = document.createElement('strong'); project.className = 'agent-project'; project.textContent = agent.project || agent.name || agent.id;
    const detail = document.createElement('span'); detail.className = 'agent-detail'; detail.textContent = (agent.kind === 'advisor' ? language === 'zh' ? '顾问 · ' : 'Advisor · ' : '') + 'OMP · ' + (agent.model || t('unknown')); copy.append(project, detail);
    const phase = document.createElement('span'); phase.className = 'agent-phase'; phase.title = t(agent.phase); phase.setAttribute('aria-label', t(agent.phase));
    if (agent.phase === 'generating') { phase.classList.add('phase-generating'); for (let dot = 0; dot < 3; dot++) phase.append(document.createElement('i')); }
    else if (agent.phase === 'tools') { phase.classList.add('symbol'); phase.textContent = '\uE90F'; }
    else phase.classList.add('phase-idle');
    const rate = document.createElement('span'); rate.className = 'agent-speed';
    const reference = finite(boardModel.rate(agent,view.preferences.metric));
    rate.dataset.muted = String(reference === null || reference < .05); rate.dataset.phase = agent.phase; rate.textContent = reference !== null && reference >= .05 ? speed(reference) : '–'; rate.setAttribute('aria-label', reference !== null && reference >= .05 ? t('live') + ': ' + number(reference, 1) + ' tok/s' : t(agent.phase));
    if (agent.phase === 'tools' && (reference === null || reference < .05)) {
      // Original Windows Dashboard/LiveValue.cs: 11 DIP outlined hourglass and settled sand.
      const hourglass = svgElement('svg', { viewBox: '0 0 11 11', width: 11, height: 11, class: 'agent-hourglass', 'aria-hidden': true });
      hourglass.append(svgElement('path', { d: 'M1.6,0.7 L9.4,0.7 M1.6,10.3 L9.4,10.3 M2.6,0.7 C2.6,3.6 5.5,4.3 5.5,5.5 C5.5,6.7 2.6,7.4 2.6,10.3 M8.4,0.7 C8.4,3.6 5.5,4.3 5.5,5.5 C5.5,6.7 8.4,7.4 8.4,10.3', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.1, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }), svgElement('path', { d: 'M3.7,9.7 L7.3,9.7 L5.5,7.7 Z', fill: 'currentColor', opacity: .75 }));
      rate.replaceChildren(hourglass);
    }
    row.title = (agent.name||agent.id)+'\n'+t('profile')+': '+agent.profile+'\n'+t('project')+': '+(agent.project||'—')+'\n'+t('average')+': '+number(view.preferences.metric === 'total' ? agent.totalTps : agent.outputTps,1)+' tok/s · TTFT: '+(finite(agent.ttftMs) === null ? t('unknown') : number(agent.ttftMs/1000,2)+' s')+'\n'+timestamp(agent.lastActivityAt)+'\n'+perfModeCapsuleFacts(agent).description+'\n'+t('agentNote');
    row.append(copy, phase); const mode = createModeCell(agent), score = createPerfScoreCell(agent); if (mode) row.append(mode); if (score) row.append(score); row.append(rate); if (score) perfUpdateScoreCell(score, agent); fragment.append(row);
  }
  node('agent-rows').replaceChildren(fragment); text('agent-count', agents.length ? number(agents.length) : ''); node('agents-empty').hidden = agents.length > 0; node('agent-note').hidden = agents.length === 0;
  if (focusedId) { const replacement = Array.from(node('agent-rows').querySelectorAll('.agent-row[data-perf-agent-id]')).find(row => row.dataset.perfAgentId === focusedId); if (replacement) replacement.focus({ preventScroll: true }); }
  setDashboardViewport(Math.min(ordered.length,agentsExpanded ? 12 : 6)*44,disclose);
  const toggle = node('agents-toggle'); toggle.hidden = ordered.length <= 6; toggle.setAttribute('aria-expanded', String(agentsExpanded)); toggle.textContent = agentsExpanded ? t('collapseAgents') + ' ⌃' : '+' + number(ordered.length - 6) + ' ' + t('moreAgents') + ' ⌄';
}
function setDashboardViewport(target,animate) {
  const state = dashboardDisclosure,viewport = node('agent-viewport');
  if (!animate && !state.frame || document.hidden || reducedMotion.matches) {
    if (state.frame) cancelAnimationFrame(state.frame); state.frame = 0; state.value = state.target = target; state.velocity = 0; viewport.style.height = target+'px';
    if (animate && reducedMotion.matches) for (const row of Array.from(node('agent-rows').children).slice(6)) perfAnimate(row,[{opacity:0},{opacity:1}],{duration:200,easing:'ease-out'});
    requestDashboardResize(); return;
  }
  if (state.target === target && state.frame) return;
  state.target = target;
  if (!state.frame) { state.value = viewport.getBoundingClientRect().height; state.fromHeight = state.value; state.fromOffset = viewport.scrollTop; state.time = 0; state.frame = requestAnimationFrame(stepDashboardDisclosure); }
}
function stepDashboardDisclosure(time) {
  const state = dashboardDisclosure; state.frame = 0;
  if (rendererDestroyed || document.hidden || !view || view.surface !== 'dashboard') return;
  const next = dashboardSpringStep(state.value,state.velocity,state.target,state.time ? (time-state.time)/1000 : 1/60); state.time = time; state.value = next.value; state.velocity = next.velocity;
  const viewport = node('agent-viewport'); viewport.style.height = Math.max(0,next.value)+'px';
  if (state.fromHeight > state.target) viewport.scrollTop = state.fromOffset*Math.max(0,Math.min(1,(next.value-state.target)/(state.fromHeight-state.target)));
  requestDashboardResize();
  if (next.value === state.target && next.velocity === 0) { if (!agentsExpanded) renderAgents(snapshotFacts() ? snapshotFacts().agents : []); }
  else state.frame = requestAnimationFrame(stepDashboardDisclosure);
}
function requestDashboardResize() {
  if (rendererDestroyed || document.hidden || !view || view.surface !== 'dashboard' || dashboardResizeRaf) return;
  dashboardResizeRaf = requestAnimationFrame(() => {
    dashboardResizeRaf = 0; if (rendererDestroyed || document.hidden || !view || view.surface !== 'dashboard') return;
    const content = node('dashboard-surface').querySelector('.dashboard-scroll'),last = content.lastElementChild; if (!last) return;
    const height = Math.ceil(last.getBoundingClientRect().bottom-content.getBoundingClientRect().top+content.scrollTop+(parseFloat(getComputedStyle(content).paddingBottom)||0));
    if (height <= 0 || height === dashboardHeightSent && dashboardResizePending === null) return;
    dashboardResizePending = height; void sendDashboardResize();
  });
}
async function sendDashboardResize() {
  if (dashboardResizeBusy) return; dashboardResizeBusy = true;
  try {
    while (dashboardResizePending !== null && !rendererDestroyed && !document.hidden && view && view.surface === 'dashboard') {
      const height = dashboardResizePending; dashboardResizePending = null; if (height === dashboardHeightSent) continue;
      await bridge.resizeDashboard(height); dashboardHeightSent = height;
    }
  } catch { dashboardResizePending = null; toast(t('actionFailed')); }
  finally { dashboardResizeBusy = false; }
}
function renderResources(resources) {
  text('resource-status', resources ? t('resource_' + resources.status) : t('unknown'));
  text('resource-cpu', resources && finite(resources.cpuPercent) !== null ? number(resources.cpuPercent, 1) + '%' : '—');
  text('resource-rss', resources && finite(resources.workingSetBytes) !== null ? number(resources.workingSetBytes / 1048576, 1) + ' MB' : '—'); text('resource-private', resources && finite(resources.privateBytes) !== null ? number(resources.privateBytes / 1048576, 1) + ' MB' : '—');
  text('resource-count', resources ? number(resources.status === 'unavailable' && resources.reason !== 'no_processes' ? null : resources.processCount) : '—');
  const notes = [];
  if (resources) { if (resources.reason) notes.push(t('resource_' + resources.reason)); if (resources.cpuPercent === null && resources.processCount > 0 && resources.status !== 'unavailable') notes.push(t('firstSample')); if (resources.sampledAt) notes.push(t('sampled') + ' ' + timestamp(resources.sampledAt)); }
  text('resource-note', notes.join(' · '));
}
function renderCoverage(snapshot) {
  if (!snapshot) { text('coverage-details', t('scanning')); text('updated-at', ''); return; }
  const coverage = snapshot.coverage, roots = coverage.roots.map(root => root.label + ': ' + t(root.available ? 'rootAvailable' : 'rootMissing')).join(' · ');
  const counts = t('files') + ': ' + number(coverage.discoveredFiles) + ' ' + t('discovered') + ' / ' + number(coverage.readFiles) + ' ' + t('read') + ' / ' + number(coverage.skippedFiles) + ' ' + t('skipped') + ' · ' + number(coverage.malformedLines) + ' ' + t('malformed');
  const issues = coverage.issues.map(issue => t('issue_' + issue)); if (coverage.limited) issues.push(t('limited'));
  text('coverage-details', t('roots') + ': ' + (roots || t('unknown')) + '\n' + counts + (issues.length ? '\n' + issues.join(' · ') : '')); text('updated-at', t('updated') + ' ' + timestamp(snapshot.updatedAt, true));
}
function renderPublicData(pricing) {
  const enabled = node('network-enabled'),refresh = node('public-refresh'),currency = node('currency'),rates = node('rates-refresh'),auto = node('auto-sync-prices');
  enabled.disabled = !pricing; enabled.checked = !!(pricing && pricing.networkEnabled); refresh.disabled = !pricing || !pricing.networkEnabled || pricing.prices.status === 'updating'; currency.disabled = !pricing;
  rates.disabled = !pricing || !pricing.networkEnabled || pricing.currency === 'USD' || pricing.rates.status === 'updating'; auto.disabled = !pricing; auto.checked = !!pricing && pricing.autoSyncPrices;
  node('currency-rate-group').hidden = !pricing || pricing.currency === 'USD';
  if (!pricing) { text('public-status', t('unknown')); text('public-details', t('scanning')); text('currency-rate', t('unknown')); return; }
  if (document.activeElement !== currency || !currency.options.length) {
    if (!currencyOptions || currencyOptions.language !== language || !sameOptionValues(currencyOptions.values, pricing.currencies)) {
      const commonCodes = ['USD',...(language === 'zh' ? ['CNY'] : [])];
      for (const currency of displayCurrencies.filter(value => value.common !== null).sort((a,b) => a.common-b.common)) if (!commonCodes.includes(currency.code)) commonCodes.push(currency.code);
      const available = displayCurrencies.filter(value => pricing.currencies.includes(value.code)),common = available.filter(value => commonCodes.includes(value.code)).sort((a,b) => commonCodes.indexOf(a.code)-commonCodes.indexOf(b.code)),other = available.filter(value => !commonCodes.includes(value.code)).sort((a,b) => t('currency.'+a.code).localeCompare(t('currency.'+b.code),language === 'zh' ? 'zh-CN' : 'en-US') || a.code.localeCompare(b.code));
      const fragment = document.createDocumentFragment();
      for (const [title,items] of [[t('currencyCommon'),common],[t('currencyAll'),other]]) {
        const group = document.createElement('optgroup'); group.label = title;
        for (const currency of items) {
          const option = document.createElement('option'),name = t('currency.'+currency.code); option.value = currency.code; option.textContent = currency.code+' · '+name; option.dataset.localizedName = name; option.dataset.englishName = monitorStrings.en['currency.'+currency.code]; option.dataset.symbol = currency.symbols && currency.symbols[language === 'zh' ? 'zh-Hans' : 'en'] || currency.symbol; option.dataset.alternateSymbol = currency.symbol; group.append(option);
        }
        if (items.length) fragment.append(group);
      }
      currency.replaceChildren(fragment);
      currencyOptions = { language, values: pricing.currencies };
    }
    if (currency.value !== pricing.currency) currency.value = pricing.currency;
  }
  text('public-status',t('prices')+(pricing.prices.version ? ' · '+pricing.prices.version : ''));
  for (const [key, feed] of [['prices', pricing.prices], ['rates', pricing.rates]]) {
    text(key + '-status', t('feed_' + feed.status) + ' · ' + t('dataDate') + ': ' + dateLabel(feed.updatedAt) + '\n' + t('lastSuccess') + ': ' + (feed.fetchedAt ? timestamp(feed.fetchedAt, true) : t('neverFetched')));
    text(key + '-source', t('source') + ': ' + feed.source + (feed.version ? '\n' + feed.version : ''));
  }
  text('currency-rate',pricing.currency === 'USD' ? t('noConversion') : finite(pricing.exchangeRate) === null ? pricing.currency+': '+t('rateUnavailable') : '1 USD = '+new Intl.NumberFormat('en-US',{minimumSignificantDigits:4,maximumSignificantDigits:4}).format(pricing.exchangeRate)+' '+pricing.currency+' · '+t('conversionAsOf')+' '+dateLabel(pricing.rates.updatedAt));
  text('currency-attribution', pricing.attribution ? t('attribution') + ': ' + pricing.attribution.label + '\n' + pricing.attribution.url : ''); text('public-details', t('publicPrivacy'));
}
function selectedDates() {
  const today = todayDate(),bounds = view && view.snapshot && view.snapshot.historyRange,earliest = bounds && bounds.startDate || today;
  if (historyRange === 'today') return {startDate:today,endDate:today};
  if (historyRange === 'yesterday') { const yesterday = shiftDate(today,-1); return {startDate:yesterday,endDate:yesterday}; }
  if (historyRange === 'all') return {startDate:earliest,endDate:today};
  if (historyRange === 'year') return {startDate:today.slice(0,4)+'-01-01',endDate:today};
  if (historyRange === 'custom' && parseDate(customStart) && parseDate(customEnd)) { const start = customStart < earliest ? earliest : customStart > today ? today : customStart,end = customEnd > today ? today : customEnd < earliest ? earliest : customEnd; return {startDate:start,endDate:end < start ? start : end}; }
  return {startDate:shiftDate(today,historyRange === '7' ? -6 : historyRange === '90' ? -89 : -29),endDate:today};
}
function exportDates() {
  const dates = selectedDates(),range = view && view.snapshot && view.snapshot.historyRange; if (!range || !range.startDate || dates.endDate < range.startDate || dates.startDate > range.endDate) return null;
  return {startDate:dates.startDate < range.startDate ? range.startDate : dates.startDate,endDate:dates.endDate > range.endDate ? range.endDate : dates.endDate};
}
function hasUsage(day) { return day.requests > 0 || day.inputTokens > 0 || day.outputTokens > 0 || day.totalTokens > 0 || day.peakOutputTps > 0; }
function rangeDays(snapshot) { const range = selectedDates(); return snapshot ? snapshot.days.filter(day => day.date >= range.startDate && day.date <= range.endDate) : []; }
function sumUsage(days) {
  const usage = { requests: 0, failedRequests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0, unpricedRequests: 0, estimatedCostUsd: 0, unestimatedRequests: 0, measuredOutputTokens: 0, measuredDurationMs: 0, peakOutputTps: 0 };
  for (const day of days) for (const key of Object.keys(usage)) usage[key] = key === 'peakOutputTps' ? Math.max(usage[key], day[key]) : usage[key] + day[key];
  return usage;
}
function spark(id, values, highlight = -1) {
  const path = node(id), svg = path.parentElement, width = Math.max(4, svg.clientWidth || 120);
  const count = Math.min(values.length, Math.max(2, Math.floor((width - 4) / 2.5))), samples = [];
  let maximum = 0;
  // Original Sparkline.Bucket averages finite observations, never missing days into zeroes.
  for (let bucket = 0; bucket < count; bucket++) {
    const from = Math.floor(bucket * values.length / count), to = Math.max(from + 1, Math.floor((bucket + 1) * values.length / count));
    let sum = 0, present = 0;
    for (let index = from; index < to; index++) {
      const value = finite(values[index]);
      if (value !== null) { sum += value; present++; }
    }
    const value = present ? sum / present : null;
    samples.push(value);
    if (value !== null) maximum = Math.max(maximum, value);
  }
  svg.setAttribute('viewBox', '0 0 ' + width + ' 24');
  const points = samples.map((value, index) => maximum <= 0 || value === null ? null : [
    2 + (count > 1 ? index * (width - 4) / (count - 1) : (width - 4) / 2),
    22 - Math.max(0, Math.min(1, value / maximum)) * 20,
  ]);
  let area = svg.querySelector('.spark-area');
  if (!area) {
    const gradientId = id + '-area-gradient', defs = svgElement('defs');
    const gradient = svgElement('linearGradient', { id: gradientId, x1: 0, y1: 0, x2: 0, y2: 1 });
    gradient.append(svgElement('stop', { offset: 0, 'stop-color': 'currentColor', 'stop-opacity': .22 }), svgElement('stop', { offset: 1, 'stop-color': 'currentColor', 'stop-opacity': 0 }));
    defs.append(gradient); svg.insertBefore(defs, path);
    area = svgElement('path', { class: 'spark-area', fill: 'url(#' + gradientId + ')', stroke: 'none' });
    svg.insertBefore(area, path);
  }
  let lineData = '', areaData = '';
  const run = [];
  function flush() {
    if (run.length > 1) {
      const curve = smoothPath(run);
      lineData += curve;
      areaData += curve + ' L ' + run[run.length - 1][0].toFixed(2) + ' 24 L ' + run[0][0].toFixed(2) + ' 24 Z';
    }
    run.length = 0;
  }
  for (const point of points) { if (point === null) flush(); else run.push(point); }
  flush();
  path.setAttribute('d', lineData); area.setAttribute('d', areaData);
  let halo = svg.querySelector('.spark-halo'), marker = svg.querySelector('.spark-highlight');
  if (!halo) { halo = svgElement('circle', { r: 4.5, class: 'spark-halo', fill: 'currentColor', opacity: .3 }); svg.append(halo); }
  if (!marker) { marker = svgElement('circle', { class: 'spark-highlight' }); svg.append(marker); }
  const highlighted = Number.isInteger(highlight) && highlight >= 0 && highlight < values.length;
  let selected = highlighted ? Math.floor(highlight * count / values.length) : points.length - 1;
  if (!highlighted) while (selected >= 0 && points[selected] === null) selected--;
  const point = points[selected];
  marker.toggleAttribute('hidden', !point); halo.toggleAttribute('hidden', !point || !highlighted);
  if (point) {
    marker.setAttribute('cx', point[0]); marker.setAttribute('cy', point[1]); marker.setAttribute('r', highlighted ? 2.25 : 1.75);
    marker.setAttribute('fill', 'currentColor'); marker.setAttribute('stroke', 'none');
    if (highlighted) { halo.setAttribute('cx', point[0]); halo.setAttribute('cy', point[1]); }
  }
}
function renderHistory(snapshot) {
  const dates = selectedDates(), days = rangeDays(snapshot), present = days.filter(hasUsage), usage = snapshot ? sumUsage(days) : null;
  const range = snapshot && snapshot.historyRange,notes = [t('historyRetained')]; if (range && range.startDate) notes.push(dateLabel(range.startDate)+' – '+dateLabel(range.endDate)); if (range && range.limited) notes.push(t('historyIncomplete')); if (range && range.scanning) notes.push(t('historyScanning')); text('history-coverage-note',notes.join(' · ')); node('export').disabled = !exportDates();
  const count = Math.round((parseDate(dates.endDate).getTime() - parseDate(dates.startDate).getTime()) / 86400000) + 1;
  text('history-range-label', dateLabel(dates.startDate) + (dates.startDate === dates.endDate ? '' : ' – ' + dateLabel(dates.endDate)) + ' · ' + number(count) + ' ' + t('days'));
  for (const button of node('history-ranges').querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.range === historyRange));
  for (const button of node('history-metrics').querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.metric === historyMetric));
  node('history-empty').hidden = present.length > 0 || !snapshot; node('history-body').hidden = !!snapshot && present.length === 0;
  text('history-output',compact(usage ? usage.outputTokens : null)); text('history-input',compact(inputWithCache(usage))); text('history-requests',compact(usage ? usage.requests : null)); text('history-average',speedNumber(average(usage))); text('history-cost',costText(usage,'recorded'));
  if (average(usage) !== null) { const unit = document.createElement('small'); unit.className = 'history-average-unit'; unit.textContent = 'tok/s'; node('history-average').append(unit); }
  renderHistorySummaryNotes(snapshot,days,dates,usage);
  for (const [id,key] of [['history-output','outputTokens'],['history-requests','requests']]) node(id).title = number(usage ? usage[key] : null); node('history-input').title = number(inputWithCache(usage));
  node('history-cost').title = t('recordedCost') + ': ' + costText(usage, 'recorded', false);
  // Original HistoryWindow FirstFit/Viewbox policy: keep full labels and amounts, shrinking only when necessary.
  for (const label of document.querySelectorAll('.history-summary>h2,.history-summary>strong')) {
    const size = label.tagName === 'H2' ? 12 : 26; label.style.fontSize = size + 'px';
    if (label.clientWidth > 0 && label.scrollWidth > label.clientWidth) label.style.fontSize = Math.max(10, size * label.clientWidth / label.scrollWidth) + 'px';
  }
  const singleDay = dates.startDate === dates.endDate, sparkStart = singleDay ? shiftDate(dates.startDate, -6) : dates.startDate, sparkDays = [], byDate = new Map(snapshot ? snapshot.days.map(day => [day.date, day]) : []);
  for (let date = sparkStart; date <= dates.endDate; date = shiftDate(date, 1)) sparkDays.push(byDate.get(date) || null);
  for (const [id, values] of [['output', sparkDays.map(day => day ? day.outputTokens : null)], ['input', sparkDays.map(day => day ? day.inputTokens : null)], ['requests', sparkDays.map(day => day ? day.requests : null)], ['average', sparkDays.map(day => average(day))], ['cost', sparkDays.map(day => costValue(day, 'recorded'))]]) spark('history-' + id + '-spark', values, singleDay ? sparkDays.length - 1 : -1);
  text('history-unpriced', usage ? number(usage.unpricedRequests) + ' ' + t('unpriced') + ' · ' + number(usage.unestimatedRequests) + ' ' + t('unestimated') + ' · ' + t('catalogNote') : '');
  text('history-updated', t('status_' + currentStatus()) + (snapshot ? ' · ' + t(view.workerError ? 'stale' : 'updated') + ' ' + timestamp(snapshot.updatedAt) : ''));
  const pricing = view.snapshot ? view.snapshot.pricing : null;
  text('history-rate-note', !pricing || pricing.currency === 'USD' ? '' : pricing.currency + ' · ' + (finite(pricing.exchangeRate) === null ? t('rateUnavailable') : dateLabel(pricing.rates.updatedAt) + ' · ' + t('feed_' + pricing.rates.status)));
  renderHistoryChart(days,dates); renderHistoryRows(present); renderHistoryModes(snapshot,dates);
  renderPerfUI(snapshot);
}
function inputWithCache(usage) { return usage ? usage.inputTokens+usage.cacheReadTokens+usage.cacheWriteTokens : null; }
function renderHistorySummaryNotes(snapshot,days,dates,usage) {
  const count = Math.round((Date.parse(dates.endDate)-Date.parse(dates.startDate))/86400000)+1,previousEnd = shiftDate(dates.startDate,-1),previousStart = shiftDate(previousEnd,1-count),bounds = snapshot && snapshot.historyRange;
  const before = bounds && bounds.startDate && bounds.startDate <= previousStart && !bounds.limited && !bounds.scanning ? sumUsage(snapshot.days.filter(day => day.date >= previousStart && day.date <= previousEnd)) : null,single = count === 1;
  const change = (current,previous) => current !== null && previous !== null && previous > 0 ? (current/previous-1)*100 : null;
  const comparison = delta => delta === null ? '' : t(single ? 'previousDay' : 'previousPeriod')+' '+(delta > 0 ? '+' : delta < 0 ? '−' : '')+number(Math.abs(delta))+'%';
  const busiest = key => { let best = null; for (const day of days) if (!best || key(day) > key(best) || key(day) === key(best) && day.date > best.date) best = day; return best && key(best) > 0 ? t('busiestDay')+' '+timeFormatters.shortDate.format(parseDate(best.date)) : ''; };
  const lines = [
    ['output',change(usage && usage.outputTokens,before && before.outputTokens),busiest(day => day.outputTokens)],
    ['input',single ? change(inputWithCache(usage),inputWithCache(before)) : null,busiest(inputWithCache)],
    ['requests',single ? change(usage && usage.requests,before && before.requests) : null,number(days.filter(hasUsage).length)+' '+t('activeDays')],
    ['average',change(average(usage),average(before)),''],
    ['cost',single ? change(costValue(usage,'recorded'),costValue(before,'recorded')) : null,'']
  ];
  for (const [id,delta,fallback] of lines) {
    const note = node('history-'+id).closest('.history-summary').querySelector('.summary-note'); note.classList.remove('history-summary-note-up','history-summary-note-down');
    note.textContent = comparison(delta)||(single ? '' : fallback);
    if (id !== 'cost' && delta !== null && delta !== 0) note.classList.add(delta > 0 ? 'history-summary-note-up' : 'history-summary-note-down');
  }
  if (!single && usage) { const costDays = days.filter(day => day.requests > 0 && costValue(day,'recorded') !== null).length; text('history-cost-note',costDays ? t('costPerDay')+' '+costText({...usage,costUsd:usage.costUsd/costDays},'recorded') : ''); }
}
function historyShareBar(fraction,color) {
  const track = document.createElement('span'); track.className = 'history-share-track';
  const fill = document.createElement('span'); fill.className = 'history-share-fill'; fill.style.display = 'block'; fill.style.width = Math.max(0,Math.min(1,fraction))*100+'%'; if (color) fill.style.background = color;
  track.append(fill); return track;
}
function renderHistoryModels(snapshot,date) {
  const host = node('history-model-breakdown'),models = historyModelBuckets(snapshot && snapshot.breakdowns ? snapshot.breakdowns.models : [],date,historyMetric),entries = [],keys = new Set();
  host.className = 'history-model-rows'; host.style.setProperty('--model-value-width',historyMetric === 'output' ? '76px' : '88px');
  const filter = JSON.stringify([date,historyMetric,view.scope.profile,view.scope.project]),rebuild = host.historyMotionFilter !== filter; host.historyMotionFilter = filter;
  for (const model of models) {
    const key = JSON.stringify([date,'omp',model.model]); keys.add(key);
    let entry = historyModelRows.get(key);
    if (!entry) {
      const row = document.createElement('div'); row.className = 'history-model-row'; row.tabIndex = 0; row.dataset.historyKey = key;
      const name = document.createElement('span'); name.className = 'history-model-name';
      const dot = document.createElement('i'); dot.className = 'source-dot'; dot.setAttribute('aria-hidden','true');
      const label = document.createElement('span'); name.append(dot,label);
      const amount = document.createElement('span'); amount.className = 'history-model-value';
      const share = document.createElement('span'); share.className = 'history-share';
      const speed = document.createElement('span'); speed.className = 'history-model-speed';
      const track = historyShareBar(0); row.append(name,track,amount,share,speed);
      row.addEventListener('keydown',event => {
        if (!['ArrowUp','ArrowDown','Home','End'].includes(event.key)) return; event.preventDefault();
        const next = event.key === 'Home' ? host.firstElementChild : event.key === 'End' ? host.lastElementChild : event.key === 'ArrowUp' ? row.previousElementSibling : row.nextElementSibling;
        if (next && next.classList.contains('history-model-row')) next.focus();
      });
      entry = {key,row,name,label,amount,share,speed,fill:track.firstElementChild,fraction:0}; historyModelRows.set(key,entry);
    }
    const {row,name,label,amount,share,speed} = entry;
    name.dataset.unknown = String(model.model === null); label.textContent = model.model || t('unknownModel');
    amount.textContent = historyMetric === 'output' ? compact(model.outputTokens) : costText(model,historyMetric); amount.title = historyMetric === 'output' ? number(model.outputTokens) : costText(model,historyMetric,false);
    share.textContent = historyPercent(model.share); const measured = average(model); speed.textContent = measured === null ? '–' : speedNumber(measured)+' tok/s';
    row.title = label.textContent+'\n'+t('requests')+': '+number(model.requests)+'\n'+t('output')+': '+number(model.outputTokens)+'\n'+t('recordedCost')+': '+costText(model,'recorded',false)+'\n'+t('catalogCost')+': '+costText(model,'catalog',false)+'\n'+t('average')+': '+speed.textContent; row.setAttribute('aria-label',row.title.replace(/\n/g,', '));
    entry.fraction = model.fraction; entries.push(entry);
  }
  for (const key of historyModelRows.keys()) if (!keys.has(key)) historyModelRows.delete(key);
  const children = entries.map(entry => entry.row);
  if (!children.length) { let empty = host.querySelector('.history-model-empty'); if (!empty) { empty = document.createElement('p'); empty.className = 'history-model-empty'; } empty.textContent = t('modeNoHistory'); children.push(empty); }
  historyReconcileChildren(host,children);
  historyModelMotion.setRows(historyRowLayout(entries,historyModelMotion,host),historySurfaceVisible() && !host.hidden,reducedMotion.matches,rebuild);
  paintHistoryRowsMotion(historyModelMotion,historyModelRows); historyMotionDriver.wake();
}
function hideHistoryModeTooltip() { historyModeTooltipRow = null; if (historyModeTooltip) historyModeTooltip.hidden = true; }
function showHistoryModeTooltip(row,bucket) {
  if (!bucket.topModels.length) { hideHistoryModeTooltip(); return; }
  if (!historyModeTooltip) { historyModeTooltip = document.createElement('div'); historyModeTooltip.className = 'history-mode-models'; historyModeTooltip.setAttribute('role','tooltip'); document.body.append(historyModeTooltip); }
  const header = document.createElement('h3'); header.textContent = t('model'); const fragment = document.createDocumentFragment(); fragment.append(header);
  for (const model of bucket.topModels) {
    const text = document.createElement('p'),name = document.createElement('span'),share = document.createElement('span'); name.textContent = model.model; share.textContent = historyPercent(model.share); text.append(name,share); fragment.append(text,historyShareBar(model.share));
  }
  historyModeTooltip.replaceChildren(fragment); historyModeTooltip.hidden = false; historyModeTooltipRow = row; positionHistoryModeTooltip(row);
}
function positionHistoryModeTooltip(row) {
  const bounds = row.getBoundingClientRect(); historyModeTooltip.style.left = Math.max(8,Math.min(window.innerWidth-historyModeTooltip.offsetWidth-8,bounds.left+26))+'px';
  historyModeTooltip.style.top = Math.max(8,bounds.top-historyModeTooltip.offsetHeight-6)+'px';
}
function renderHistoryModes(snapshot,dates) {
  for (const button of node('history-mode-kind').children) button.setAttribute('aria-pressed',String(button.dataset.modeKind === historyModeKind));
  const buckets = historyModeBuckets(snapshot && snapshot.breakdowns ? snapshot.breakdowns.modes : [],historyModeKind,dates.startDate,dates.endDate),host = node('history-mode-rows'),entries = [],keys = new Set();
  let header = host.querySelector('.history-mode-header');
  if (!header) { header = document.createElement('div'); header.className = 'history-mode-header'; for (let index = 0; index < 7; index++) header.append(document.createElement('span')); }
  const labels = ['',t(historyModeKind === 'effort' ? 'effort' : 'speedMode'),'',t('share'),t('requests'),t('output'),t('average')];
  for (let index = 0; index < labels.length; index++) header.children[index].textContent = labels[index];
  for (const bucket of buckets) {
    const key = JSON.stringify([historyModeKind,bucket.value]); keys.add(key);
    let entry = historyModeRows.get(key);
    if (!entry) {
      const row = document.createElement('div'); row.className = 'history-mode-row'; row.tabIndex = 0; row.dataset.historyKey = key; row.dataset.mode = bucket.value; row.dataset.modeKind = historyModeKind;
      const glyph = document.createElement('span'); glyph.className = 'history-mode-glyph perf-theme'; glyph.setAttribute('aria-hidden','true');
      const token = document.createElement('span'); token.className = 'history-mode-token';
      const share = document.createElement('span'); share.className = 'history-share';
      const requests = document.createElement('span'); requests.className = 'history-mode-number';
      const output = document.createElement('span'); output.className = 'history-mode-number';
      const speed = document.createElement('span'); speed.className = 'history-mode-number';
      const track = historyShareBar(0); row.append(glyph,token,track,share,requests,output,speed);
      entry = {key,row,glyph,token,share,requests,output,speed,fill:track.firstElementChild,fraction:0,bucket}; historyModeRows.set(key,entry);
      row.addEventListener('pointerenter',() => showHistoryModeTooltip(row,entry.bucket)); row.addEventListener('pointerleave',hideHistoryModeTooltip); row.addEventListener('focus',() => showHistoryModeTooltip(row,entry.bucket)); row.addEventListener('blur',hideHistoryModeTooltip);
      row.addEventListener('keydown',event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); hideHistoryModeTooltip(); }
        else if (['ArrowUp','ArrowDown','Home','End'].includes(event.key)) {
          event.preventDefault(); const next = event.key === 'Home' ? header.nextElementSibling : event.key === 'End' ? host.lastElementChild : event.key === 'ArrowUp' ? row.previousElementSibling : row.nextElementSibling;
          if (next && next.classList.contains('history-mode-row')) next.focus();
        }
      });
    }
    const {row,glyph,token,share,requests,output,speed} = entry,unknown = bucket.value === 'unknown'; row.dataset.unknown = String(unknown);
    if (!unknown) {
      const fact = {value:bucket.value},agent = {effortMode:historyModeKind === 'effort' ? fact : null,speedMode:historyModeKind === 'speed' ? fact : null},facts = perfModeCapsuleFacts(agent);
      if (facts.level >= 0 || facts.bolts) {
        perfUpdateModeCell(glyph,agent); glyph.hidden = false; glyph.removeAttribute('title'); const capsule = glyph.firstElementChild; capsule.classList.add('perf-history-glyph'); capsule.setAttribute('aria-label',bucket.value);
        for (const word of capsule.querySelectorAll('.perf-effort-word,.perf-mode-mark')) word.remove();
      } else if (historyModeKind === 'speed' && !glyph.firstElementChild) { const ring = document.createElement('i'); ring.className = 'history-mode-ring'; glyph.append(ring); }
    }
    token.textContent = unknown ? t('modeUnknown') : bucket.value;
    let fill = unknown ? 'color-mix(in srgb,var(--text) 12%,transparent)' : '';
    if (historyModeKind === 'effort' && (bucket.value === 'ultra' || bucket.value === 'ultracode')) fill = 'linear-gradient(to right,'+agentSpeedVisuals.color(.72,appearance)+','+agentSpeedVisuals.color(1,appearance)+')';
    else if (historyModeKind === 'effort' && bucket.value === 'max') fill = agentSpeedVisuals.color(.82,appearance);
    else if (historyModeKind === 'speed' && ['fast','highspeed','ultrafast'].includes(bucket.value)) fill = appearance === 'dark' ? '#F5A524' : '#B86E00';
    entry.fill.style.background = fill; share.textContent = historyPercent(bucket.share); requests.textContent = number(bucket.requests); output.textContent = compact(bucket.outputTokens); output.title = number(bucket.outputTokens);
    const measured = average(bucket); speed.dataset.missing = String(measured === null); speed.textContent = measured === null ? '–' : speedNumber(measured)+' tok/s';
    row.setAttribute('aria-label',token.textContent+', '+t('share')+' '+share.textContent+', '+t('requests')+' '+requests.textContent+', '+t('output')+' '+number(bucket.outputTokens)+', '+t('average')+' '+speed.textContent);
    entry.bucket = bucket; entry.fraction = bucket.share; entries.push(entry);
  }
  for (const key of historyModeRows.keys()) if (!keys.has(key)) historyModeRows.delete(key);
  if (historyModeTooltipRow && !entries.some(entry => entry.row === historyModeTooltipRow)) hideHistoryModeTooltip();
  historyReconcileChildren(host,[header,...entries.map(entry => entry.row)]);
  historyModeMotion.setRows(historyRowLayout(entries,historyModeMotion,host),historySurfaceVisible(),reducedMotion.matches);
  paintHistoryRowsMotion(historyModeMotion,historyModeRows); historyMotionDriver.wake();
  if (historyModeTooltipRow) { const entry = entries.find(entry => entry.row === historyModeTooltipRow); if (entry) showHistoryModeTooltip(entry.row,entry.bucket); }
  node('history-modes-export').disabled = !snapshot || !buckets.some(row => row.requests > 0);
  const note = node('history-mode-note'); note.textContent = buckets.some(row => row.value !== 'unknown') ? t('modeHistoryNote') : t('modeNotRecorded')+' '+t('modeHistoryNote');
}
function historyBarValue(day) {
  if (historyMetric === 'output') return finite(day.outputTokens);
  const value = costValue(day,historyMetric),currency = boardCurrency(view.snapshot); return value === null || currency.rate === null ? null : value*currency.rate;
}
function renderHistoryChart(days,dates) {
  const chart = node('history-chart'),root = node('history-chart-content'),singleDay = dates.startDate === dates.endDate,currency = boardCurrency(view.snapshot);
  const ordered = days.slice().sort((a,b) => a.date.localeCompare(b.date)); historyChartDays = ordered.filter(hasUsage);
  let dataMax = 0,speedMax = 0; for (const day of ordered) { dataMax = Math.max(dataMax,historyBarValue(day)||0); speedMax = Math.max(speedMax,average(day)||0); }
  const showSpeed = historyMetric === 'output' && speedMax > 0;
  node('history-speed-legend').hidden = !showSpeed; chart.hidden = singleDay; chart.toggleAttribute('hidden',singleDay); node('history-model-breakdown').hidden = !singleDay;
  chart.setAttribute('aria-label',t(historyMetric === 'output' ? 'historyChart' : historyMetric === 'recorded' ? 'recordedCost' : 'catalogCost')+' · '+dateLabel(dates.startDate)+' – '+dateLabel(dates.endDate));
  text('history-chart-currency',historyMetric === 'output' ? '' : ' · '+currency.currency+' · '+t(historyMetric === 'recorded' ? 'recorded' : 'catalog')+(currency.rate === null ? ' · '+t('rateUnavailable') : ''));
  syncHistoryMotionVisibility();
  if (singleDay) {
    historyChartMotion.finish(); if (historyChartScene) historyChartScene.visible = false;
    renderHistoryModels(snapshotFacts(),dates.startDate); node('history-chart-tooltip').hidden = true; return;
  }
  historyModelMotion.finish();
  const chartWidth = chart.getBoundingClientRect().width;
  if (chartWidth <= 0) { historyChartMotion.finish(); if (historyChartScene) historyChartScene.visible = false; return; }
  chart.setAttribute('viewBox','0 0 '+chartWidth+' 260');
  if (!historyChartScene) {
    const grid = svgElement('g',{'aria-hidden':true}),marks = svgElement('g',{'aria-hidden':true}),ghosts = svgElement('g',{'aria-hidden':true,'pointer-events':'none'}),bars = svgElement('g',{}),line = svgElement('g',{'aria-hidden':true,'pointer-events':'none'}),caption = svgElement('text',{'text-anchor':'middle',class:'chart-label','font-size':10,'aria-hidden':true,'pointer-events':'none'});
    const path = svgElement('path',{class:'history-average'}); line.append(path);
    historyReconcileChildren(root,[grid,marks,ghosts,bars,line,caption]);
    historyChartScene = {grid,marks,ghosts,bars,line,path,caption,barNodes:new Map(),ghostLayers:new Map(),lineDots:new Map(),visible:false};
  }
  const scene = historyChartScene,wasVisible = scene.visible; scene.visible = historySurfaceVisible();
  const nice = value => { if (!(value > 0)) return 1; const magnitude = 10**Math.floor(Math.log10(value)); for (const step of [1,2,2.5,5,10]) if (step*magnitude >= value*(1-1e-9)) return step*magnitude; return 10*magnitude; };
  const tickStep = nice(dataMax/4),intervals = dataMax > 0 ? Math.max(1,Math.min(4,Math.ceil(dataMax/tickStep-1e-9))) : 4,maximum = tickStep*intervals,speedStep = nice(speedMax/intervals),maximumAverage = speedStep*intervals;
  const axis = value => historyMetric === 'output' ? compact(value) : number(value,tickStep < 1 ? Math.min(2,Math.max(currency.digits,Math.ceil(-Math.log10(tickStep)))) : 0),labels = Array.from({length:intervals+1},(_,index) => axis(tickStep*index));
  const left = Math.ceil(Math.max(24,...labels.map(label => perfMeasureText(label,11,400)+10))),rightMargin = showSpeed ? Math.ceil(Math.max(12,perfMeasureText('tok/s',10,400)+4,...Array.from({length:intervals+1},(_,index) => perfMeasureText(speedNumber(speedStep*index),11,400)+10))) : 12;
  const start = Date.parse(dates.startDate)/86400000,count = Math.round(Date.parse(dates.endDate)/86400000-start)+1,slot = Math.max(0,chartWidth-rightMargin-left)/count;
  Object.assign(scene,{chartWidth,start,count,dates,today:todayDate(),showSpeed,maximumAverage,gridRows:[],monthRules:[],monthLabels:[],dayLabels:[],speeds:[],days:new Map()});
  const grid = document.createDocumentFragment(),marks = document.createDocumentFragment();
  for (let index = 0; index <= intervals; index++) {
    const rule = svgElement('line',{class:'chart-grid'}),label = svgElement('text',{'text-anchor':'end',class:'chart-label'},labels[index]),speed = showSpeed ? svgElement('text',{class:'chart-label'},speedNumber(speedStep*index)) : null;
    grid.append(rule,label); if (speed) grid.append(speed); scene.gridRows.push({value:tickStep*index,rule,label,speed});
  }
  if (showSpeed) grid.append(svgElement('text',{x:chartWidth,y:10,'text-anchor':'end',class:'chart-axis','font-size':10},'tok/s'));
  scene.grid.replaceChildren(grid);
  const frameBars = [];
  for (const day of ordered) {
    const index = Math.round(Date.parse(day.date)/86400000-start),key = JSON.stringify([day.date,'omp']),value = historyBarValue(day);
    frameBars.push({key,date:day.date,source:'omp',value:value||0}); scene.days.set(key,{day,tooltip:historyTooltip(day),value:value||0});
    if (showSpeed) scene.speeds.push({key,index,speed:average(day)});
  }
  const monthStep = [1,2,3,6,12].find(step => 30.4*step*slot >= 44)||12,months = [];
  for (let date = dates.startDate.slice(0,7)+'-01'; date <= dates.endDate;) {
    const index = Math.round(Date.parse(date)/86400000-start),parsed = parseDate(date);
    if (index > 0) {
      if (monthStep === 1 || 30.4*slot >= 6 || parsed.getMonth()%monthStep === 0) { const rule = svgElement('line',{y1:14,y2:238,class:'chart-grid',opacity:.75}); marks.append(rule); scene.monthRules.push({index,rule}); }
      if (parsed.getMonth()%monthStep === 0) months.push({index,date});
    }
    parsed.setMonth(parsed.getMonth()+1); date = localDate(parsed);
  }
  if (!months.length || months[0].index*slot >= 55) months.unshift({index:0,date:dates.startDate});
  const monthFormatter = new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en-US',{month:'short'}),yearMonthFormatter = new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en-US',{year:'numeric',month:'short'});
  for (const month of months) {
    const date = parseDate(month.date),label = (date.getMonth() === 0 || month.index === 0 && month.date.slice(0,4) !== scene.today.slice(0,4) ? yearMonthFormatter : monthFormatter).format(date),element = svgElement('text',{y:13,class:'chart-label','font-weight':600},label);
    marks.append(element); scene.monthLabels.push({index:month.index,element,width:perfMeasureText(label,11,600)});
  }
  const dayStep = [1,2,7,14].find(step => step*slot >= 33),dayMarks = [];
  if (dayStep) for (let index = count-1; index >= 0; index -= dayStep) dayMarks.push(index);
  for (const index of dayMarks.reverse()) {
    const date = shiftDate(dates.startDate,index),label = slot >= 44 ? timeFormatters.shortDate.format(parseDate(date)) : String(parseDate(date).getDate()),weight = date === scene.today ? 600 : 400,element = svgElement('text',{y:254,class:'chart-axis','font-size':10.5,'font-weight':weight},label);
    marks.append(element); scene.dayLabels.push({index,element,width:perfMeasureText(label,10.5,weight)});
  }
  scene.marks.replaceChildren(marks); scene.caption.textContent = t('inProgress');
  const target = {startDate:dates.startDate,endDate:dates.endDate,metric:historyMetric+(historyMetric === 'output' ? '' : ':'+currency.currency),filter:JSON.stringify([view.scope.profile,view.scope.project,view.instanceId]),maximum,left,right:rightMargin,bars:frameBars},previous = historyChartMotion.target;
  const morph = previous && (previous.startDate !== target.startDate || previous.endDate !== target.endDate || previous.metric !== target.metric || previous.filter !== target.filter);
  const transition = !scene.visible || historyChartResumeSnap || historyChartEntered && !wasVisible ? 'snap' : !historyChartEntered && dataMax > 0 ? 'entrance' : morph ? 'morph' : 'live';
  historyChartMotion.setTarget(target,transition,reducedMotion.matches);
  if (dataMax > 0) historyChartEntered = true; historyChartResumeSnap = false;
  if (morph) { node('history-chart-tooltip').hidden = true; historyChartTooltipDate = null; }
  else if (!node('history-chart-tooltip').hidden && historyChartTooltipDate) {
    const current = ordered.find(day => day.date === historyChartTooltipDate); if (current) node('history-chart-tooltip').textContent = historyTooltip(current); else node('history-chart-tooltip').hidden = true;
  }
  paintHistoryChartMotion(); historyMotionDriver.wake();
}
function paintHistoryChartMotion() {
  const scene = historyChartScene,sample = historyChartMotion.sample(),frame = sample.frame;
  if (!scene || !frame || !scene.gridRows) return;
  const left = frame.left,right = Math.max(left,scene.chartWidth-frame.right),width = right-left,slot = width/scene.count,top = 20,bottom = 238,height = bottom-top,ppd = window.devicePixelRatio||1;
  let barWidth = slot*(1-.28); barWidth = slot >= 3 ? Math.min(barWidth,slot-1) : slot; barWidth = Math.max(Math.min(slot,1),Math.min(28,barWidth));
  const placeBar = (element,value,index,maximum) => {
    const x = Math.round((left+slot*(index+.5)-barWidth/2)*ppd)/ppd-.5/ppd,right = Math.round((left+slot*(index+.5)+barWidth/2)*ppd)/ppd-.5/ppd,w = Math.max(right-x,1/ppd),h = Math.min(1,value/Math.max(1e-9,maximum))*height;
    element.setAttribute('x',x); element.setAttribute('y',bottom-h); element.setAttribute('width',w); element.setAttribute('height',Math.max(h,.5/ppd)); element.setAttribute('rx',w <= 3 ? 0 : Math.min(3,w/2,h));
    element.style.display = slot > 0 ? '' : 'none'; element.style.opacity = h > .05 ? '' : '0';
  };
  for (const row of scene.gridRows) {
    const y = bottom-row.value/Math.max(frame.maximum,1e-9)*height,visible = y >= top-.5 && y <= bottom+.5;
    row.rule.style.display = row.label.style.display = visible ? '' : 'none'; row.rule.setAttribute('x1',left); row.rule.setAttribute('x2',right); row.rule.setAttribute('y1',y); row.rule.setAttribute('y2',y);
    row.label.setAttribute('x',left-8); row.label.setAttribute('y',Math.max(0,y+3.5));
    if (row.speed) { row.speed.style.display = visible ? '' : 'none'; row.speed.setAttribute('x',right+8); row.speed.setAttribute('y',Math.max(0,y+3.5)); }
  }
  for (const mark of scene.monthRules) { mark.rule.setAttribute('x1',left+mark.index*slot); mark.rule.setAttribute('x2',left+mark.index*slot); }
  for (const mark of scene.monthLabels) { const x = left+mark.index*slot+(mark.index === 0 ? 0 : 4); mark.element.setAttribute('x',x); mark.element.style.display = x+mark.width <= scene.chartWidth-(scene.showSpeed ? perfMeasureText('tok/s',10,400)+8 : 0) ? '' : 'none'; }
  let lastRight = -Infinity;
  for (const mark of scene.dayLabels) {
    const x = Math.max(0,Math.min(scene.chartWidth-mark.width,left+slot*(mark.index+.5)-mark.width/2)),visible = x >= lastRight+4; mark.element.setAttribute('x',x); mark.element.style.display = visible ? '' : 'none'; if (visible) lastRight = x+mark.width;
  }
  const seen = new Set();
  for (const bar of frame.bars) {
    seen.add(bar.key); let entry = scene.barNodes.get(bar.key);
    if (!entry) {
      const element = svgElement('rect',{class:'history-bar','data-date':bar.date,'data-source':bar.source,'data-history-key':bar.key,role:'button'}),title = svgElement('title',{}); element.append(title);
      entry = {element,title,day:null,start:null,index:0,tooltip:null}; scene.barNodes.set(bar.key,entry); scene.bars.append(element);
      element.addEventListener('pointermove',event => { if (entry.day) showHistoryTooltip(entry.day,event); }); element.addEventListener('pointerleave',() => { node('history-chart-tooltip').hidden = true; });
      element.addEventListener('focus',() => { if (entry.day) showHistoryTooltip(entry.day); }); element.addEventListener('blur',() => { node('history-chart-tooltip').hidden = true; });
      element.addEventListener('click',() => { if (entry.day) selectHistoryDate(entry.day.date,true); });
      element.addEventListener('keydown',event => { if (entry.day && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); selectHistoryDate(entry.day.date,true); } });
    }
    const facts = scene.days.get(bar.key); entry.day = facts ? facts.day : null;
    if (entry.start !== scene.start) { entry.start = scene.start; entry.index = Math.round(Date.parse(bar.date)/86400000-scene.start); }
    if (facts && entry.tooltip !== facts.tooltip) { entry.tooltip = facts.tooltip; entry.title.textContent = facts.tooltip; entry.element.setAttribute('aria-label',facts.tooltip); }
    entry.element.setAttribute('tabindex',facts && facts.value > 0 ? 0 : -1); entry.element.style.pointerEvents = facts && facts.value > 0 ? '' : 'none';
    entry.element.setAttribute('fill',bar.date === scene.today ? 'url(#history-today-hatch)' : 'url(#history-bar-gradient)');
    const selected = bar.date === selectedHistoryDate; entry.element.setAttribute('stroke',selected ? 'var(--accent)' : 'none'); entry.element.setAttribute('stroke-width',selected ? 2 : 0);
    placeBar(entry.element,bar.value,entry.index,frame.maximum);
  }
  for (const [key,entry] of scene.barNodes) if (!seen.has(key)) { if (document.activeElement === entry.element) node('history-chart').focus({preventScroll:true}); entry.element.remove(); scene.barNodes.delete(key); }
  if (scene.lastBarsFrame !== frame.bars) { historyReconcileChildren(scene.bars,frame.bars.map(bar => scene.barNodes.get(bar.key).element)); scene.lastBarsFrame = frame.bars; }
  scene.bars.setAttribute('opacity',sample.opacity);
  const oldLayers = new Set();
  for (const layer of sample.layers) {
    oldLayers.add(layer.id); let group = scene.ghostLayers.get(layer.id);
    if (!group) {
      const element = svgElement('g',{}),bars = [];
      for (const bar of layer.frame.bars) { const node = svgElement('rect',{fill:bar.date === scene.today ? 'url(#history-today-hatch)' : 'url(#history-bar-gradient)'}); element.append(node); bars.push({element:node,value:bar.value,index:Math.round((Date.parse(bar.date)-Date.parse(layer.frame.startDate))/86400000)}); }
      group = {element,bars}; scene.ghostLayers.set(layer.id,group); scene.ghosts.append(element);
    }
    group.element.setAttribute('opacity',layer.opacity*(1-sample.opacity));
    for (const bar of group.bars) placeBar(bar.element,bar.value,bar.index,layer.frame.maximum);
  }
  for (const [key,group] of scene.ghostLayers) if (!oldLayers.has(key)) { group.element.remove(); scene.ghostLayers.delete(key); }
  const points = [],dots = new Set(); let previous = null;
  for (let index = 0; index < scene.speeds.length; index++) {
    const point = scene.speeds[index];
    if (previous !== null && point.index !== previous+1) points.push(null); previous = point.index;
    if (point.speed === null) { points.push(null); continue; }
    const x = left+slot*(point.index+.5),y = bottom-Math.min(1,point.speed/scene.maximumAverage)*height; points.push([x,y]); dots.add(point.key);
    let dot = scene.lineDots.get(point.key); if (!dot) { dot = svgElement('circle',{r:2.25,class:'history-average-dot'}); scene.lineDots.set(point.key,dot); scene.line.append(dot); }
    const before = scene.speeds[index-1],after = scene.speeds[index+1],isolated = !(before && before.index === point.index-1 && before.speed !== null) && !(after && after.index === point.index+1 && after.speed !== null);
    dot.setAttribute('cx',x); dot.setAttribute('cy',y); dot.style.display = slot >= 6 || isolated ? '' : 'none';
  }
  for (const [key,dot] of scene.lineDots) if (!dots.has(key)) { dot.remove(); scene.lineDots.delete(key); }
  if (slot >= 8) scene.path.setAttribute('d',smoothPath(points));
  else { let path = '',first = true; for (const point of points) { if (!point) { first = true; continue; } path += (first ? 'M ' : ' L ')+point[0]+' '+point[1]; first = false; } scene.path.setAttribute('d',path); }
  scene.line.setAttribute('opacity',sample.lineAlpha); scene.line.style.display = scene.showSpeed ? '' : 'none';
  const todayKey = JSON.stringify([scene.today,'omp']),today = historyChartMotion.target && historyChartMotion.target.bars.find(bar => bar.key === todayKey);
  const caption = today && today.value > 0 && (!historyChartMotion.active || sample.fading) && perfMeasureText(scene.caption.textContent,10,400) <= Math.max(slot*3,40);
  scene.caption.style.display = caption ? '' : 'none';
  if (caption) {
    const index = Math.round(Date.parse(scene.today)/86400000-scene.start),w = perfMeasureText(scene.caption.textContent,10,400),x = Math.max(left+w/2,Math.min(right-w/2,left+slot*(index+.5))),y = bottom-Math.min(1,today.value/historyChartMotion.target.maximum)*height-6;
    scene.caption.setAttribute('x',x); scene.caption.setAttribute('y',Math.max(top-2,y)); scene.caption.setAttribute('opacity',sample.opacity);
  }
}
function historyTooltip(day) {
  return dateLabel(day.date)+' · '+timeFormatters.weekday.format(parseDate(day.date))+'\n'+t('output')+': '+number(day.outputTokens)+' · '+t('input')+': '+number(inputWithCache(day))+'\n'+t('requests')+': '+number(day.requests)+' / '+number(day.failedRequests)+' '+t('failures')+'\n'+t('average')+': '+speedNumber(average(day))+' tok/s · '+t('peak')+': '+speedNumber(day.peakOutputTps)+' tok/s\n'+t('recordedCost')+': '+costText(day,'recorded',false)+'\n'+t('catalogCost')+': '+costText(day,'catalog',false);
}
function showHistoryTooltip(day, event = null) {
  historyChartTooltipDate = day.date; const tooltip = node('history-chart-tooltip'), parent = tooltip.parentElement.getBoundingClientRect(); tooltip.textContent = historyTooltip(day); tooltip.hidden = false;
  const x = event ? event.clientX - parent.left + 12 : 52, y = event ? event.clientY - parent.top - tooltip.offsetHeight - 12 : 56;
  tooltip.style.left = Math.max(8, Math.min(parent.width - tooltip.offsetWidth - 8, x)) + 'px'; tooltip.style.top = Math.max(40, y) + 'px';
}
function cell(row, value, numeric = false) { const td = document.createElement('td'); td.textContent = String(value); if (numeric) td.className = 'number'; row.append(td); return td; }
function renderHistoryRows(days) {
  const models = new Map(),snapshot = snapshotFacts();
  for (const row of snapshot && snapshot.breakdowns ? snapshot.breakdowns.models : []) { if (!row.model) continue; let bucket = models.get(row.date); if (!bucket) { bucket = new Map(); models.set(row.date,bucket); } bucket.set(row.model,(bucket.get(row.model)||0)+row.outputTokens); }
  const modelNames = day => Array.from(models.get(day.date)||[],([name,output]) => ({name,output})).sort((a,b) => b.output-a.output || a.name.localeCompare(b.name)).map(model => model.name);
  const cache = day => inputWithCache(day) > 0 ? day.cacheReadTokens/inputWithCache(day) : null;
  const key = day => historySort === 'average' ? average(day) : historySort === 'inputTokens' ? inputWithCache(day) : historySort === 'cacheHit' ? cache(day) : historySort === 'models' ? modelNames(day).join(', ') : day[historySort];
  const sorted = days.slice().sort((left,right) => { const a = key(left),b = key(right),result = typeof a === 'string' ? a.localeCompare(b) : a === null ? b === null ? 0 : -1 : b === null ? 1 : a-b; return (historyDescending ? -1 : 1)*result || right.date.localeCompare(left.date); });
  const fragment = document.createDocumentFragment(),today = todayDate(),yesterday = shiftDate(today,-1),hasPeak = days.some(day => day.peakOutputTps > 0);
  for (const day of sorted) {
    const row = document.createElement('tr'); row.dataset.date = day.date; row.dataset.selected = String(day.date === selectedHistoryDate); row.tabIndex = 0; row.title = historyTooltip(day);
    cell(row,day.date === today ? t('today') : day.date === yesterday ? t('yesterday') : timeFormatters.shortDate.format(parseDate(day.date))+(language === 'zh' ? '（' : ' (')+timeFormatters.weekday.format(parseDate(day.date))+(language === 'zh' ? '）' : ')'));
    cell(row,number(day.requests),true).title = number(day.failedRequests)+' '+t('failedRequests');
    cell(row,compact(day.outputTokens),true).title = number(day.outputTokens); cell(row,compact(inputWithCache(day)),true).title = number(inputWithCache(day));
    for (const mode of ['recorded','catalog']) cell(row,costText(day,mode),true).title = costText(day,mode,false)+'\n'+(mode === 'recorded' ? number(day.unpricedRequests)+' '+t('unpriced') : number(day.unestimatedRequests)+' '+t('unestimated'));
    cell(row,historyPercent(cache(day)),true).title = number(day.cacheReadTokens)+' / '+number(inputWithCache(day)); cell(row,average(day) === null ? '—' : speedNumber(average(day))+' tok/s',true);
    const peak = cell(row,day.peakOutputTps > 0 ? speedNumber(day.peakOutputTps)+' tok/s' : '—',true); peak.hidden = !hasPeak; const peakAt = day.date === today && day.peakOutputTps > 0 && view.snapshot ? finite(view.snapshot.activity.peakAt) : null; peak.title = peakAt === null ? t('historyPeakTimeUnknown') : t('peakMeasurement')+' '+timestamp(peakAt,true);
    cell(row,number(day.agentCount),true); const names = modelNames(day),model = cell(row,names.length ? names.slice(0,2).join(', ')+(names.length > 2 ? ' +'+(names.length-2) : '') : '—'); model.title = names.join('\n'); model.style.color = 'var(--secondary)';
    row.addEventListener('click',() => selectHistoryDate(day.date,false)); row.addEventListener('focus',() => { selectedHistoryDate = day.date; markSelectedHistory(); });
    row.addEventListener('keydown',event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); const next = event.key === 'ArrowDown' ? row.nextElementSibling : row.previousElementSibling; if (next) next.focus(); } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') { event.preventDefault(); action(async () => { await navigator.clipboard.writeText([day.date,number(day.requests),number(day.outputTokens),number(inputWithCache(day)),costText(day,'recorded'),costText(day,'catalog'),historyPercent(cache(day)),average(day) === null ? '—' : speedNumber(average(day)),day.peakOutputTps > 0 ? speedNumber(day.peakOutputTps) : '—',number(day.agentCount),names.join(', ')].join('\t')); toast(perfT('copied')); }); } }); fragment.append(row);
  }
  node('history-rows').replaceChildren(fragment); document.querySelector('[data-history-peak]').hidden = !hasPeak;
  for (const button of document.querySelectorAll('[data-sort]')) button.parentElement.setAttribute('aria-sort',button.dataset.sort === historySort ? historyDescending ? 'descending' : 'ascending' : 'none');
  fitHistoryTable();
}
function historyPercent(ratio) { return ratio === null || !Number.isFinite(ratio) ? '—' : ratio > 0 && ratio < .005 ? '<1%' : Math.round(Math.max(0,Math.min(1,ratio))*100)+'%'; }
function fitHistoryTable() {
  const table = node('history-daily-table'),headers = Array.from(table.tHead.rows[0].cells),rows = Array.from(table.tBodies[0].rows),available = table.parentElement.clientWidth-24; if (!(available > 0)) return;
  const specs = headers.map((header,index) => { if (header.hidden) return {natural:0,minimum:0,weight:0}; let cell = 0; for (const row of rows) cell = Math.max(cell,perfMeasureText(row.cells[index].textContent,13,400)); const head = perfMeasureText(header.textContent,12,600)+16; return index === headers.length-1 ? {natural:Math.max(124,head),minimum:66,weight:1} : {natural:Math.max(head,cell),minimum:index === 0 ? cell : Math.max(cell,24),weight:0}; });
  const shown = specs.filter(spec => spec.natural > 0),minimum = shown.reduce((sum,spec) => sum+spec.minimum,0),padding = Math.max(4,Math.min(8,(available-minimum)/(2*Math.max(1,shown.length)))),padded = specs.map(spec => ({...spec,natural:spec.natural+(spec.natural ? 2*padding : 0),minimum:spec.minimum+(spec.natural ? 2*padding : 0)})),natural = padded.reduce((sum,spec) => sum+spec.natural,0),min = padded.reduce((sum,spec) => sum+spec.minimum,0),slack = natural-min;
  const widths = padded.map(spec => min > available ? spec.minimum*available/min : natural > available ? spec.natural-(spec.natural-spec.minimum)*(natural-available)/Math.max(1,slack) : spec.natural+(spec.weight ? available-natural : 0));
  let columns = table.querySelector('colgroup'); if (!columns) { columns = document.createElement('colgroup'); table.prepend(columns); }
  const fragment = document.createDocumentFragment(); for (const width of widths) { if (width <= 0) continue; const col = document.createElement('col'); col.style.width = width+'px'; fragment.append(col); } columns.replaceChildren(fragment); table.style.setProperty('--history-cell-padding',padding+'px');
}
function markSelectedHistory() {
  for (const row of node('history-rows').children) row.dataset.selected = String(row.dataset.date === selectedHistoryDate);
  for (const bar of node('history-chart-content').querySelectorAll('[data-date]')) { const selected = bar.dataset.date === selectedHistoryDate; bar.setAttribute('stroke', selected ? 'var(--accent)' : 'none'); bar.setAttribute('stroke-width', selected ? '2' : '0'); }
}
function selectHistoryDate(date, scroll) {
  selectedHistoryDate = date; markSelectedHistory(); const row = Array.from(node('history-rows').children).find(element => element.dataset.date === date);
  if (scroll && row) { row.scrollIntoView({ block: 'nearest', behavior: reducedMotion.matches ? 'instant' : 'smooth' }); row.focus({ preventScroll: true }); }
  clearTimeout(selectedDayTimer); selectedDayTimer = setTimeout(() => { selectedHistoryDate = null; markSelectedHistory(); }, 1200);
}
function renderData(snapshot) {
  const usage = snapshotFacts() ? snapshotFacts().today : null;
  const source = view.ompSource,enabled = node('omp-source-enabled');
  enabled.checked = !!source && source.enabled; enabled.disabled = !source || source.changing;
  text('omp-source-status',source ? t('source'+source.status[0].toUpperCase()+source.status.slice(1)) : t('unknown'));
  text('omp-source-folder',source ? source.folder : '—'); text('omp-source-sessions',source ? number(source.sessions)+' '+t('sourceSessions') : '—');
  node('omp-source-change').disabled = !source || source.changing || !source.canChangeFolder;
  node('omp-source-reset').disabled = !source || source.changing || source.usingDefaultFolder || !source.canChangeFolder;
  text('omp-source-folder-hint',t(source && !source.canChangeFolder ? 'sourceManagedFolder' : 'localOnly'));
  text('today-total', compact(usage ? usage.totalTokens : null)); text('today-cache', usage ? compact(usage.cacheReadTokens) + ' / ' + compact(usage.cacheWriteTokens) : '—'); text('today-failures', number(usage ? usage.failedRequests : null)); text('today-duration', usage ? number(usage.measuredDurationMs / 1000, 1) + ' s' : '—');
  renderCoverage(snapshot); renderResources(snapshot ? snapshot.resources : null);
}
function renderSettingsContent() {
  syncPreferences(); text('settings-title', t(settingsPage === 'data' ? 'localData' : settingsPage));
  if (settingsPage === 'cost' || settingsPage === 'about') renderPublicData(view.snapshot ? view.snapshot.pricing : null);
  else if (settingsPage === 'data') renderData(view.snapshot);
}
function setSettingsPage(page, focus = false) {
  if (!['general', 'orb', 'effects', 'cost', 'data', 'about'].includes(page)) return;
  monitorSelectPicker.close();
  settingsPage = page;
  if (view && view.surface === 'settings' && page === 'general') action(() => bridge.refreshLaunchAtLogin());
  for (const panel of document.querySelectorAll('.settings-page')) panel.hidden = panel.dataset.page !== page;
  for (const button of document.querySelectorAll('.settings-nav [role=tab]')) { const selected = button.dataset.page === page; button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1; }
  text('settings-title', t(page === 'data' ? 'localData' : page)); node('settings-scroller').scrollTop = 0;
  if (focus) node('nav-' + page).focus();
  if (view) renderView();
}
function closePopover(restoreFocus = false) {
  monitorDateRangePicker.close(false);
  for (const element of document.querySelectorAll('.popover')) monitorPopupMotion.hide(element);
  for (const id of ['cost-info', 'metric-info']) node(id).setAttribute('aria-expanded', 'false');
  if (restoreFocus && popoverAnchor) popoverAnchor.focus(); popoverAnchor = null;
}
function openPopover(id, anchor) {
  const popup = node(id), wasOpen = monitorPopupMotion.isOpen(popup); closePopover(); if (wasOpen) return;
  monitorPopupMotion.show(popup); popoverAnchor = anchor; anchor.setAttribute('aria-expanded', 'true');
  const rect = anchor.getBoundingClientRect(),width = popup.offsetWidth,height = popup.offsetHeight,custom = id === 'custom-range-popover',maximum = window.innerWidth-(custom ? 24 : 12)-width;
  const left = custom ? rect.left+(rect.width-width)/2 : rect.left+(id === 'cost-popover' ? -240 : -248);
  popup.style.left = Math.max(Math.min(custom ? 24 : 12,maximum),Math.min(maximum,left))+'px';
  const top = custom ? rect.bottom+8 : rect.top-height-18; popup.style.top = Math.max(12,Math.min(window.innerHeight-height-12,custom || top >= 12 ? top : rect.bottom+6))+'px';
  const first = popup.querySelector('button,input'); if (first) first.focus();
}
function renderView() {
  if (!view || rendererDestroyed) return;
  if (view.surface === 'settings') fillVisualChoices();
  appearance = view.preferences.appearance === 'system' ? systemAppearance.matches ? 'dark' : 'light' : view.preferences.appearance;
  document.body.dataset.surface = view.surface; document.body.dataset.appearance = appearance; document.body.dataset.effects = view.preferences.effects; document.body.dataset.hidden = String(document.hidden); document.documentElement.style.setProperty('--orb-size', view.preferences.size + 'px');
  for (const surface of ['orb', 'dashboard', 'history', 'settings', 'board']) node(surface + '-surface').hidden = view.surface !== surface;
  syncHistoryMotionVisibility();
  renderStatus();
  monitorTitleThemes.render(view,{language,appearance,reducedMotion:reducedMotion.matches,visible:view.surface === 'settings' && settingsPage === 'general' && !document.hidden});
  if (document.hidden) { renderPerfUI(snapshotFacts()); renderBoardUI(snapshotFacts()); renderArt(); return; }
  if (view.surface === 'dashboard') { renderToday(snapshotFacts()); renderChart(liveFacts()); renderAgents(snapshotFacts() ? snapshotFacts().agents : []); }
  else if (view.surface === 'history') { for (const [id, kind] of [['history-profile', 'profile'], ['history-project', 'project']]) fillScope(id, view.scopes[kind === 'profile' ? 'profiles' : 'projects'], view.scope[kind], kind === 'profile' ? 'allProfiles' : 'allProjects'); renderHistory(snapshotFacts()); }
  else if (view.surface === 'settings') renderSettingsContent();
  if (view.surface !== 'history') renderPerfUI(snapshotFacts()); renderBoardUI(snapshotFacts());
  renderArt(); if (view.surface === 'dashboard') requestDashboardResize(); else hideHistoryModeTooltip();
}
function receiveState(next) {
  if (rendererDestroyed) return;
  const initial = !view,changed = initial || next.scope.profile !== view.scope.profile || next.scope.project !== view.scope.project || next.instanceId !== view.instanceId || next.preferences.metric !== view.preferences.metric || next.effectiveRedline !== view.effectiveRedline;
  const animateHero = !initial && !document.hidden && view.surface === 'dashboard' && next.surface === 'dashboard',unitChanged = animateHero && view.preferences.liveUnit !== next.preferences.liveUnit;
  const previousCurrency = view && view.snapshot && view.snapshot.pricing ? view.snapshot.pricing.currency : null,nextCurrency = next.snapshot && next.snapshot.pricing ? next.snapshot.pricing.currency : null,currencyChanged = animateHero && previousCurrency !== null && nextCurrency !== null && previousCurrency !== nextCurrency;
  const canCelebrate = !!view && !changed && !document.hidden && !view.workerError && !view.refreshing && !next.workerError && !next.refreshing && hasLiveSnapshot(view.snapshot) && hasLiveSnapshot(next.snapshot);
  const now = Date.now(), activity = next.activity;
  pendingActivity = {
    responsePulse: !!(canCelebrate && activityBaseline && activity.responseSequence > activityBaseline.responseSequence && activity.lastResponseAt !== null && now - activity.lastResponseAt >= 0 && now - activity.lastResponseAt <= 3000),
    newPeak: !!(canCelebrate && activityBaseline && activity.peakSequence > activityBaseline.peakSequence && activity.lastPeakAt !== null && now - activity.lastPeakAt >= 0 && now - activity.lastPeakAt <= 3000)
  };
  activityBaseline = { responseSequence: activity.responseSequence, peakSequence: activity.peakSequence };
  const languageChanged = language !== next.language; view = next;
  document.body.dataset.nativeFrame = String(next.nativeFrame === true);
  if (next.surface !== 'orb' || !next.orbVisible || next.preferences.clickThrough || document.hidden) {
    if (dragging || dragEnding || orbHovered) cancelLocalDrag(false); else node('orb-surface').dataset.dragging = 'false';
  }
  if (changed) { resetTitleTracker(); selectedHistoryDate = null; chartPoints = []; orbIdleSince = null; clearTimeout(peakBadgeTimer); node('peak-badge').hidden = true; }
  if (languageChanged) { language = next.language; applyLanguage(); }
  if (initial && next.surface === 'settings' && settingsPage === 'general') action(() => bridge.refreshLaunchAtLogin());
  if (!document.hidden) renderView(); else { cancelPreviewInitialization(); trackedTitle(liveValue()); clearTimeout(titleDeadlineTimer); titleDeadlineTimer = null; orbIdleSince = null; pendingActivity = { responsePulse: false, newPeak: false }; syncInteraction(); for (const entry of artInstances.values()) entry.instance.setVisible(false); }
  if (unitChanged) perfAnimate(node('speed-value').parentElement,[{opacity:0,transform:reducedMotion.matches ? 'none' : 'translateY(14px)'},{opacity:1,transform:'none'}],{duration:reducedMotion.matches ? 150 : 300,easing:'cubic-bezier(.3333333333,1,.6666666667,1)'});
  if (currencyChanged) { const frames = [{opacity:.35},{opacity:1}],options = {duration:200,easing:'cubic-bezier(.3333333333,.6666666667,.6666666667,1)'}; perfAnimate(node('today-cost'),frames,options); if (view.preferences.liveUnit === 'cost') perfAnimate(node('speed-value').parentElement,frames,options); }
}
function syncInteraction() {
  if (!bridge || !view || view.surface !== 'orb') return;
  const available = !view.preferences.clickThrough && view.orbVisible && !document.hidden;
  let hit = false;
  if (available && lastPointer) {
    const size = view.preferences.size,dx = lastPointer.x-.75*size,dy = lastPointer.y-.75*size,radius = size*.5*orbHoverScale;
    hit = dx * dx + dy * dy <= radius * radius;
    const plate = node('orb-nameplate');
    if (!hit && !plate.hidden) {
      const rect = plate.getBoundingClientRect(), capRadius = rect.height / 2, x = lastPointer.x, y = lastPointer.y;
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
        const capX = Math.max(rect.left + capRadius, Math.min(rect.right - capRadius, x)), capY = rect.top + capRadius;
        hit = (x - capX) * (x - capX) + (y - capY) * (y - capY) <= capRadius * capRadius;
      }
    }
  }
  const next = available && (!!dragging || dragEnding || hit);
  if (next !== interactive) { interactive = next; bridge.setInteractive(next); }
  if (orbHovered !== hit) { orbHovered = hit; renderArt(); }
}
function cancelLocalDrag(paint = true) {
  // Authoritative native cancellation must never submit a second endDrag.
  const drag = dragging; dragging = null; dragEnding = false; lastPointer = null; orbHovered = false; interactive = null;
  const orb = node('orb-surface'); orb.dataset.dragging = 'false'; orb.dataset.hovered = 'false';
  if (drag && orb.hasPointerCapture(drag.pointerId)) orb.releasePointerCapture(drag.pointerId);
  syncInteraction(); if (paint && view && view.surface === 'orb' && !document.hidden) renderArt();
}
function finishDrag() {
  if (!dragging) return;
  const drag = dragging; dragging = null; node('orb-surface').dataset.dragging = 'false';
  if (node('orb-surface').hasPointerCapture(drag.pointerId)) node('orb-surface').releasePointerCapture(drag.pointerId);
  if (drag.started) {
    dragEnding = true;
    action(() => bridge.endDrag()).finally(() => { dragEnding = false; syncInteraction(); });
  } else syncInteraction();
}
function bindOrb() {
  const orb = node('orb-surface');
  node('orb-art').addEventListener('orb-hover-scale',event => { if (typeof event.detail !== 'number' || !Number.isFinite(event.detail)) return; orbHoverScale = event.detail; if (!view || view.surface !== 'orb') return; const size = view.preferences.size,plate = node('orb-nameplate'),height = parseFloat(plate.style.height)||0,gap = Math.max(4,Math.min(7,Math.round(.034*size))),growth = .5*size*(orbHoverScale-1); plate.style.top = (view.nameplatePlacement === 'above' ? .25*size-growth-gap-height : 1.25*size+growth+gap)+'px'; node('orb-hit').style.transform = 'scale('+orbHoverScale+')'; });
  orb.addEventListener('pointerdown', event => {
    if (!view || view.surface !== 'orb' || !view.orbVisible || view.preferences.clickThrough || dragging || dragEnding || event.button !== 0 || !(event.target.closest('#orb-hit') || event.target.closest('.as-nameplate'))) return;
    dragging = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, started: false }; orb.setPointerCapture(event.pointerId); event.preventDefault();
  });
  orb.addEventListener('pointermove', event => {
    if (!dragging || dragging.pointerId !== event.pointerId || dragging.started) return;
    if (Math.hypot(event.clientX - dragging.x, event.clientY - dragging.y) < 3) return;
    dragging.started = true; orb.dataset.dragging = 'true'; action(() => bridge.beginDrag());
  });
  orb.addEventListener('pointerup', finishDrag); orb.addEventListener('pointercancel', finishDrag); orb.addEventListener('lostpointercapture', finishDrag);
  orb.addEventListener('dblclick', event => { if (view && !view.preferences.clickThrough) { event.preventDefault(); finishDrag(); action(() => bridge.openSurface('dashboard')); } });
  orb.addEventListener('contextmenu', event => { event.preventDefault(); finishDrag(); if (view && !view.preferences.clickThrough) action(() => bridge.showMenu()); });
  orb.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); action(() => bridge.openSurface('dashboard')); }
    else if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) { event.preventDefault(); action(() => bridge.showMenu()); }
  });
}
function bindRadioKeyboard(id) {
  node(id).addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    const buttons = Array.from(node(id).querySelectorAll('button')), index = buttons.indexOf(event.target); if (index < 0) return;
    event.preventDefault(); const columns = getComputedStyle(node(id)).gridTemplateColumns.split(' ').length;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length-1 : event.key === 'ArrowUp' ? Math.max(0,index-columns) : event.key === 'ArrowDown' ? Math.min(buttons.length-1,index+columns) : (index+(event.key === 'ArrowLeft' ? -1 : 1)+buttons.length)%buttons.length;
    buttons[next].focus();
    buttons[next].click();
  });
}
function bindControls() {
  monitorSelectPicker.install();
  monitorDateRangePicker.bind(document,{locale:language === 'zh' ? 'zh-CN' : 'en-US'});
  for (const element of document.querySelectorAll('#close,[data-close]')) element.addEventListener('click',() => action(async () => { await monitorTitleThemes.flush(); await bridge.close(); }));
  for (const element of document.querySelectorAll('#refresh,[data-refresh]')) element.addEventListener('click', () => action(() => bridge.refresh()));
  node('speed-unit').addEventListener('click',() => action(() => bridge.configure({liveUnit:view.preferences.liveUnit === 'cost' ? 'tokens' : 'cost'})));
  for (const element of document.querySelectorAll('[data-open]')) element.addEventListener('click',() => action(async () => { await monitorTitleThemes.flush(); await bridge.openSurface(element.dataset.open); }));
  for (const id of ['source-omp', 'open-history']) node(id).addEventListener('click', () => action(() => bridge.openSurface('history')));
  node('open-settings').addEventListener('click', () => action(() => bridge.openSurface('settings'))); node('close-all').addEventListener('click', () => action(() => bridge.closeAll()));
  node('new-window').addEventListener('click', () => action(() => bridge.newWindow())); node('orb-menu').addEventListener('click', () => action(() => bridge.showMenu()));
  for (const [id, surface] of [['orb-art', 'orb'], ['hero-art', 'dashboard']]) node(id).addEventListener('perf-readout-change', () => {
    if (!rendererDestroyed && !document.hidden && view && view.surface === surface) renderArt();
  });
  node('orb-visible').addEventListener('change',event => action(() => bridge.setOrbVisible(event.target.checked)));
  node('export').addEventListener('click',() => action(async () => { const dates = exportDates(),result = dates ? await bridge.exportCsv(dates) : 'unavailable'; if (result !== 'cancelled') toast(t(result === 'saved' ? 'exportSaved' : result === 'unavailable' ? 'exportUnavailable' : 'exportFailed')); }));
  for (const input of document.querySelectorAll('[data-preference]')) input.addEventListener(input.type === 'range' ? 'input' : 'change', event => {
    const key = input.dataset.preference,value = input.type === 'checkbox' ? input.checked : input.type === 'range' ? key === 'redline' && view.preferences.metric === 'total' ? Math.pow(10,Number(input.value)) : Number(input.value)/(key === 'opacity' ? 100 : 1) : key === 'orbTitleTheme' && input.value === '' ? null : input.value;
    action(() => bridge.configure({ [key]: value }));
  });
  for (const group of document.querySelectorAll('[data-unit-preference]')) group.addEventListener('click',event => { const button = event.target.closest('[data-unit]'); if (button) action(() => bridge.configure({[group.dataset.unitPreference]:button.dataset.unit})); });
  node('orb-advanced').addEventListener('toggle',fitSettingsPresentation);
  node('omp-source-enabled').addEventListener('change',event => action(() => bridge.setSourceEnabled(event.target.checked)));
  node('omp-source-change').addEventListener('click',() => action(() => bridge.chooseSourceFolder()));
  node('omp-source-reset').addEventListener('click',() => action(() => bridge.resetSourceFolder()));
  for (const select of document.querySelectorAll('[data-scope]')) select.addEventListener('change', () => {
    if (!view) return; const scope = { ...view.scope, [select.dataset.scope]: select.value || null }; action(() => bridge.setScope(scope));
  });
  node('size-presets').addEventListener('click', event => { const button = event.target.closest('[data-size]'); if (button) action(() => bridge.configure({ size: Number(button.dataset.size) })); });
  node('network-enabled').addEventListener('change',event => action(() => bridge.setNetworkEnabled(event.target.checked))); node('public-refresh').addEventListener('click',() => action(() => bridge.checkPrices())); node('rates-refresh').addEventListener('click',() => action(() => bridge.refreshRates())); node('auto-sync-prices').addEventListener('change',event => action(() => bridge.setAutoSyncPrices(event.target.checked))); node('currency').addEventListener('change',event => action(() => bridge.setCurrency(event.target.value)));
  for (const button of document.querySelectorAll('.settings-nav [role=tab]')) button.addEventListener('click',() => action(async () => { await monitorTitleThemes.flush(); setSettingsPage(button.dataset.page); }));
  node('launch-at-login').addEventListener('change',event => action(() => bridge.setLaunchAtLogin(event.target.checked)));
  node('effects-preview').addEventListener('click',() => action(() => bridge.startEffectsPreview())); node('effects-preview-stop').addEventListener('click',() => action(() => bridge.stopEffectsPreview()));
  for (const [id,type] of [['orb-duplicate','duplicate'],['orb-remove','remove'],['orb-merge','merge']]) node(id).addEventListener('click',() => action(() => bridge.commandOrb({type,instanceId:view.instanceId})));
  node('orb-undo').addEventListener('click',() => action(() => bridge.commandOrb({type:'undo'})));
  node('settings-scroller').addEventListener('scroll', () => { if (settingsPage === 'orb') renderArt(); }, { passive: true });
  node('orb-reset-position').addEventListener('click',() => action(() => bridge.commandOrb({type:'resetPosition',instanceId:view.instanceId})));
  node('orb-custom-name').addEventListener('change',event => action(() => bridge.configure({orbName:event.target.value || null})));
  node('orb-redline-mode').addEventListener('click',event => { const button = event.target.closest('[data-redline-mode]'); if (button) action(() => bridge.configure({[view.preferences.metric === 'total' ? 'orbRedlineTotal' : 'orbRedlineOutput']:button.dataset.redlineMode === 'global' ? null : view.effectiveRedline})); });
  node('orb-redline').addEventListener('input',event => { const total = view.preferences.metric === 'total'; action(() => bridge.configure({[total ? 'orbRedlineTotal' : 'orbRedlineOutput']:total ? Math.pow(10,Number(event.target.value)) : Number(event.target.value)})); });
  for (const [id,strip] of [['title-ladder','title-heat-strip'],['orb-title-ladder','orb-title-heat-strip']]) for (const eventName of ['pointerover','focusin','pointerout','focusout']) node(id).addEventListener(eventName,event => {
    const row = event.target.closest('[data-level]'); if (!row) return;
    const on = eventName === 'pointerover' || eventName === 'focusin';
    for (const tick of node(strip).children) tick.dataset.highlighted = String(on && tick.dataset.level === row.dataset.level);
  });
  node('orb-list').addEventListener('keydown', event => {
    if (event.target.closest('button')) return;
    const row = event.target.closest('.orb-choice'),choices = Array.from(node('orb-list').children),index = choices.indexOf(row); if (index < 0) return;
    if (event.key === ' ' || event.key === 'Delete' || event.key === 'Backspace' || event.ctrlKey && event.key.toLowerCase() === 'd') {
      event.preventDefault(); const current = view.orbs[index];
      if (event.key === ' ') action(() => bridge.commandOrb({type:'visible',instanceId:current.instanceId,visible:!current.visible}));
      else if (event.ctrlKey) action(() => bridge.commandOrb({type:'duplicate',instanceId:current.instanceId}));
      else action(() => bridge.commandOrb({type:'remove',instanceId:current.instanceId}));
      return;
    }
    if (!['ArrowUp','ArrowDown','Home','End','Enter'].includes(event.key)) return;
    event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length-1 : event.key === 'Enter' ? index : Math.max(0,Math.min(choices.length-1,index+(event.key === 'ArrowUp' ? -1 : 1))); choices[next].focus(); choices[next].click();
  });
  node('agents-toggle').addEventListener('click',() => { agentsExpanded = !agentsExpanded; renderAgents(snapshotFacts() ? snapshotFacts().agents : [],true); });
  node('chart-ranges').addEventListener('click', event => { const button = event.target.closest('[data-seconds]'); if (!button) return; chartSeconds = Number(button.dataset.seconds); for (const element of node('chart-ranges').children) element.setAttribute('aria-pressed', String(element === button)); renderChart(liveFacts()); });
  node('rate-chart').addEventListener('pointermove', event => {
    if (!chartPoints.length || !liveChartBounds) return; const rect = node('rate-chart').getBoundingClientRect(), x = event.clientX - rect.left;
    liveChartHover = Math.max(0,Math.min(1,x/rect.width)); const closest = Math.round(liveChartHover*(chartPoints.length-1)); node('rate-chart').dataset.index = String(closest); showLivePoint(closest);
  });
  node('rate-chart').addEventListener('pointerleave', () => { liveChartHover = null; node('rate-chart-tooltip').hidden = true; node('rate-chart-cursor').hidden = true; });
  node('rate-chart').addEventListener('keydown', event => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || !chartPoints.length) return; liveChartHover = null; event.preventDefault(); const current = Number(node('rate-chart').dataset.index || chartPoints.length - 1), index = Math.max(0, Math.min(chartPoints.length - 1, event.key === 'Home' ? 0 : event.key === 'End' ? chartPoints.length - 1 : current + (event.key === 'ArrowLeft' ? -1 : 1))); node('rate-chart').dataset.index = String(index); showLivePoint(index); });
  node('history-ranges').addEventListener('click', event => {
    const button = event.target.closest('[data-range]'); if (!button) return;
    if (button.dataset.range === 'custom') { const dates = selectedDates(),today = todayDate(),range = view.snapshot && view.snapshot.historyRange,earliest = range && range.startDate || today; node('history-from').min = earliest; node('history-from').max = today; node('history-to').min = earliest; node('history-to').max = today; node('history-from').value = dates.startDate < earliest ? earliest : dates.startDate; node('history-to').value = dates.endDate < earliest ? earliest : dates.endDate; monitorDateRangePicker.render({locale:language === 'zh' ? 'zh-CN' : 'en-US'}); openPopover('custom-range-popover',button); if (monitorPopupMotion.isOpen(node('custom-range-popover'))) monitorDateRangePicker.focus('history-from'); }
    else { historyRange = button.dataset.range; renderHistory(snapshotFacts()); }
  });
  node('history-apply').addEventListener('click', () => {
    const start = node('history-from').value,end = node('history-to').value,today = todayDate(),range = view.snapshot && view.snapshot.historyRange,earliest = range && range.startDate || today;
    if (!parseDate(start) || !parseDate(end) || start > end || start < earliest || end > today) { toast(t('invalidRange')); return; }
    customStart = start; customEnd = end; historyRange = 'custom'; closePopover(true); renderHistory(snapshotFacts());
  });
  node('history-metrics').addEventListener('click', event => { const button = event.target.closest('[data-metric]'); if (button) { historyMetric = button.dataset.metric; renderHistory(snapshotFacts()); } });
  node('history-mode-kind').addEventListener('click',event => { const button = event.target.closest('[data-mode-kind]'); if (!button) return; historyModeKind = button.dataset.modeKind; renderHistoryModes(snapshotFacts(),selectedDates()); });
  node('history-modes-export').addEventListener('click',() => action(async () => { const dates = exportDates(),result = dates ? await bridge.exportModeCsv({...dates,kind:historyModeKind}) : 'unavailable'; if (result !== 'cancelled') toast(t(result === 'saved' ? 'exportSaved' : result === 'unavailable' ? 'exportUnavailable' : 'exportFailed')); }));
  for (const button of document.querySelectorAll('[data-sort]')) button.addEventListener('click',() => { if (historySort === button.dataset.sort) historyDescending = !historyDescending; else { historySort = button.dataset.sort; historyDescending = historySort !== 'models'; } renderHistoryRows(rangeDays(snapshotFacts()).filter(hasUsage)); });
  node('history-chart').addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || !historyChartDays.length) return; event.preventDefault(); const current = historyChartDays.findIndex(day => day.date === selectedHistoryDate), index = Math.max(0, Math.min(historyChartDays.length - 1, event.key === 'Home' ? 0 : event.key === 'End' ? historyChartDays.length - 1 : current + (event.key === 'ArrowLeft' ? -1 : 1))); const day = historyChartDays[index]; selectedHistoryDate = day.date; markSelectedHistory(); showHistoryTooltip(day);
  });
  node('cost-info').addEventListener('click', () => openPopover('cost-popover', node('cost-info'))); node('metric-info').addEventListener('click', () => openPopover('metric-popover', node('metric-info')));
  for (const element of document.querySelectorAll('[data-dismiss]')) element.addEventListener('click', () => closePopover(true));
  document.addEventListener('pointerdown', event => { if (popoverAnchor && !event.target.closest('.popover') && !monitorDateRangePicker.contains(event.target) && !popoverAnchor.contains(event.target)) closePopover(); });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') { if (popoverAnchor) { event.preventDefault(); closePopover(true); } else if (view && view.surface !== 'orb') action(async () => { await monitorTitleThemes.flush(); await bridge.close(); }); }
  });
  bindRadioKeyboard('style-cards');
  const tabs = node('settings-surface').querySelector('[role=tablist]'); tabs.addEventListener('keydown',event => { if (!['ArrowUp','ArrowDown','Home','End'].includes(event.key)) return; const buttons = Array.from(tabs.querySelectorAll('[role=tab]')), index = buttons.indexOf(event.target); if (index < 0) return; event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length-1 : (index+(event.key === 'ArrowUp' ? -1 : 1)+buttons.length)%buttons.length; action(async () => { await monitorTitleThemes.flush(); setSettingsPage(buttons[next].dataset.page,true); }); });
  bindOrb();
}
function renderBrandGlyphs() {
  for (const host of document.querySelectorAll('.brand-gauge,.about-brand>.symbol')) {
    const about = !!host.closest('.about-brand'),size = about ? 40 : 24,heat = about ? .78 : .62,stroke = Math.max(1.5,size/9),radius = (size-stroke)/2,cx = size/2,cy = size/2+radius*.1464;
    const arc = sweep => { const a = 135*Math.PI/180,b = (135+sweep)*Math.PI/180; return 'M '+(cx+radius*Math.cos(a))+' '+(cy+radius*Math.sin(a))+' A '+radius+' '+radius+' 0 '+(sweep > 180 ? 1 : 0)+' 1 '+(cx+radius*Math.cos(b))+' '+(cy+radius*Math.sin(b)); };
    const svg = svgElement('svg',{width:size,height:size,viewBox:'0 0 '+size+' '+size,'aria-hidden':true});
    svg.append(svgElement('path',{d:arc(270),fill:'none',stroke:'var(--text)','stroke-opacity':.45,'stroke-width':stroke,'stroke-linecap':'round'}),svgElement('path',{d:arc(270*heat),fill:'none',stroke:agentSpeedVisuals.color(heat,'dark'),'stroke-width':stroke,'stroke-linecap':'round'})); host.replaceChildren(svg);
  }
}
function startMonitor() {
  applyLanguage(); text('about-attribution', monitorAttribution); text('about-license', monitorLicense); setSettingsPage('general');
  renderBrandGlyphs();
  if (!bridge) { toast(t('bridgeError')); return; }
  bindControls();
  monitorTitleThemes.bind({host:node('title-themes-slot'),bridge,visuals:agentSpeedVisuals,onDraft:() => { if (view) { ladderOptions = null; renderView(); } }});
  const nativeCloseDraftLock = createTitleDraftCloseLock(node('settings-surface'),() => monitorTitleThemes.flush());
  Object.defineProperties(window,{
    ompMonitorFlushTitleDrafts:{value:nativeCloseDraftLock.flush,writable:false,configurable:false},
    ompMonitorReleaseTitleDraftLock:{value:nativeCloseDraftLock.release,writable:false,configurable:false}
  });
  bindPerfUI(); bindBoardUI(); bindHistoryMotion(); unsubscribe = bridge.onState(receiveState);
  if (typeof ResizeObserver === 'function') { settingsLayoutObserver = new ResizeObserver(fitSettingsPresentation); settingsLayoutObserver.observe(node('page-general')); }
  if (typeof ResizeObserver === 'function') { dashboardObserver = new ResizeObserver(requestDashboardResize); const content = node('dashboard-surface').querySelector('.dashboard-scroll'); dashboardObserver.observe(content); for (const child of content.children) dashboardObserver.observe(child); }
  if (document.fonts && typeof document.fonts.addEventListener === 'function') document.fonts.addEventListener('loadingdone',() => { settingsMeasurement = null; fitSettingsPresentation(); });
  unsubscribePointer = bridge.onPointer(pointer => { lastPointer = pointer; syncInteraction(); });
  unsubscribeDrag = bridge.onDragCancelled(() => cancelLocalDrag());
  window.addEventListener('focus',() => { if (view && view.surface === 'settings' && settingsPage === 'general') action(() => bridge.refreshLaunchAtLogin()); });
  bridge.ready().then(receiveState).catch(() => { if (!rendererDestroyed) toast(t('bridgeError')); });
  document.addEventListener('visibilitychange', () => { if (rendererDestroyed) return; document.body.dataset.hidden = String(document.hidden); if (document.hidden) { cancelPreviewInitialization(); cancelLocalDrag(false); clearTimeout(titleDeadlineTimer); titleDeadlineTimer = null; orbIdleSince = null; pendingActivity = { responsePulse: false, newPeak: false }; for (const entry of artInstances.values()) entry.instance.setVisible(false); } else renderView(); });
  systemAppearance.addEventListener('change', renderView); reducedMotion.addEventListener('change', renderView); window.addEventListener('blur',() => { finishDrag(); closePopover(); });
  window.addEventListener('resize', () => { closePopover(); renderView(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { syncHistoryMotionVisibility(); closePopover(); renderPerfUI(snapshotFacts()); renderBoardUI(snapshotFacts()); } });
  window.addEventListener('pagehide', () => { if (rendererDestroyed) return; rendererDestroyed = true; cancelPreviewInitialization(); cancelLocalDrag(false); if (unsubscribe) unsubscribe(); if (unsubscribePointer) unsubscribePointer(); if (unsubscribeDrag) unsubscribeDrag(); clearTimeout(toastTimer); clearTimeout(selectedDayTimer); clearTimeout(peakBadgeTimer); clearTimeout(titleDeadlineTimer); for (const entry of artInstances.values()) entry.instance.destroy(); agentSpeedVisuals.disposeSharedGpu(); artInstances.clear(); orbRows.clear(); systemAppearance.removeEventListener('change', renderView); reducedMotion.removeEventListener('change', renderView); });
  window.addEventListener('pagehide',() => { clearTimeout(effectsDemoTimer); effectsDemoTimer = null; });
  window.addEventListener('pagehide',() => { if (dashboardObserver) dashboardObserver.disconnect(); if (dashboardResizeRaf) cancelAnimationFrame(dashboardResizeRaf); if (dashboardDisclosure.frame) cancelAnimationFrame(dashboardDisclosure.frame); dashboardResizePending = null; });
  window.addEventListener('pagehide',() => { if (historyModeTooltip) historyModeTooltip.remove(); });
  window.addEventListener('pagehide',() => { if (settingsLayoutObserver) settingsLayoutObserver.disconnect(); settingsLayoutObserver = null; settingsMeasurement = null; });
  window.addEventListener('pagehide',() => monitorTitleThemes.destroy());
  window.addEventListener('pagehide',() => { monitorDateRangePicker.destroy(); destroyHistoryMotion(); });
  window.addEventListener('pagehide', () => { destroyPerfUI(); destroyBoardUI(); });
  window.addEventListener('pagehide',() => monitorPopupMotion.destroy());
}
`;
