import { MONITOR_UI_STRINGS } from "./ui-strings.js";

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
const moneyFormatters = new Map();
const orbRows = new Map();
const scopeOptions = new Map();
const titleThresholds = [0, .5, .02, .03, .04, .06, .08, .12, .17, .24, .34, .5, .7, 1];
let view = null, language = 'en', appearance = 'light', settingsPage = 'general';
let formatters = {}, timeFormatters = {}, currencyNames = null;
let unsubscribe = null, unsubscribePointer = null, unsubscribeDrag = null, toastTimer = null, selectedDayTimer = null, peakBadgeTimer = null, titleDeadlineTimer = null;
let chartSeconds = 120, agentsExpanded = false, historyRange = '30', historyMetric = 'output';
let customStart = null, customEnd = null, historySort = 'date', historyDescending = true;
let selectedHistoryDate = null, chartPoints = [], historyChartDays = [], liveChartBounds = null;
let popoverAnchor = null, dragging = null, dragEnding = false, orbHovered = false, lastPointer = null, interactive = null, orbIdleSince = null;
let titleTracker = { level: 0, candidate: 0, pending: null, pendingSince: 0, belowFirstSince: null }, orbRowSerial = 0;
let activityBaseline = null, pendingActivity = { responsePulse: false, newPeak: false };
let ladderOptions = null, currencyOptions = null;
let previewInitialization = null, previewsReady = false, rendererDestroyed = false;
function node(id) { return document.getElementById(id); }
function t(key) { return monitorStrings[language][key] || monitorStrings.en[key] || key; }
function text(id, value) { const element = node(id), next = String(value); if (element.textContent !== next) element.textContent = next; }
function finite(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null; }
function number(value, digits = 0) { const n = finite(value); return n === null ? '—' : formatters[digits].format(n); }
function compact(value) {
  const n = finite(value); if (n === null) return '—';
  if (n >= 1e9) return number(n / 1e9, n < 1e10 ? 2 : 1) + 'B';
  if (n >= 1e6) return number(n / 1e6, n < 1e7 ? 2 : 1) + 'M';
  if (n >= 1000) return number(n / 1000, n < 10000 ? 2 : 1) + 'k';
  return number(n, n > 0 && n < 10 ? 1 : 0);
}
function speed(value, unit = false) {
  const n = finite(value); if (n === null || n < .05) return '–';
  return compact(n) + (unit ? ' tok/s' : '');
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
  const n = finite(value); if (n === null) return '—';
  let formatter = moneyFormatters.get(currency);
  if (!formatter) { formatter = new Intl.NumberFormat(language === 'zh' ? 'zh-CN' : 'en-US', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 4 }); moneyFormatters.set(currency, formatter); }
  return formatter.format(n);
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
function liveFacts() { const snapshot = snapshotFacts(); return snapshot && !view.workerError && !view.refreshing && hasLiveSnapshot(snapshot) ? snapshot : null; }
function currentStatus() { return view && view.workerError ? 'error' : !view || view.refreshing ? 'scanning' : view.snapshot ? view.snapshot.status : 'scanning'; }
function liveValue() { const snapshot = liveFacts(); return snapshot ? snapshot.rate.measuredTps + snapshot.rate.estimatedTps : null; }
function liveEstimated() { const snapshot = liveFacts(); return !!snapshot && snapshot.rate.estimatedTps > 0; }
function liveReadout(value, unit = false) { return value === null ? '—' : (liveEstimated() ? '≈' : '') + (value < .05 ? '0' : compact(value)) + (unit ? ' tok/s' : ''); }
function orbName() { return !view ? 'OMP' : view.scope.project || (view.scope.profile ? 'OMP · ' + view.scope.profile : 'OMP'); }
function applyLanguage() {
  document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
  const locale = language === 'zh' ? 'zh-CN' : 'en-US';
  formatters = { 0: new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }), 1: new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }), 2: new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }) };
  timeFormatters = { time: new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' }), full: new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'medium' }), date: new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric' }), weekday: new Intl.DateTimeFormat(locale, { weekday: 'short' }), shortDate: new Intl.DateTimeFormat(locale, { month: 'numeric', day: 'numeric' }) };
  currencyNames = typeof Intl.DisplayNames === 'function' ? new Intl.DisplayNames([locale], { type: 'currency' }) : null;
  moneyFormatters.clear();
  for (const element of document.querySelectorAll('[data-i18n]')) element.textContent = t(element.dataset.i18n);
  for (const element of document.querySelectorAll('[data-i18n-label]')) element.setAttribute('aria-label', t(element.dataset.i18nLabel));
  for (const element of document.querySelectorAll('[data-i18n-title]')) element.title = t(element.dataset.i18nTitle);
  fillVisualChoices();
}
function toast(message) {
  clearTimeout(toastTimer); text('toast', message);
  toastTimer = setTimeout(() => { text('toast', ''); toastTimer = null; }, 4200);
}
async function action(work) { try { return await work(); } catch { renderView(); toast(t('actionFailed')); return undefined; } }
function fillVisualChoices() {
  const titleSelect = node('title-theme'), titleOptions = document.createDocumentFragment();
  for (const [id, theme] of Object.entries(agentSpeedVisuals.themes)) {
    const option = document.createElement('option'); option.value = id; option.textContent = theme.name[language === 'zh' ? 0 : 1]; titleOptions.append(option);
    let card = node('theme-' + id);
    if (!card) {
      card = document.createElement('button'); card.id = 'theme-' + id; card.type = 'button'; card.className = 'theme-card'; card.dataset.theme = id; card.setAttribute('role', 'radio');
      card.append(document.createElement('strong')); const strip = document.createElement('span'); strip.className = 'preview-strip'; card.append(strip); node('theme-cards').append(card);
      card.addEventListener('click', () => action(() => bridge.configure({ titleTheme: id })));
    }
    card.firstChild.textContent = theme.name[language === 'zh' ? 0 : 1];
    const labels = theme[language], indices = [1, 5, 9, 13]; card.lastChild.textContent = indices.map(index => labels[index]).join(' · '); card.title = labels.slice(1).join(' · ');
    card.setAttribute('aria-label', theme.name[language === 'zh' ? 0 : 1] + ': ' + card.lastChild.textContent);
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
  for (const input of document.querySelectorAll('[data-preference]')) {
    const key = input.dataset.preference;
    if (input.type === 'checkbox') input.checked = preferences[key];
    else if (document.activeElement !== input) input.value = String(key === 'opacity' ? Math.round(preferences.opacity * 100) : preferences[key]);
  }
  node('orb-size').min = preferences.style === 'minimal' ? '64' : '96';
  for (const id of ['orb-visible', 'settings-orb-visible']) node(id).checked = view.orbVisible;
  node('preference-error').hidden = !view.preferenceError;
  text('redline-value', number(preferences.redline) + ' tok/s'); text('orb-size-value', number(preferences.size) + ' DIP'); text('opacity-value', number(preferences.opacity * 100) + '%');
  for (const button of node('size-presets').querySelectorAll('button')) button.setAttribute('aria-pressed', String(Number(button.dataset.size) === preferences.size));
  for (const button of node('theme-cards').children) { const selected = button.dataset.theme === preferences.titleTheme; button.setAttribute('aria-checked', String(selected)); button.tabIndex = selected ? 0 : -1; }
  for (const button of node('style-cards').children) { const selected = button.dataset.style === preferences.style; button.setAttribute('aria-checked', String(selected)); button.tabIndex = selected ? 0 : -1; }
  text('style-description', t('style_' + preferences.style));
  text('window-count', number(view.windowCount) + ' / ' + number(view.maxWindows));
  node('new-window').disabled = view.windowCount >= view.maxWindows;
  text('settings-orb-name', orbName()); text('settings-orb-detail', agentSpeedVisuals.styles[preferences.style][language === 'zh' ? 0 : 1] + ' · ' + number(preferences.size) + ' DIP');
  renderOrbList();
  if (settingsPage === 'orb') for (const [id, kind] of [['profile', 'profile'], ['project', 'project']]) fillScope(id, view.scopes[kind === 'profile' ? 'profiles' : 'projects'], view.scope[kind], kind === 'profile' ? 'allProfiles' : 'allProjects');
  if (!ladderOptions || ladderOptions.theme !== preferences.titleTheme || ladderOptions.redline !== preferences.redline || ladderOptions.language !== language || ladderOptions.appearance !== appearance) {
    const theme = agentSpeedVisuals.themes[preferences.titleTheme], labels = theme[language], strip = document.createDocumentFragment(), ladder = document.createDocumentFragment();
    for (let level = 1; level <= 13; level++) {
      const threshold = level === 1 ? .5 : titleThresholds[level] * preferences.redline;
      const tick = document.createElement('i'); tick.style.left = Math.min(1, Math.pow(threshold / preferences.redline, .6)) * 100 + '%'; strip.append(tick);
      const row = document.createElement('span'); row.append(document.createTextNode(labels[level])); const value = document.createElement('strong'); value.textContent = compact(threshold); value.style.color = agentSpeedVisuals.color(agentSpeedVisuals.heat(threshold, preferences.redline), appearance); row.append(value); ladder.append(row);
    }
    node('title-heat-strip').replaceChildren(strip); node('title-ladder').replaceChildren(ladder);
    ladderOptions = { theme: preferences.titleTheme, redline: preferences.redline, language, appearance };
  }
  node('reduced-motion-note').hidden = !reducedMotion.matches;
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
      const row = document.createElement('button'); row.type = 'button'; row.className = 'orb-choice orb-identity'; row.id = 'orb-choice-' + (++orbRowSerial); row.setAttribute('role', 'option');
      const holder = document.createElement('span'); holder.className = 'orb-preview-small';
      const preview = document.createElement('span'); preview.id = row.id + '-preview'; preview.className = 'orb-list-art'; preview.setAttribute('aria-hidden', 'true'); holder.append(preview);
      const copy = document.createElement('span'); copy.className = 'identity-text'; const name = document.createElement('strong'), detail = document.createElement('small'); copy.append(name, detail);
      const rate = document.createElement('span'); rate.className = 'orb-count';
      const indicators = document.createElement('span'); indicators.className = 'symbol orb-choice-indicators'; indicators.setAttribute('aria-hidden', 'true');
      row.append(holder, copy, rate, indicators);
      row.addEventListener('click', () => { if (view && view.surface === 'settings') action(() => bridge.selectOrb(summary.instanceId)); });
      entry = { row, preview, name, detail, rate, indicators }; orbRows.set(summary.instanceId, entry);
    }
    const name = summary.scope.project || (summary.scope.profile ? 'OMP · ' + summary.scope.profile : 'OMP');
    const status = [t(summary.visible ? 'visibleOrb' : 'hiddenOrb')]; if (summary.clickThrough) status.push(t('clickThrough')); if (summary.pinned) status.push(t('pin'));
    entry.name.textContent = name; entry.detail.textContent = agentSpeedVisuals.styles[summary.style][language === 'zh' ? 0 : 1] + ' · ' + number(summary.size) + ' DIP';
    entry.rate.textContent = !summary.visible ? t('hiddenOrb') : selected ? liveReadout(liveValue(), true) : '—';
    entry.indicators.textContent = (summary.pinned ? '\uE718 ' : '') + (summary.clickThrough ? '\uE7C9 ' : '') + (summary.visible ? '\uE890' : '\uED1A');
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
  const preferences = view.preferences, now = performance.now(), raw = agentSpeedVisuals.title(value, preferences.titleTheme, language, preferences.redline).level;
  if (value < .5) { if (titleTracker.belowFirstSince === null) titleTracker.belowFirstSince = now; }
  else titleTracker.belowFirstSince = null;
  let candidate;
  if (value < .5) candidate = now - titleTracker.belowFirstSince + 1e-6 >= 3000 || titleTracker.candidate === 0 ? 0 : 1;
  else if (raw >= titleTracker.candidate) candidate = raw;
  else {
    candidate = 1;
    for (let level = titleTracker.candidate; level > 1; level--) {
      if (value >= titleThresholds[level] * preferences.redline * .9) { candidate = level; break; }
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
  const theme = agentSpeedVisuals.themes[preferences.titleTheme]; return { label: theme[language][titleTracker.level], level: titleTracker.level };
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
  const entry = ensureArt(id, embedded, thumbnail, sharedGpu); entry.instance.setVisible(visible); entry.visible = visible; if (visible) entry.instance.update(frame);
}
function renderArt() {
  if (!view || rendererDestroyed) return;
  const preferences = view.preferences, facts = liveFacts(), value = liveValue(), title = trackedTitle(value);
  const agents = facts ? facts.agents : [], active = agents.filter(agent => agent.phase === 'generating').length, tools = agents.filter(agent => agent.phase === 'tools').length;
  if (value === null || value >= .05) orbIdleSince = null;
  else if (orbIdleSince === null) orbIdleSince = performance.now();
  const faded = preferences.fadeWhenIdle && orbIdleSince !== null && performance.now() - orbIdleSince >= 60000 && !orbHovered;
  const dimmed = (value === null ? .55 : 1) * (faded ? .45 : 1);
  const base = { value, formattedValue: liveReadout(value), unit: 'tok/s', title: title.label, style: preferences.style, titleTheme: preferences.titleTheme, language, redline: preferences.redline, appearance, effects: preferences.effects, reduceMotion: reducedMotion.matches, maxFps: view.maxFps, size: preferences.size, opacity: preferences.opacity * dimmed, hovered: view.surface === 'orb' && orbHovered, activeAgents: active, toolsAgents: tools, responsePulse: pendingActivity.responsePulse, newPeak: pendingActivity.newPeak, hoverLabel: orbName() + ' · ' + (value === null ? t('unknown') : liveReadout(value, true) + (liveEstimated() ? ' (' + t('estimated') + ')' : '')) };
  const visible = !document.hidden;
  updateArt('orb-art', false, base, visible && view.surface === 'orb' && view.orbVisible);
  updateArt('hero-art', true, { ...base, size: 112, opacity: 1, hovered: false }, visible && view.surface === 'dashboard');
  const previewPageVisible = visible && view.surface === 'settings' && settingsPage === 'orb';
  if (previewPageVisible) initializePreviewsAfterPaint(); else cancelPreviewInitialization();
  const previewsVisible = previewPageVisible && previewsReady;
  for (const summary of view.orbs) {
    const row = orbRows.get(summary.instanceId); if (!row) continue;
    const selected = summary.instanceId === view.instanceId;
    updateArt(row.preview.id, false, { ...base, value: selected ? value : null, formattedValue: selected ? base.formattedValue : '—', title: selected ? title.label : t('unknown'), style: summary.style, size: 38, opacity: 1, effects: 'off', reduceMotion: true, hovered: false, activeAgents: selected ? active : 0, toolsAgents: selected ? tools : 0, responsePulse: false, newPeak: false }, previewsVisible && previewOnScreen(row.preview.id), true);
  }
  for (const style of Object.keys(agentSpeedVisuals.styles)) updateArt('preview-' + style, false, { ...base, style, size: 64, opacity: 1, effects: 'off', reduceMotion: true, hovered: false, responsePulse: false, newPeak: false }, previewsVisible && previewOnScreen('preview-' + style), false, true);
  if (pendingActivity.newPeak && preferences.effects !== 'off' && view.surface === 'dashboard') { node('peak-badge').hidden = false; clearTimeout(peakBadgeTimer); peakBadgeTimer = setTimeout(() => { node('peak-badge').hidden = true; }, 1800); }
  pendingActivity = { responsePulse: false, newPeak: false };
  text('speed-value', liveReadout(value)); text('speed-title', title.label);
  node('hero').style.setProperty('--heat', agentSpeedVisuals.color(value === null ? 0 : agentSpeedVisuals.heat(value, preferences.redline), appearance));
  text('hero-context', facts ? (liveEstimated() ? t('estimated') + ' · ' : '') + t('generating') + ' ' + number(active) + ' · ' + t('tools') + ' ' + number(tools) : view.workerError ? t('stale') : t('status_' + currentStatus()));
  node('hero').setAttribute('aria-label', t('liveChart') + ': ' + (value === null ? t('unknown') : liveReadout(value, true) + (liveEstimated() ? ', ' + t('estimated') : '')) + ', ' + title.label);
  const orb = node('orb-surface'); orb.dataset.clickThrough = String(preferences.clickThrough); orb.dataset.hovered = String(base.hovered); orb.setAttribute('aria-label', base.hoverLabel + ', ' + title.label); orb.title = base.hoverLabel;
  text('orb-name', orbName()); const plate = node('orb-nameplate'); plate.hidden = preferences.size < 80 || preferences.nameMode === 'never' || (preferences.nameMode === 'auto' && view.windowCount < 2 && !view.scope.profile && !view.scope.project);
  const font = Math.max(9, Math.min(12, Math.round(preferences.size * .066 * 2) / 2)), height = Math.round(1.78 * font), gap = Math.max(4, Math.min(7, Math.round(.034 * preferences.size))), dot = Math.max(5, .6 * font);
  if (view.nameplateMaxWidth < height + dot + .42 * font) plate.hidden = true;
  plate.dataset.unavailable = String(value === null); plate.dataset.cjk = String(/[\u3400-\u9fff]/.test(orbName())); plate.style.fontSize = font + 'px'; plate.style.height = height + 'px'; plate.style.borderRadius = height / 2 + 'px'; plate.style.gap = .42 * font + 'px';
  plate.style.paddingLeft = height / 2 - dot / 2 + 'px'; plate.style.paddingRight = .52 * height + 'px'; plate.style.maxWidth = Math.max(0, Math.min(1.5 * preferences.size - 6, view.nameplateMaxWidth)) + 'px';
  plate.style.top = (view.nameplatePlacement === 'above' ? .25 * preferences.size - gap - height : 1.25 * preferences.size + gap) + 'px'; plate.style.opacity = String(preferences.opacity * dimmed);
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
  for (const id of ['orb-visible', 'settings-orb-visible']) node(id).checked = view.orbVisible;
  for (const element of document.querySelectorAll('#refresh,[data-refresh]')) { element.setAttribute('aria-busy', String(view.refreshing)); element.disabled = view.refreshing; }
  node('export').disabled = !snapshotFacts();
  document.title = 'OMP · ' + t(view.surface === 'orb' ? 'orb' : view.surface);
}
function renderToday(snapshot) {
  const usage = snapshot ? snapshot.today : null, live = liveFacts(), value = liveValue();
  text('today-input', compact(usage ? usage.inputTokens : null)); text('today-output', compact(usage ? usage.outputTokens : null)); text('today-requests', compact(usage ? usage.requests : null)); text('today-average', compact(average(usage)));
  for (const [id, key] of [['today-input', 'inputTokens'], ['today-output', 'outputTokens'], ['today-requests', 'requests']]) node(id).title = number(usage ? usage[key] : null);
  const peakAt = snapshot && usage && usage.peakOutputTps > 0 ? finite(snapshot.activity.peakAt) : null;
  const provenance = peakAt !== null ? t('peakMeasurement') + ' ' + timestamp(peakAt, true) : t('peakTimeUnknown');
  text('session-peak', usage ? speed(usage.peakOutputTps, true) : '—'); text('peak-time', peakAt !== null ? timestamp(peakAt) : '—'); node('session-peak').title = provenance; node('peak-time').title = provenance; text('peak-provenance', provenance);
  text('today-cost', costText(usage, 'recorded')); node('today-cost').title = t('recordedCost') + ' · ' + costText(usage, 'recorded', false);
  text('recorded-usd', costText(usage, 'recorded', false)); text('catalog-cost', costText(usage, 'catalog', false));
  text('today-unpriced', usage ? number(usage.unpricedRequests) + ' ' + t('unpriced') : t('unknown'));
  text('catalog-note', (usage ? number(usage.unestimatedRequests) + ' ' + t('unestimated') + ' · ' : '') + t('catalogNote'));
  text('measured-speed', number(live ? live.rate.measuredTps : null, 1)); text('estimated-speed', number(live ? live.rate.estimatedTps : null, 1)); text('estimated-fraction', percent(live ? live.rate.estimatedShare : null));
  node('estimate-legend').hidden = !live || live.rate.estimatedTps <= 0;
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
  const peak = snapshot ? finite(snapshot.today.peakOutputTps) : null;
  let dataMax = 0;
  for (const point of chartPoints) dataMax = Math.max(dataMax, point.measuredTps + point.estimatedTps);
  // Frozen ChartMath.ComputeScale/NiceCeiling: do not flatten live data under an unrelated old daily peak.
  const peakInRange = peak !== null && peak > 0 && peak <= Math.max(dataMax * 2.5, 20);
  const target = Math.max(10, dataMax * 1.15, peakInRange ? peak * 1.08 : 0), magnitude = Math.pow(10, Math.floor(Math.log10(target))), fraction = target / magnitude;
  const maximum = (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10) * magnitude;
  const chartTop = 8, chartBottom = 76, width = 286;
  liveChartBounds = { start, end, maximum, left: 0, right: width, top: chartTop, bottom: chartBottom };
  const gradient = document.createDocumentFragment();
  for (let index = 0; index <= 16; index++) gradient.append(svgElement('stop', { offset: index / 16, 'stop-color': agentSpeedVisuals.color(agentSpeedVisuals.heat(maximum * index / 16, view.preferences.redline), appearance) }));
  node('rate-line-gradient').replaceChildren(gradient);
  for (let index = 0; index < 3; index++) {
    const y = chartTop + (chartBottom - chartTop) * index / 2;
    fragment.append(svgElement('line', { x1: 0, x2: width, y1: y, y2: y, class: 'chart-grid' }));
    fragment.append(svgElement('text', { x: 328, y: y + 3, 'text-anchor': 'end', class: 'chart-label' }, compact(maximum * (1 - index / 2))));
  }
  const measured = [], total = [];
  for (const point of chartPoints) {
    const x = (point.timestamp - start) / (end - start) * width;
    measured.push([x, chartBottom - Math.min(maximum, point.measuredTps) / maximum * (chartBottom - chartTop)]);
    total.push([x, chartBottom - Math.min(maximum, point.measuredTps + point.estimatedTps) / maximum * (chartBottom - chartTop)]);
  }
  if (measured.length) {
    const path = smoothPath(measured), first = measured[0], last = measured[measured.length - 1];
    node('rate-area-color').setAttribute('stop-color', agentSpeedVisuals.color(agentSpeedVisuals.heat(maximum, view.preferences.redline), appearance));
    fragment.append(svgElement('path', { d: path + ' L ' + last[0].toFixed(2) + ' ' + chartBottom + ' L ' + first[0].toFixed(2) + ' ' + chartBottom + ' Z', fill: 'url(#rate-area-gradient)' }));
    fragment.append(svgElement('path', { d: path, class: 'chart-measured', stroke: 'url(#rate-line-gradient)' }));
    const estimatedSegment = [];
    for (let index = 0; index < chartPoints.length; index++) {
      const point = chartPoints[index];
      estimatedSegment.push(point.estimatedTps > 0 || index > 0 && chartPoints[index - 1].estimatedTps > 0 ? total[index] : null);
    }
    fragment.append(svgElement('path', { d: smoothPath(estimatedSegment), class: 'chart-estimated', stroke: 'url(#rate-line-gradient)' }));
    if (chartPoints.some(point => point.estimatedTps > 0)) {
      const upper = smoothPath(total), reverse = smoothPath(measured.slice().reverse()).replace(/^ M /, ' L ');
      fragment.append(svgElement('path', { d: upper + reverse + ' Z', fill: 'url(#rate-area-gradient)', opacity: .45 }));
    }
    const endpoint = total[total.length - 1]; fragment.append(svgElement('circle', { cx: endpoint[0], cy: endpoint[1], r: 2, fill: agentSpeedVisuals.color(agentSpeedVisuals.heat(chartPoints[chartPoints.length - 1].measuredTps + chartPoints[chartPoints.length - 1].estimatedTps, view.preferences.redline), appearance) }));
  }
  if (peakInRange && peak <= maximum) {
    const y = chartBottom - Math.min(maximum, peak) / maximum * (chartBottom - chartTop);
    fragment.append(svgElement('line', { x1: 0, x2: width, y1: y, y2: y, class: 'chart-peak' })); fragment.append(svgElement('text', { x: 3, y: Math.max(8, y - 4), class: 'chart-peak-label' }, t('peak') + ' ' + compact(peak)));
  }
  for (const [x, label, anchor] of [[0, number(chartSeconds / 60, chartSeconds === 60 || chartSeconds === 120 || chartSeconds === 300 ? 0 : 1) + ' ' + t('minutesAgo'), 'start'], [width, t('now'), 'end']]) fragment.append(svgElement('text', { x, y: 93, 'text-anchor': anchor, class: 'chart-axis' }, label));
  root.replaceChildren(fragment); node('rate-chart-tooltip').hidden = true; node('rate-chart-cursor').hidden = true;
}
function showLivePoint(index, clientX = null) {
  if (!chartPoints.length || !liveChartBounds) return;
  const point = chartPoints[Math.max(0, Math.min(chartPoints.length - 1, index))], bounds = liveChartBounds;
  const x = (point.timestamp - bounds.start) / (bounds.end - bounds.start) * bounds.right;
  node('rate-chart-cursor').replaceChildren(svgElement('line', { x1: x, x2: x, y1: bounds.top, y2: bounds.bottom, class: 'chart-crosshair' })); node('rate-chart-cursor').hidden = false;
  const tooltip = node('rate-chart-tooltip'); tooltip.textContent = timestamp(point.timestamp) + '\n' + t('measured') + ': ' + number(point.measuredTps, 1) + ' tok/s · ' + t('estimated') + ': ' + number(point.estimatedTps, 1) + ' tok/s'; tooltip.hidden = false;
  const width = node('rate-chart').getBoundingClientRect().width; tooltip.style.left = Math.min(width - tooltip.offsetWidth, Math.max(0, clientX === null ? x : clientX)) + 'px'; tooltip.style.top = '-38px';
}
function renderAgents(agents) {
  const byId = new Map(agents.map(agent => [agent.id, agent])), children = new Map(), roots = [], visited = new Set(), ordered = [];
  const phaseOrder = { generating: 0, tools: 1, idle: 2 };
  const compare = (left, right) => phaseOrder[left.phase] - phaseOrder[right.phase] || (right.outputTps || 0) - (left.outputTps || 0) || right.lastActivityAt - left.lastActivityAt || left.id.localeCompare(right.id);
  for (const agent of agents) {
    if (agent.parentId && agent.parentId !== agent.id && byId.has(agent.parentId)) { const list = children.get(agent.parentId) || []; list.push(agent); children.set(agent.parentId, list); }
    else roots.push(agent);
  }
  function visit(agent, depth) { if (visited.has(agent.id)) return; visited.add(agent.id); ordered.push({ agent, depth }); for (const child of (children.get(agent.id) || []).sort(compare)) visit(child, depth + 1); }
  for (const root of roots.sort(compare)) visit(root, 0);
  for (const agent of agents.slice().sort(compare)) if (!visited.has(agent.id)) visit(agent, 0);
  const shown = agentsExpanded ? ordered : ordered.slice(0, 6), fragment = document.createDocumentFragment();
  for (const { agent, depth } of shown) {
    const row = document.createElement('div'); row.className = 'agent-row'; row.dataset.child = String(depth > 0); row.style.setProperty('--indent', Math.min(depth, 8) * 12 + 'px');
    const copy = document.createElement('div'); copy.className = 'agent-copy'; const project = document.createElement('strong'); project.className = 'agent-project'; project.textContent = agent.project || agent.name || agent.id;
    const detail = document.createElement('span'); detail.className = 'agent-detail'; detail.textContent = (agent.kind === 'advisor' ? language === 'zh' ? '顾问 · ' : 'Advisor · ' : '') + 'OMP · ' + (agent.model || t('unknown')); copy.append(project, detail);
    const phase = document.createElement('span'); phase.className = 'agent-phase'; phase.title = t(agent.phase); phase.setAttribute('aria-label', t(agent.phase));
    if (agent.phase === 'generating') { phase.classList.add('phase-generating'); for (let dot = 0; dot < 3; dot++) phase.append(document.createElement('i')); }
    else if (agent.phase === 'tools') { phase.classList.add('symbol'); phase.textContent = '\uE90F'; }
    else phase.classList.add('phase-idle');
    const rate = document.createElement('span'); rate.className = 'agent-speed';
    const reference = agent.phase === 'generating' ? finite(agent.outputTps) : null;
    rate.dataset.muted = String(reference === null || reference < .05); rate.dataset.phase = agent.phase; rate.textContent = reference !== null && reference >= .05 ? '≈' + speed(reference) : '–'; rate.setAttribute('aria-label', reference !== null && reference >= .05 ? t('average') + ': ' + number(reference, 1) + ' tok/s' : t(agent.phase));
    if (agent.phase === 'tools') {
      // Original Windows Dashboard/LiveValue.cs: 11 DIP outlined hourglass and settled sand.
      const hourglass = svgElement('svg', { viewBox: '0 0 11 11', width: 11, height: 11, class: 'agent-hourglass', 'aria-hidden': true });
      hourglass.append(svgElement('path', { d: 'M1.6,0.7 L9.4,0.7 M1.6,10.3 L9.4,10.3 M2.6,0.7 C2.6,3.6 5.5,4.3 5.5,5.5 C5.5,6.7 2.6,7.4 2.6,10.3 M8.4,0.7 C8.4,3.6 5.5,4.3 5.5,5.5 C5.5,6.7 8.4,7.4 8.4,10.3', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.1, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }), svgElement('path', { d: 'M3.7,9.7 L7.3,9.7 L5.5,7.7 Z', fill: 'currentColor', opacity: .75 }));
      rate.replaceChildren(hourglass);
    }
    row.title = (agent.name || agent.id) + '\n' + t('profile') + ': ' + agent.profile + '\n' + t('project') + ': ' + (agent.project || '—') + '\n' + t('average') + ': ' + number(agent.outputTps, 1) + ' tok/s · TTFT: ' + (finite(agent.ttftMs) === null ? t('unknown') : number(agent.ttftMs / 1000, 2) + ' s') + '\n' + timestamp(agent.lastActivityAt) + '\n' + t('agentNote');
    row.append(copy, phase, rate); fragment.append(row);
  }
  node('agent-rows').replaceChildren(fragment); text('agent-count', agents.length ? number(agents.length) : ''); node('agents-empty').hidden = agents.length > 0; node('agent-note').hidden = agents.length === 0;
  const toggle = node('agents-toggle'); toggle.hidden = ordered.length <= 6; toggle.setAttribute('aria-expanded', String(agentsExpanded)); toggle.textContent = agentsExpanded ? t('collapseAgents') + ' ⌃' : '+' + number(ordered.length - 6) + ' ' + t('moreAgents') + ' ⌄';
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
  const enabled = node('network-enabled'), refresh = node('public-refresh'), currency = node('currency');
  enabled.disabled = !pricing; enabled.checked = !!(pricing && pricing.networkEnabled); refresh.disabled = !pricing || !pricing.networkEnabled || pricing.prices.status === 'updating' || pricing.rates.status === 'updating'; currency.disabled = !pricing;
  if (!pricing) { text('public-status', t('unknown')); text('public-details', t('scanning')); text('currency-rate', t('unknown')); return; }
  if (document.activeElement !== currency || !currency.options.length) {
    if (!currencyOptions || currencyOptions.language !== language || !sameOptionValues(currencyOptions.values, pricing.currencies)) {
      const fragment = document.createDocumentFragment(); for (const code of pricing.currencies) { const option = document.createElement('option'); option.value = code; option.textContent = code + (currencyNames ? ' · ' + currencyNames.of(code) : ''); fragment.append(option); } currency.replaceChildren(fragment);
      currencyOptions = { language, values: pricing.currencies };
    }
    if (currency.value !== pricing.currency) currency.value = pricing.currency;
  }
  text('public-status', t(pricing.networkEnabled ? 'networkOn' : 'networkOff'));
  for (const [key, feed] of [['prices', pricing.prices], ['rates', pricing.rates]]) {
    text(key + '-status', t('feed_' + feed.status) + ' · ' + t('dataDate') + ': ' + dateLabel(feed.updatedAt) + '\n' + t('lastSuccess') + ': ' + (feed.fetchedAt ? timestamp(feed.fetchedAt, true) : t('neverFetched')));
    text(key + '-source', t('source') + ': ' + feed.source + (feed.version ? '\n' + feed.version : ''));
  }
  text('currency-rate', pricing.currency === 'USD' ? t('noConversion') : finite(pricing.exchangeRate) === null ? pricing.currency + ': ' + t('rateUnavailable') : '1 USD = ' + number(pricing.exchangeRate, 2) + ' ' + pricing.currency + ' · ' + t('conversionAsOf') + ' ' + dateLabel(pricing.rates.updatedAt));
  text('currency-attribution', pricing.attribution ? t('attribution') + ': ' + pricing.attribution.label + '\n' + pricing.attribution.url : ''); text('public-details', t('publicPrivacy'));
}
function selectedDates() {
  const today = todayDate(), earliest = shiftDate(today, -29);
  if (historyRange === 'today') return { startDate: today, endDate: today };
  if (historyRange === 'yesterday') { const yesterday = shiftDate(today, -1); return { startDate: yesterday, endDate: yesterday }; }
  if (historyRange === 'custom' && parseDate(customStart) && parseDate(customEnd)) return { startDate: customStart < earliest ? earliest : customStart > today ? today : customStart, endDate: customEnd > today ? today : customEnd < earliest ? earliest : customEnd };
  return { startDate: shiftDate(today, historyRange === '7' ? -6 : -29), endDate: today };
}
function hasUsage(day) { return day.requests > 0 || day.inputTokens > 0 || day.outputTokens > 0 || day.totalTokens > 0 || day.peakOutputTps > 0; }
function rangeDays(snapshot) { const range = selectedDates(); return snapshot ? snapshot.days.filter(day => day.date >= range.startDate && day.date <= range.endDate) : []; }
function sumUsage(days) {
  const usage = { requests: 0, failedRequests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0, unpricedRequests: 0, estimatedCostUsd: 0, unestimatedRequests: 0, measuredOutputTokens: 0, measuredDurationMs: 0, peakOutputTps: 0 };
  for (const day of days) for (const key of Object.keys(usage)) usage[key] = key === 'peakOutputTps' ? Math.max(usage[key], day[key]) : usage[key] + day[key];
  return usage;
}
function spark(id, values, highlight = -1) {
  let maximum = 1; for (const value of values) if (value !== null) maximum = Math.max(maximum, value);
  const points = values.map((value, index) => value === null ? null : [values.length < 2 ? 60 : index / (values.length - 1) * 120, 22 - value / maximum * 20]), path = node(id);
  path.setAttribute('d', smoothPath(points));
  let marker = path.parentElement.querySelector('.spark-highlight');
  if (!marker) { marker = svgElement('circle', { r: 2.5, class: 'spark-highlight', fill: 'var(--accent)', stroke: 'var(--surface)', 'stroke-width': 1 }); path.parentElement.append(marker); }
  if (highlight >= 0 && points[highlight]) { marker.setAttribute('cx', points[highlight][0]); marker.setAttribute('cy', points[highlight][1]); marker.removeAttribute('hidden'); }
  else marker.setAttribute('hidden', '');
}
function renderHistory(snapshot) {
  const dates = selectedDates(), days = rangeDays(snapshot), present = days.filter(hasUsage), usage = snapshot ? sumUsage(days) : null;
  const count = Math.round((parseDate(dates.endDate).getTime() - parseDate(dates.startDate).getTime()) / 86400000) + 1;
  text('history-range-label', dateLabel(dates.startDate) + (dates.startDate === dates.endDate ? '' : ' – ' + dateLabel(dates.endDate)) + ' · ' + number(count) + ' ' + t('days'));
  for (const button of node('history-ranges').querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.range === historyRange));
  for (const button of node('history-metrics').querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.metric === historyMetric));
  node('history-empty').hidden = present.length > 0 || !snapshot; node('history-body').hidden = !!snapshot && present.length === 0;
  text('history-output', compact(usage ? usage.outputTokens : null)); text('history-input', compact(usage ? usage.inputTokens : null)); text('history-requests', compact(usage ? usage.requests : null)); text('history-average', compact(average(usage))); text('history-cost', costText(usage, 'recorded'));
  text('history-output-note', snapshot ? number(present.length) + ' ' + t('activeDays') : t('unknown')); text('history-input-note', t('cache') + ' ' + (usage ? compact(usage.cacheReadTokens) + ' / ' + compact(usage.cacheWriteTokens) : '—')); text('history-requests-note', usage ? number(usage.failedRequests) + ' ' + t('failedRequests') : t('unknown'));
  text('history-cost-note', t('catalog') + ': ' + costText(usage, 'catalog'));
  for (const [id, key] of [['history-output', 'outputTokens'], ['history-input', 'inputTokens'], ['history-requests', 'requests']]) node(id).title = number(usage ? usage[key] : null);
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
  renderHistoryChart(days, dates); renderHistoryRows(present);
}
function historyBarValue(day) { return historyMetric === 'output' ? finite(day.outputTokens) : costValue(day, historyMetric); }
function renderHistoryChart(days, dates) {
  const root = node('history-chart-content'), fragment = document.createDocumentFragment(), byDate = new Map(days.map(day => [day.date, day]));
  const ticks = []; for (let date = dates.startDate; date <= dates.endDate; date = shiftDate(date, 1)) ticks.push(date);
  historyChartDays = days.filter(hasUsage);
  const singleDay = dates.startDate === dates.endDate;
  const showSpeed = historyMetric === 'output'; node('history-speed-legend').hidden = !showSpeed;
  node('history-chart').setAttribute('aria-label', t(showSpeed ? 'historyChart' : historyMetric === 'recorded' ? 'recordedCost' : 'catalogCost') + ' · ' + dateLabel(dates.startDate) + ' – ' + dateLabel(dates.endDate));
  node('history-chart').style.height = singleDay ? '120px' : '260px'; node('history-chart').setAttribute('viewBox', singleDay ? '0 0 820 120' : '0 0 820 260');
  text('history-chart-currency', historyMetric === 'output' ? '' : ' · USD · ' + t(historyMetric === 'recorded' ? 'recorded' : 'catalog'));
  if (singleDay) {
    const day = historyChartDays[0];
    if (day) {
      const amount = historyBarValue(day);
      fragment.append(svgElement('circle', { cx: 18, cy: 30, r: 4, fill: 'var(--source)' }), svgElement('text', { x: 34, y: 34, fill: 'var(--text)', 'font-size': 13 }, 'OMP'));
      fragment.append(svgElement('text', { x: 802, y: 34, 'text-anchor': 'end', fill: 'var(--text)', 'font-size': 13, 'font-weight': 600 }, historyMetric === 'output' ? compact(day.outputTokens) : costText(day, historyMetric, false)));
      fragment.append(svgElement('rect', { x: 18, y: 51, width: 784, height: 4, rx: 2, fill: 'var(--line)' }));
      if (amount !== null && amount > 0) fragment.append(svgElement('rect', { x: 18, y: 51, width: 784, height: 4, rx: 2, fill: 'var(--source)', opacity: .65 }));
      fragment.append(svgElement('text', { x: 18, y: 80, fill: 'var(--secondary)', 'font-size': 12 }, t('requests') + ' ' + number(day.requests) + (showSpeed ? ' · ' + t('average') + ' ' + number(average(day), 1) + ' tok/s' : '')));
      const hit = svgElement('rect', { x: 6, y: 10, width: 808, height: 84, rx: 5, fill: 'transparent', class: 'history-bar', tabindex: 0, role: 'button', 'data-date': day.date, 'aria-label': historyTooltip(day) });
      hit.append(svgElement('title', {}, historyTooltip(day))); hit.addEventListener('click', () => selectHistoryDate(day.date, true)); hit.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectHistoryDate(day.date, true); } }); hit.addEventListener('pointermove', event => showHistoryTooltip(day, event)); hit.addEventListener('pointerleave', () => { node('history-chart-tooltip').hidden = true; }); fragment.append(hit);
    }
    root.replaceChildren(fragment); node('history-chart-tooltip').hidden = true; return;
  }
  let maximum = 1, maximumAverage = 1;
  for (const day of days) { maximum = Math.max(maximum, historyBarValue(day) || 0); if (showSpeed) maximumAverage = Math.max(maximumAverage, average(day) || 0); }
  const left = 42, right = showSpeed ? 780 : 802, top = 18, bottom = 228, width = right - left;
  for (let index = 0; index < 4; index++) {
    const y = top + (bottom - top) * index / 3, ratio = 1 - index / 3;
    fragment.append(svgElement('line', { x1: left, x2: right, y1: y, y2: y, class: 'chart-grid' })); fragment.append(svgElement('text', { x: left - 7, y: y + 3, 'text-anchor': 'end', class: 'chart-label' }, historyMetric === 'output' ? compact(maximum * ratio) : number(maximum * ratio, 2)));
    if (showSpeed) fragment.append(svgElement('text', { x: 818, y: y + 3, 'text-anchor': 'end', class: 'chart-label' }, compact(maximumAverage * ratio)));
  }
  const step = width / Math.max(1, ticks.length), barWidth = Math.max(3, Math.min(36, step * .72)), averagePoints = [], today = todayDate();
  let lastMonth = '';
  for (let index = 0; index < ticks.length; index++) {
    const date = ticks[index], day = byDate.get(date), x = left + step * (index + .5), month = date.slice(0, 7);
    if (month !== lastMonth && index > 0) { fragment.append(svgElement('line', { x1: x - step / 2, x2: x - step / 2, y1: top, y2: bottom, class: 'chart-grid', 'stroke-dasharray': '2 3' })); lastMonth = month; } else lastMonth = month;
    const value = day ? historyBarValue(day) : null;
    if (day && hasUsage(day) && value !== null) {
      const height = value / maximum * (bottom - top), bar = svgElement('rect', { x: x - barWidth / 2, y: bottom - Math.max(1, height), width: barWidth, height: Math.max(1, height), rx: Math.min(3, barWidth / 4), fill: date === today ? 'url(#history-today-hatch)' : 'url(#history-bar-gradient)', class: 'history-bar', 'data-date': date, tabindex: 0, role: 'button', 'aria-label': historyTooltip(day) });
      const title = svgElement('title', {}, historyTooltip(day)); bar.append(title); bar.addEventListener('pointerenter', event => showHistoryTooltip(day, event)); bar.addEventListener('pointermove', event => showHistoryTooltip(day, event)); bar.addEventListener('pointerleave', () => { node('history-chart-tooltip').hidden = true; }); bar.addEventListener('focus', () => showHistoryTooltip(day)); bar.addEventListener('blur', () => { node('history-chart-tooltip').hidden = true; }); bar.addEventListener('click', () => selectHistoryDate(date, true)); bar.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectHistoryDate(date, true); } }); fragment.append(bar);
      if (date === today) fragment.append(svgElement('text', { x, y: Math.max(10, bottom - height - 6), 'text-anchor': 'middle', class: 'chart-label' }, t('inProgress')));
    }
    if (showSpeed) { const avg = day ? average(day) : null; averagePoints.push(avg === null ? null : [x, bottom - avg / maximumAverage * (bottom - top)]); }
    if (index === 0 || index === ticks.length - 1 || index % Math.max(1, Math.ceil(ticks.length / 8)) === 0) fragment.append(svgElement('text', { x, y: 250, 'text-anchor': 'middle', class: 'chart-axis' }, timeFormatters.shortDate.format(parseDate(date))));
  }
  if (showSpeed) {
    fragment.append(svgElement('path', { d: smoothPath(averagePoints), class: 'history-average' }));
    for (const point of averagePoints) if (point) fragment.append(svgElement('circle', { cx: point[0], cy: point[1], r: 2.6, class: 'history-average-dot' }));
  }
  root.replaceChildren(fragment); node('history-chart-tooltip').hidden = true;
}
function historyTooltip(day) {
  return dateLabel(day.date) + ' · ' + timeFormatters.weekday.format(parseDate(day.date)) + '\n' + t('output') + ': ' + number(day.outputTokens) + ' · ' + t('input') + ': ' + number(day.inputTokens) + '\n' + t('requests') + ': ' + number(day.requests) + ' / ' + number(day.failedRequests) + ' ' + t('failures') + '\n' + t('average') + ': ' + number(average(day), 1) + ' tok/s · ' + t('peak') + ': ' + number(day.peakOutputTps, 1) + ' tok/s\n' + t('recordedCost') + ': ' + costText(day, 'recorded', false) + '\n' + t('catalogCost') + ': ' + costText(day, 'catalog', false);
}
function showHistoryTooltip(day, event = null) {
  const tooltip = node('history-chart-tooltip'), parent = tooltip.parentElement.getBoundingClientRect(); tooltip.textContent = historyTooltip(day); tooltip.hidden = false;
  const x = event ? event.clientX - parent.left + 12 : 52, y = event ? event.clientY - parent.top - tooltip.offsetHeight - 12 : 56;
  tooltip.style.left = Math.max(8, Math.min(parent.width - tooltip.offsetWidth - 8, x)) + 'px'; tooltip.style.top = Math.max(40, y) + 'px';
}
function cell(row, value, numeric = false) { const td = document.createElement('td'); td.textContent = String(value); if (numeric) td.className = 'number'; row.append(td); return td; }
function renderHistoryRows(days) {
  const sorted = days.slice().sort((left, right) => {
    const a = historySort === 'average' ? average(left) : left[historySort], b = historySort === 'average' ? average(right) : right[historySort];
    const result = typeof a === 'string' ? a.localeCompare(b) : a === null ? b === null ? 0 : -1 : b === null ? 1 : a - b; return (historyDescending ? -1 : 1) * result || right.date.localeCompare(left.date);
  });
  const fragment = document.createDocumentFragment(), today = todayDate(), yesterday = shiftDate(today, -1);
  for (const day of sorted) {
    const row = document.createElement('tr'); row.dataset.date = day.date; row.dataset.selected = String(day.date === selectedHistoryDate); row.tabIndex = 0; row.title = historyTooltip(day);
    const dateCell = cell(row, dateLabel(day.date)); const weekday = document.createElement('span'); weekday.className = 'cell-note'; weekday.textContent = (day.date === today ? t('today') + ' · ' : day.date === yesterday ? t('yesterday') + ' · ' : '') + timeFormatters.weekday.format(parseDate(day.date)); dateCell.append(weekday);
    const requests = cell(row, number(day.requests), true); if (day.failedRequests > 0) { const failures = document.createElement('span'); failures.className = 'cell-note'; failures.textContent = number(day.failedRequests) + ' ' + t('failures'); requests.append(failures); }
    cell(row, compact(day.outputTokens), true).title = number(day.outputTokens); cell(row, compact(day.inputTokens), true).title = number(day.inputTokens);
    for (const [mode, missing, label] of [['recorded', day.unpricedRequests, 'unpriced'], ['catalog', day.unestimatedRequests, 'unestimated']]) {
      const cost = cell(row, costText(day, mode, false), true); if (missing > 0) { const note = document.createElement('span'); note.className = 'cell-note'; note.textContent = number(missing) + ' ' + t(label); cost.append(note); }
    }
    cell(row, compact(day.cacheReadTokens) + ' / ' + compact(day.cacheWriteTokens), true).title = number(day.cacheReadTokens) + ' / ' + number(day.cacheWriteTokens); cell(row, compact(day.totalTokens), true).title = number(day.totalTokens); cell(row, average(day) === null ? '—' : number(average(day), 1), true);
    const peak = cell(row, number(day.peakOutputTps, 1), true), peakAt = day.date === today && day.peakOutputTps > 0 && view.snapshot ? finite(view.snapshot.activity.peakAt) : null;
    peak.title = peakAt !== null ? t('peakMeasurement') + ' ' + timestamp(peakAt, true) : t('historyPeakTimeUnknown');
    if (peakAt !== null) { const time = document.createElement('span'); time.className = 'cell-note'; time.textContent = timestamp(peakAt); peak.append(time); }
    row.addEventListener('click', () => selectHistoryDate(day.date, false)); row.addEventListener('focus', () => { selectedHistoryDate = day.date; markSelectedHistory(); });
    row.addEventListener('keydown', event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); const next = event.key === 'ArrowDown' ? row.nextElementSibling : row.previousElementSibling; if (next) next.focus(); } }); fragment.append(row);
  }
  node('history-rows').replaceChildren(fragment);
  for (const button of document.querySelectorAll('[data-sort]')) button.parentElement.setAttribute('aria-sort', button.dataset.sort === historySort ? historyDescending ? 'descending' : 'ascending' : 'none');
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
  text('today-total', compact(usage ? usage.totalTokens : null)); text('today-cache', usage ? compact(usage.cacheReadTokens) + ' / ' + compact(usage.cacheWriteTokens) : '—'); text('today-failures', number(usage ? usage.failedRequests : null)); text('today-duration', usage ? number(usage.measuredDurationMs / 1000, 1) + ' s' : '—');
  renderCoverage(snapshot); renderResources(snapshot ? snapshot.resources : null);
}
function renderSettingsContent() {
  syncPreferences(); text('settings-title', t(settingsPage === 'data' ? 'localData' : settingsPage));
  if (settingsPage === 'cost') renderPublicData(view.snapshot ? view.snapshot.pricing : null);
  else if (settingsPage === 'data') renderData(view.snapshot);
}
function setSettingsPage(page, focus = false) {
  if (!['general', 'orb', 'effects', 'cost', 'data', 'about'].includes(page)) return;
  monitorSelectPicker.close();
  settingsPage = page;
  for (const panel of document.querySelectorAll('.settings-page')) panel.hidden = panel.dataset.page !== page;
  for (const button of document.querySelectorAll('.settings-nav [role=tab]')) { const selected = button.dataset.page === page; button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1; }
  text('settings-title', t(page === 'data' ? 'localData' : page)); node('settings-scroller').scrollTop = 0;
  if (focus) node('nav-' + page).focus();
  if (view) { renderSettingsContent(); renderArt(); }
}
function closePopover(restoreFocus = false) {
  for (const element of document.querySelectorAll('.popover')) element.hidden = true;
  for (const id of ['cost-info', 'metric-info']) node(id).setAttribute('aria-expanded', 'false');
  if (restoreFocus && popoverAnchor) popoverAnchor.focus(); popoverAnchor = null;
}
function openPopover(id, anchor) {
  const popup = node(id), wasOpen = !popup.hidden; closePopover(); if (wasOpen) return;
  popup.hidden = false; popoverAnchor = anchor; anchor.setAttribute('aria-expanded', 'true');
  const rect = anchor.getBoundingClientRect(); popup.style.left = Math.max(12, Math.min(window.innerWidth - popup.offsetWidth - 12, rect.right - popup.offsetWidth)) + 'px';
  const top = rect.top - popup.offsetHeight - 8; popup.style.top = Math.max(12, Math.min(window.innerHeight - popup.offsetHeight - 12, top >= 12 ? top : rect.bottom + 8)) + 'px';
  const first = popup.querySelector('button,input'); if (first) first.focus();
}
function renderView() {
  if (!view || rendererDestroyed) return;
  appearance = view.preferences.appearance === 'system' ? systemAppearance.matches ? 'dark' : 'light' : view.preferences.appearance;
  document.body.dataset.surface = view.surface; document.body.dataset.appearance = appearance; document.body.dataset.effects = view.preferences.effects; document.body.dataset.hidden = String(document.hidden); document.documentElement.style.setProperty('--orb-size', view.preferences.size + 'px');
  for (const surface of ['orb', 'dashboard', 'history', 'settings']) node(surface + '-surface').hidden = view.surface !== surface;
  renderStatus();
  if (document.hidden) { renderArt(); return; }
  if (view.surface === 'dashboard') { renderToday(snapshotFacts()); renderChart(liveFacts()); renderAgents(snapshotFacts() ? snapshotFacts().agents : []); }
  else if (view.surface === 'history') { for (const [id, kind] of [['history-profile', 'profile'], ['history-project', 'project']]) fillScope(id, view.scopes[kind === 'profile' ? 'profiles' : 'projects'], view.scope[kind], kind === 'profile' ? 'allProfiles' : 'allProjects'); renderHistory(snapshotFacts()); }
  else if (view.surface === 'settings') renderSettingsContent();
  renderArt();
}
function receiveState(next) {
  if (rendererDestroyed) return;
  const changed = !view || next.scope.profile !== view.scope.profile || next.scope.project !== view.scope.project || next.instanceId !== view.instanceId;
  const canCelebrate = !!view && !changed && !document.hidden && !view.workerError && !view.refreshing && !next.workerError && !next.refreshing && hasLiveSnapshot(view.snapshot) && hasLiveSnapshot(next.snapshot);
  const now = Date.now(), activity = next.activity;
  pendingActivity = {
    responsePulse: !!(canCelebrate && activityBaseline && activity.responseSequence > activityBaseline.responseSequence && activity.lastResponseAt !== null && now - activity.lastResponseAt >= 0 && now - activity.lastResponseAt <= 3000),
    newPeak: !!(canCelebrate && activityBaseline && activity.peakSequence > activityBaseline.peakSequence && activity.lastPeakAt !== null && now - activity.lastPeakAt >= 0 && now - activity.lastPeakAt <= 3000)
  };
  activityBaseline = { responseSequence: activity.responseSequence, peakSequence: activity.peakSequence };
  const languageChanged = language !== next.language; view = next;
  if (next.surface !== 'orb' || !next.orbVisible || next.preferences.clickThrough || document.hidden) {
    if (dragging || dragEnding || orbHovered) cancelLocalDrag(false); else node('orb-surface').dataset.dragging = 'false';
  }
  if (changed) { resetTitleTracker(); selectedHistoryDate = null; chartPoints = []; orbIdleSince = null; clearTimeout(peakBadgeTimer); node('peak-badge').hidden = true; }
  if (languageChanged) { language = next.language; applyLanguage(); }
  if (!document.hidden) renderView(); else { cancelPreviewInitialization(); trackedTitle(liveValue()); clearTimeout(titleDeadlineTimer); titleDeadlineTimer = null; orbIdleSince = null; pendingActivity = { responsePulse: false, newPeak: false }; syncInteraction(); for (const entry of artInstances.values()) entry.instance.setVisible(false); }
}
function syncInteraction() {
  if (!bridge || !view || view.surface !== 'orb') return;
  const available = !view.preferences.clickThrough && view.orbVisible && !document.hidden;
  let hit = false;
  if (available && lastPointer) {
    const size = view.preferences.size, dx = lastPointer.x - .75 * size, dy = lastPointer.y - .75 * size, radius = size * .5 * (orbHovered && !reducedMotion.matches ? 1.03 : 1);
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
    event.preventDefault(); let next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
    buttons[next].focus(); buttons[next].click();
  });
}
function bindControls() {
  monitorSelectPicker.install();
  for (const element of document.querySelectorAll('#close,[data-close]')) element.addEventListener('click', () => action(() => bridge.close()));
  for (const element of document.querySelectorAll('#refresh,[data-refresh]')) element.addEventListener('click', () => action(() => bridge.refresh()));
  for (const element of document.querySelectorAll('[data-open]')) element.addEventListener('click', () => action(() => bridge.openSurface(element.dataset.open)));
  for (const id of ['source-omp', 'open-history']) node(id).addEventListener('click', () => action(() => bridge.openSurface('history')));
  node('open-settings').addEventListener('click', () => action(() => bridge.openSurface('settings'))); node('close-all').addEventListener('click', () => action(() => bridge.closeAll()));
  node('new-window').addEventListener('click', () => action(() => bridge.newWindow())); node('orb-menu').addEventListener('click', () => action(() => bridge.showMenu()));
  for (const id of ['orb-visible', 'settings-orb-visible']) node(id).addEventListener('change', event => action(() => bridge.setOrbVisible(event.target.checked)));
  node('export').addEventListener('click', () => action(async () => { const result = await bridge.exportCsv(selectedDates()); if (result !== 'cancelled') toast(t(result === 'saved' ? 'exportSaved' : result === 'unavailable' ? 'exportUnavailable' : 'exportFailed')); }));
  for (const input of document.querySelectorAll('[data-preference]')) input.addEventListener(input.type === 'range' ? 'input' : 'change', event => {
    const key = input.dataset.preference, value = input.type === 'checkbox' ? input.checked : input.type === 'range' ? Number(input.value) / (key === 'opacity' ? 100 : 1) : input.value;
    action(() => bridge.configure({ [key]: value }));
  });
  for (const select of document.querySelectorAll('[data-scope]')) select.addEventListener('change', () => {
    if (!view) return; const scope = { ...view.scope, [select.dataset.scope]: select.value || null }; action(() => bridge.setScope(scope));
  });
  node('size-presets').addEventListener('click', event => { const button = event.target.closest('[data-size]'); if (button) action(() => bridge.configure({ size: Number(button.dataset.size) })); });
  node('network-enabled').addEventListener('change', event => action(() => bridge.setNetworkEnabled(event.target.checked))); node('public-refresh').addEventListener('click', () => action(() => bridge.refreshPublicData())); node('currency').addEventListener('change', event => action(() => bridge.setCurrency(event.target.value)));
  for (const button of document.querySelectorAll('.settings-nav [role=tab]')) button.addEventListener('click', () => setSettingsPage(button.dataset.page));
  node('settings-scroller').addEventListener('scroll', () => { if (settingsPage === 'orb') renderArt(); }, { passive: true });
  node('orb-list').addEventListener('keydown', event => {
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    const choices = Array.from(node('orb-list').children), index = choices.indexOf(event.target.closest('.orb-choice')); if (index < 0) return;
    event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : Math.max(0, Math.min(choices.length - 1, index + (event.key === 'ArrowUp' ? -1 : 1))); choices[next].focus(); choices[next].click();
  });
  node('agents-toggle').addEventListener('click', () => { agentsExpanded = !agentsExpanded; renderAgents(snapshotFacts() ? snapshotFacts().agents : []); });
  node('chart-ranges').addEventListener('click', event => { const button = event.target.closest('[data-seconds]'); if (!button) return; chartSeconds = Number(button.dataset.seconds); for (const element of node('chart-ranges').children) element.setAttribute('aria-pressed', String(element === button)); renderChart(liveFacts()); });
  node('rate-chart').addEventListener('pointermove', event => {
    if (!chartPoints.length || !liveChartBounds) return; const rect = node('rate-chart').getBoundingClientRect(), x = (event.clientX - rect.left) / rect.width * 328, time = liveChartBounds.start + Math.max(0, Math.min(1, x / liveChartBounds.right)) * (liveChartBounds.end - liveChartBounds.start);
    let closest = 0; for (let index = 1; index < chartPoints.length; index++) if (Math.abs(chartPoints[index].timestamp - time) < Math.abs(chartPoints[closest].timestamp - time)) closest = index; node('rate-chart').dataset.index = String(closest); showLivePoint(closest, event.clientX - rect.left);
  });
  node('rate-chart').addEventListener('pointerleave', () => { node('rate-chart-tooltip').hidden = true; node('rate-chart-cursor').hidden = true; });
  node('rate-chart').addEventListener('keydown', event => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || !chartPoints.length) return; event.preventDefault(); const current = Number(node('rate-chart').dataset.index || chartPoints.length - 1), index = Math.max(0, Math.min(chartPoints.length - 1, event.key === 'Home' ? 0 : event.key === 'End' ? chartPoints.length - 1 : current + (event.key === 'ArrowLeft' ? -1 : 1))); node('rate-chart').dataset.index = String(index); showLivePoint(index); });
  node('history-ranges').addEventListener('click', event => {
    const button = event.target.closest('[data-range]'); if (!button) return;
    if (button.dataset.range === 'custom') { const dates = selectedDates(), today = todayDate(), earliest = shiftDate(today, -29); node('history-from').min = earliest; node('history-from').max = today; node('history-to').min = earliest; node('history-to').max = today; node('history-from').value = dates.startDate; node('history-to').value = dates.endDate; openPopover('custom-range-popover', button); }
    else { historyRange = button.dataset.range; renderHistory(snapshotFacts()); }
  });
  node('history-apply').addEventListener('click', () => {
    const start = node('history-from').value, end = node('history-to').value, today = todayDate(), earliest = shiftDate(today, -29);
    if (!parseDate(start) || !parseDate(end) || start > end || start < earliest || end > today) { toast(t('invalidRange')); return; }
    customStart = start; customEnd = end; historyRange = 'custom'; closePopover(true); renderHistory(snapshotFacts());
  });
  node('history-metrics').addEventListener('click', event => { const button = event.target.closest('[data-metric]'); if (button) { historyMetric = button.dataset.metric; renderHistory(snapshotFacts()); } });
  for (const button of document.querySelectorAll('[data-sort]')) button.addEventListener('click', () => { if (historySort === button.dataset.sort) historyDescending = !historyDescending; else { historySort = button.dataset.sort; historyDescending = true; } renderHistoryRows(rangeDays(snapshotFacts()).filter(hasUsage)); });
  node('history-chart').addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || !historyChartDays.length) return; event.preventDefault(); const current = historyChartDays.findIndex(day => day.date === selectedHistoryDate), index = Math.max(0, Math.min(historyChartDays.length - 1, event.key === 'Home' ? 0 : event.key === 'End' ? historyChartDays.length - 1 : current + (event.key === 'ArrowLeft' ? -1 : 1))); const day = historyChartDays[index]; selectedHistoryDate = day.date; markSelectedHistory(); showHistoryTooltip(day);
  });
  node('cost-info').addEventListener('click', () => openPopover('cost-popover', node('cost-info'))); node('metric-info').addEventListener('click', () => openPopover('metric-popover', node('metric-info')));
  for (const element of document.querySelectorAll('[data-dismiss]')) element.addEventListener('click', () => closePopover(true));
  document.addEventListener('pointerdown', event => { if (popoverAnchor && !event.target.closest('.popover') && !popoverAnchor.contains(event.target)) closePopover(); });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') { if (popoverAnchor) { event.preventDefault(); closePopover(true); } else if (view && view.surface !== 'orb') action(() => bridge.close()); }
  });
  bindRadioKeyboard('theme-cards'); bindRadioKeyboard('style-cards');
  const tabs = node('settings-surface').querySelector('[role=tablist]'); tabs.addEventListener('keydown', event => { if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return; const buttons = Array.from(tabs.querySelectorAll('[role=tab]')), index = buttons.indexOf(event.target); if (index < 0) return; event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length; setSettingsPage(buttons[next].dataset.page, true); });
  bindOrb();
}
function startMonitor() {
  applyLanguage(); text('about-attribution', monitorAttribution); text('about-license', monitorLicense); setSettingsPage('general');
  if (!bridge) { toast(t('bridgeError')); return; }
  bindControls(); unsubscribe = bridge.onState(receiveState);
  unsubscribePointer = bridge.onPointer(pointer => { lastPointer = pointer; syncInteraction(); });
  unsubscribeDrag = bridge.onDragCancelled(() => cancelLocalDrag());
  bridge.ready().then(receiveState).catch(() => { if (!rendererDestroyed) toast(t('bridgeError')); });
  document.addEventListener('visibilitychange', () => { if (rendererDestroyed) return; document.body.dataset.hidden = String(document.hidden); if (document.hidden) { cancelPreviewInitialization(); cancelLocalDrag(false); clearTimeout(titleDeadlineTimer); titleDeadlineTimer = null; orbIdleSince = null; pendingActivity = { responsePulse: false, newPeak: false }; for (const entry of artInstances.values()) entry.instance.setVisible(false); } else renderView(); });
  systemAppearance.addEventListener('change', renderView); reducedMotion.addEventListener('change', renderView); window.addEventListener('blur', finishDrag);
  window.addEventListener('resize', () => { closePopover(); renderView(); });
  window.addEventListener('pagehide', () => { if (rendererDestroyed) return; rendererDestroyed = true; cancelPreviewInitialization(); cancelLocalDrag(false); if (unsubscribe) unsubscribe(); if (unsubscribePointer) unsubscribePointer(); if (unsubscribeDrag) unsubscribeDrag(); clearTimeout(toastTimer); clearTimeout(selectedDayTimer); clearTimeout(peakBadgeTimer); clearTimeout(titleDeadlineTimer); for (const entry of artInstances.values()) entry.instance.destroy(); agentSpeedVisuals.disposeSharedGpu(); artInstances.clear(); orbRows.clear(); systemAppearance.removeEventListener('change', renderView); reducedMotion.removeEventListener('change', renderView); });
}
`;
