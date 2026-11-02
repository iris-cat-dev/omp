/** Gregorian date-only arithmetic shared by the renderer calendar and its state tests. */
export function createDateCalendarModel() {
  const minimum = "0001-01-01",
    maximum = "9999-12-31";
  const pad = (value: number, length = 2) => String(value).padStart(length, "0");
  const leap = (year: number) => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = (year: number, month: number) => {
    if (month === 2) return leap(year) ? 29 : 28;
    return [4, 6, 9, 11].includes(month) ? 30 : 31;
  };
  function parts(value: string | null | undefined) {
    const match = typeof value === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
    if (!match) return null;
    const year = Number(match[1]),
      month = Number(match[2]),
      day = Number(match[3]);
    return year >= 1 &&
      year <= 9999 &&
      month >= 1 &&
      month <= 12 &&
      day >= 1 &&
      day <= monthDays(year, month)
      ? { year, month, day }
      : null;
  }
  const iso = (year: number, month: number, day: number) =>
    pad(year, 4) + "-" + pad(month) + "-" + pad(day);
  function utc(value: string) {
    const date = parts(value);
    if (!date) return null;
    // Date.UTC treats years 0..99 as 1900..1999. setUTCFullYear does not.
    const result = new Date(0);
    result.setUTCFullYear(date.year, date.month - 1, date.day);
    result.setUTCHours(0, 0, 0, 0);
    return result;
  }
  function addDays(value: string, count: number) {
    const date = utc(value);
    if (!date || !Number.isInteger(count)) return null;
    date.setUTCDate(date.getUTCDate() + count);
    const year = date.getUTCFullYear();
    return year >= 1 && year <= 9999 ? iso(year, date.getUTCMonth() + 1, date.getUTCDate()) : null;
  }
  function addMonths(value: string, count: number) {
    const date = parts(value);
    if (!date || !Number.isInteger(count)) return null;
    const total = (date.year - 1) * 12 + date.month - 1 + count;
    if (total < 0 || total >= 9999 * 12) return null;
    const year = Math.floor(total / 12) + 1,
      month = (total % 12) + 1;
    return iso(year, month, Math.min(date.day, monthDays(year, month)));
  }
  function culture(value: string) {
    const language = value.toLowerCase().replace(/_/g, "-");
    if (language.startsWith("ja"))
      return { locale: "ja-JP", firstDay: 0, yearFirst: true, padded: true };
    if (language.startsWith("zh") && /(?:hant|tw|hk|mo)/.test(language))
      return { locale: "zh-TW", firstDay: 0, yearFirst: true, padded: false };
    if (language.startsWith("zh"))
      return { locale: "zh-CN", firstDay: 1, yearFirst: true, padded: false };
    return { locale: "en-US", firstDay: 0, yearFirst: false, padded: false };
  }
  function shortDate(value: string, locale: string) {
    const date = parts(value);
    if (!date) return "";
    const selected = culture(locale),
      year = pad(date.year, 4);
    const month = selected.padded ? pad(date.month) : String(date.month),
      day = selected.padded ? pad(date.day) : String(date.day);
    return selected.yearFirst ? year + "/" + month + "/" + day : month + "/" + day + "/" + year;
  }
  function parseText(value: string, locale: string) {
    const text = value.normalize("NFKC").trim();
    if (parts(text)) return text;
    const match = /^(\d{1,4})\s*[/.\-年]\s*(\d{1,2})\s*[/.\-月]\s*(\d{1,4})\s*日?$/.exec(text);
    if (!match) return null;
    const selected = culture(locale),
      yearText = selected.yearFirst ? match[1]! : match[3]!;
    let year = Number(yearText);
    // GregorianCalendar's .NET 10 default two-digit-year window ends at 2049.
    if (yearText.length <= 2) year += year <= 49 ? 2000 : 1900;
    const date = selected.yearFirst
      ? iso(year, Number(match[2]), Number(match[3]))
      : iso(year, Number(match[1]), Number(match[2]));
    return parts(date) ? date : null;
  }
  const inside = (value: string, min = minimum, max = maximum) =>
    !!parts(value) && value >= min && value <= max;
  const clamp = (value: string, min = minimum, max = maximum) => {
    if (value < min) return min;
    return value > max ? max : value;
  };
  function grid(value: string, firstDay: number): (string | null)[] {
    const date = parts(value);
    if (!date) return [];
    const start = iso(date.year, date.month, 1),
      weekday = utc(start)!.getUTCDay();
    // WPF CalendarItem always includes a preceding week when the month begins on FirstDayOfWeek.
    const offset = (weekday - firstDay + 7) % 7 || 7;
    return Array.from({ length: 42 }, (_, index) => addDays(start, index - offset));
  }
  return {
    minimum,
    maximum,
    parts,
    iso,
    utc,
    monthDays,
    addDays,
    addMonths,
    culture,
    shortDate,
    parseText,
    inside,
    clamp,
    grid,
  };
}

// HistoryWindow.xaml 550..584: the outer range surface remains owned by the page.
// The in-document calendar follows .NET 10 Fluent DatePicker/Calendar geometry, not Blink's page-popup widget.
export const MONITOR_DATE_RANGE_PICKER_CSS = String.raw`
.monitor-date-field{display:flex;align-items:stretch;position:relative;width:200px;min-height:32px;border:1px solid var(--control-line);border-bottom-color:var(--secondary);border-radius:4px;background:var(--control);color:var(--text);overflow:hidden}
.monitor-date-field:hover{background:var(--hover)}.monitor-date-field:focus-within{background:var(--popup);border-bottom:2px solid var(--accent)}.monitor-date-field[data-disabled=true]{opacity:.45}
.monitor-date-field>.monitor-date-text{display:block;width:0;min-width:0;flex:1;height:30px;min-height:0;margin:0;padding:4px 0 5px 11px;border:0;border-radius:0;background:transparent;outline:0;font:inherit;font-size:14px;color:inherit;user-select:text}
.monitor-date-field>.monitor-date-trigger{flex:none;width:30px;min-width:30px;min-height:24px;height:24px;align-self:center;margin:3px 4px 3px 0;padding:0;border:1px solid transparent;border-radius:4px;background:transparent;font-size:12px}.monitor-date-trigger:hover{background:var(--hover)}.monitor-date-trigger:focus-visible{outline-offset:-2px}
.monitor-date-calendar{--date-popup:#f9f9f9;position:fixed;z-index:110;width:296px;max-width:calc(100vw - 24px);max-height:calc(100vh - 24px);padding:0;margin:0;overflow:auto;overscroll-behavior:contain;border:1px solid transparent;border-radius:4px;background:var(--date-popup);background-clip:padding-box;color:var(--text);box-shadow:0 6px 20px #00000040;font:14px/20px 'Segoe UI Variable Text','Segoe UI','Microsoft YaHei UI','Microsoft JhengHei UI','Yu Gothic UI',sans-serif;user-select:none;animation:monitor-date-open .1s ease-out}body[data-appearance=dark] .monitor-date-calendar{--date-popup:#2c2c2c}
.monitor-date-calendar[lang=zh-TW]{font-family:'Segoe UI Variable Text','Segoe UI','Microsoft JhengHei UI','Microsoft YaHei UI','Yu Gothic UI',sans-serif}.monitor-date-calendar[lang=ja-JP]{font-family:'Segoe UI Variable Text','Segoe UI','Yu Gothic UI',sans-serif}
.monitor-date-calendar .monitor-date-header{display:grid;grid-template-columns:minmax(0,1fr) 40px 40px;height:52px;border-bottom:.5px solid transparent;align-items:start}.monitor-date-calendar .monitor-date-heading{justify-self:start;max-width:100%;min-width:0;min-height:32px;margin:6px 3px 7px 7px;padding:7px 8px 8px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;border:1px solid transparent;border-radius:4px;background:transparent;font-size:14px;font-weight:600;text-align:left}.monitor-date-calendar .monitor-date-heading:disabled{opacity:1}
.monitor-date-calendar .monitor-date-nav{width:26px;min-width:26px;height:26px;min-height:26px;margin:6px 7px 7px;padding:0;border:1px solid transparent;border-radius:4px;background:transparent;font-size:8px;color:var(--secondary)}.monitor-date-calendar .monitor-date-heading:not(:disabled):hover,.monitor-date-calendar .monitor-date-nav:not(:disabled):hover{background:var(--hover)}
.monitor-date-calendar .monitor-date-grid{display:grid;grid-template-rows:repeat(7,42px);height:294px}.monitor-date-calendar .monitor-date-row{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));align-items:center;justify-items:center}.monitor-date-calendar .monitor-date-weekday{padding:12px 0;font-size:14px;font-weight:700;text-align:center}
.monitor-date-calendar .monitor-date-cell{width:calc(100% - 2px);height:40px;min-width:0;min-height:40px;max-width:60px;max-height:60px;margin:1px;padding:0;border:1px solid transparent;border-radius:999px;background:transparent;color:var(--text);font-size:14px;font-weight:400;text-align:center}.monitor-date-calendar .monitor-date-cell:hover{background:var(--hover)}.monitor-date-calendar .monitor-date-cell[aria-selected=true]{border-color:var(--accent)}.monitor-date-calendar .monitor-date-cell[aria-current=date]{background:var(--accent);color:var(--accent-on)}.monitor-date-calendar .monitor-date-cell:focus-visible{outline:1px solid var(--text);outline-offset:-3px}.monitor-date-calendar .monitor-date-cell[data-unavailable=true]{visibility:hidden}
.monitor-date-calendar .monitor-date-grid[data-mode=year],.monitor-date-calendar .monitor-date-grid[data-mode=decade]{grid-template-rows:repeat(3,98px)}.monitor-date-calendar .monitor-date-grid[data-mode=year]>.monitor-date-row,.monitor-date-calendar .monitor-date-grid[data-mode=decade]>.monitor-date-row{grid-template-columns:repeat(4,minmax(0,1fr))}.monitor-date-calendar .monitor-date-grid:not([data-mode=month]) .monitor-date-cell{height:70px;min-height:40px;max-height:70px;max-width:70px}.monitor-date-calendar .monitor-date-grid:not([data-mode=month]) .monitor-date-cell[aria-selected=true]{background:var(--accent);color:var(--accent-on);border-color:transparent}
@keyframes monitor-date-open{from{opacity:0}to{opacity:1}}@media(prefers-reduced-motion:reduce){.monitor-date-calendar{animation:none}}body[data-effects=off] .monitor-date-calendar{animation:none}
@media(forced-colors:active){.monitor-date-field,.monitor-date-calendar{border-color:CanvasText;background:Canvas;color:CanvasText}.monitor-date-calendar .monitor-date-cell[aria-selected=true]{border-color:Highlight}.monitor-date-calendar .monitor-date-cell[aria-current=date],.monitor-date-calendar .monitor-date-grid:not([data-mode=month]) .monitor-date-cell[aria-selected=true]{background:Highlight;color:HighlightText;forced-color-adjust:none}}
`;

/**
 * bind(document,{locale}), render({locale}), focus(id), contains(target), close(restoreFocus), destroy().
 * #history-from/#history-to stay authoritative inclusive ISO inputs; no Apply handler is replaced.
 * Call render after the page sets their values/min/max, and focus after opening the outer flyout.
 */
export const MONITOR_DATE_RANGE_PICKER_SCRIPT = String.raw`
const monitorDateRangePicker = (() => {
  const dates = (${createDateCalendarModel.toString()})();
  const fields = new Map(), removers = [], popupId = 'monitor-date-calendar';
  let locale = 'en-US', popup = null, owner = null, display = '', mode = 'month', original = '', attached = false;
  const copy = {
    'en-US': {open:'Choose date',previous:'Previous',next:'Next',months:'Choose month',years:'Choose year',from:'From',to:'To',placeholder:'M/d/yyyy',weekdays:['S','M','T','W','T','F','S']},
    'zh-CN': {open:'选择日期',previous:'上一个',next:'下一个',months:'选择月份',years:'选择年份',from:'开始日期',to:'结束日期',placeholder:'yyyy/M/d',weekdays:['日','一','二','三','四','五','六']},
    'zh-TW': {open:'選擇日期',previous:'上一個',next:'下一個',months:'選擇月份',years:'選擇年份',from:'開始日期',to:'結束日期',placeholder:'yyyy/M/d',weekdays:['日','一','二','三','四','五','六']},
    'ja-JP': {open:'日付の選択',previous:'前へ',next:'次へ',months:'月の選択',years:'年の選択',from:'開始日',to:'終了日',placeholder:'yyyy/MM/dd',weekdays:['日','月','火','水','木','金','土']}
  };
  const strings = () => copy[locale];
  const bounds = state => ({min:dates.parts(state.input.min) ? state.input.min : dates.minimum,max:dates.parts(state.input.max) ? state.input.max : dates.maximum});
  const usable = state => { const limit = bounds(state); return !state.input.disabled && limit.min <= limit.max; };
  const label = state => state.input.getAttribute('aria-label') || (state.input.closest('label') && state.input.closest('label').querySelector('[data-i18n]') || {}).textContent || strings()[state.input.id === 'history-from' ? 'from' : 'to'];
  const listen = (target,name,handler,options) => { target.addEventListener(name,handler,options); removers.push(() => target.removeEventListener(name,handler,options)); };
  let formatLocale = '', formats = null;
  function calendarFormats() {
    if (formatLocale !== locale) {
      formatLocale = locale;
      formats = {
        heading:new Intl.DateTimeFormat(locale,{year:'numeric',month:'long',timeZone:'UTC'}),
        day:new Intl.DateTimeFormat(locale,{dateStyle:'full',timeZone:'UTC'}),
        month:new Intl.DateTimeFormat(locale,{month:'short',timeZone:'UTC'})
      };
    }
    return formats;
  }
  function sync(state, force = false) {
    const changed = state.last !== state.input.value;
    if (force || changed || !state.dirty) { const value = dates.shortDate(state.input.value,locale); if (state.text.value !== value) state.text.value = value; state.dirty = false; }
    state.last = state.input.value; state.text.disabled = state.trigger.disabled = !usable(state); state.wrap.dataset.disabled = String(!usable(state));
    state.text.setAttribute('aria-label',label(state)); state.text.placeholder = strings().placeholder;
    state.trigger.setAttribute('aria-label',strings().open + ': ' + label(state)); state.text.lang = locale;
    state.min = state.input.min; state.max = state.input.max; state.disabled = state.input.disabled; state.label = label(state);
  }
  function emit(state, value) {
    if (state.input.value === value) { sync(state,true); return false; }
    state.input.value = value; sync(state,true);
    state.notifying = true;
    try { state.input.dispatchEvent(new Event('input',{bubbles:true})); state.input.dispatchEvent(new Event('change',{bubbles:true})); }
    finally { state.notifying = false; }
    return true;
  }
  function select(state, value) {
    const limit = bounds(state);
    if (!usable(state) || value && !dates.inside(value,limit.min,limit.max)) return false;
    emit(state,value);
    const otherId = state.input.id === 'history-from' ? 'history-to' : 'history-from';
    const other = Array.from(fields.values()).find(field => field.input.id === otherId);
    if (value && other && dates.parts(other.input.value) && (state.input.id === 'history-from' ? other.input.value < value : other.input.value > value)) {
      const otherLimit = bounds(other);
      if (dates.inside(value,otherLimit.min,otherLimit.max)) emit(other,value);
    }
    return true;
  }
  function commitText(state) {
    if (!state.dirty) return;
    const text = state.text.value.trim(), value = text ? dates.parseText(text,locale) : '';
    if (value !== null) select(state,value);
    sync(state,true); // WPF restores its last valid selected date after an invalid text edit.
  }
  function close(restoreFocus = false) {
    if (!owner) return false;
    const state = owner; owner = null; state.text.setAttribute('aria-expanded','false'); state.trigger.setAttribute('aria-expanded','false');
    popup.hidden = true; popup.replaceChildren();
    if (restoreFocus && state.text.isConnected && !state.text.disabled) state.text.focus({preventScroll:true});
    return true;
  }
  function contains(target) {
    return !!target && typeof target.nodeType === 'number' && (!!popup && popup.contains(target) || Array.from(fields.values()).some(state => state.wrap.contains(target)));
  }
  function position() {
    if (!owner) return;
    const rect = owner.wrap.getBoundingClientRect(), inset = 12, gap = 4;
    popup.style.maxHeight = Math.max(1,window.innerHeight-inset*2)+'px';
    const width = popup.offsetWidth || Math.min(296,window.innerWidth-inset*2), height = popup.offsetHeight || 348;
    popup.style.left = Math.max(inset,Math.min(rect.left,window.innerWidth-width-inset))+'px';
    const below = window.innerHeight-rect.bottom-gap-inset, above = rect.top-gap-inset, down = below >= height || below >= above;
    popup.style.maxHeight = Math.max(1,down ? below : above)+'px';
    popup.style.top = (down ? rect.bottom+gap : Math.max(inset,rect.top-gap-Math.min(height,Math.max(1,above))))+'px';
  }
  function button(className, text, action) {
    const element = document.createElement('button'); element.type = 'button'; element.className = className; element.textContent = text; element.dataset.action = action; return element;
  }
  function period(delta) {
    const limit = bounds(owner);
    const candidate = dates.addMonths(display,delta * (mode === 'month' ? 1 : mode === 'year' ? 12 : 120));
    if (!candidate) return null;
    const date = dates.parts(candidate);
    const start = mode === 'month' ? dates.iso(date.year,date.month,1) : dates.iso(mode === 'year' ? date.year : Math.max(1,Math.floor(date.year/10)*10),1,1);
    const end = mode === 'month' ? dates.iso(date.year,date.month,dates.monthDays(date.year,date.month)) : dates.iso(mode === 'year' ? date.year : Math.min(9999,Math.floor(date.year/10)*10+9),12,31);
    return end >= limit.min && start <= limit.max ? dates.clamp(dates.iso(date.year,date.month,1),limit.min,limit.max) : null;
  }
  function draw(focusCell = false, retainAction = '') {
    if (!owner) return;
    const state = owner, limit = bounds(state), date = dates.parts(display), selected = state.input.value, text = strings();
    const format = calendarFormats(), now = new Date(), today = dates.iso(now.getFullYear(),now.getMonth()+1,now.getDate());
    popup.lang = locale; popup.dataset.mode = mode; popup.setAttribute('aria-label',text.open + ': ' + label(state));
    const header = document.createElement('div'); header.className = 'monitor-date-header';
    const title = mode === 'month' ? format.heading.format(dates.utc(display)) : mode === 'year' ? String(date.year) : String(Math.floor(date.year/10)*10)+'–'+String(Math.min(9999,Math.floor(date.year/10)*10+9));
    const heading = button('monitor-date-heading',title,'up'); heading.disabled = mode === 'decade'; heading.id = popupId+'-heading'; heading.setAttribute('aria-label',title + (mode === 'decade' ? '' : ', ' + (mode === 'month' ? text.months : text.years)));
    const previous = button('monitor-date-nav symbol','\uEDDB','previous'), next = button('monitor-date-nav symbol','\uEDDC','next');
    previous.setAttribute('aria-label',text.previous); next.setAttribute('aria-label',text.next); previous.disabled = !period(-1); next.disabled = !period(1); header.append(heading,previous,next);
    const grid = document.createElement('div'); grid.className = 'monitor-date-grid'; grid.dataset.mode = mode; grid.setAttribute('role','grid'); grid.setAttribute('aria-labelledby',heading.id);
    const row = () => { const element = document.createElement('div'); element.className = 'monitor-date-row'; element.setAttribute('role','row'); grid.append(element); return element; };
    let target = null;
    function cell(parent, value, content, unavailable, chosen, inactive = false) {
      const element = button('monitor-date-cell',content,mode === 'month' ? 'day' : mode === 'year' ? 'month' : 'year');
      element.dataset.date = value || ''; element.dataset.unavailable = String(unavailable); element.dataset.inactive = String(inactive); element.disabled = unavailable; element.tabIndex = -1;
      element.setAttribute('role','gridcell'); element.setAttribute('aria-selected',String(chosen));
      if (value) element.setAttribute('aria-label',mode === 'month' ? format.day.format(dates.utc(value)) : mode === 'year' ? format.heading.format(dates.utc(value)) : value.slice(0,4));
      if (mode === 'month' && value === today) element.setAttribute('aria-current','date');
      const active = value && (mode === 'month' ? value === display : mode === 'year' ? value.slice(0,7) === display.slice(0,7) : value.slice(0,4) === display.slice(0,4));
      if (active && !unavailable) { element.tabIndex = 0; target = element; }
      parent.append(element);
    }
    if (mode === 'month') {
      const names = row(), first = dates.culture(locale).firstDay;
      for (let index = 0; index < 7; index++) { const name = document.createElement('span'); name.className = 'monitor-date-weekday'; name.setAttribute('role','columnheader'); name.textContent = text.weekdays[(index+first)%7]; names.append(name); }
      const values = dates.grid(display,first);
      for (let week = 0; week < 6; week++) { const parent = row(); for (const value of values.slice(week*7,week*7+7)) cell(parent,value,value ? String(dates.parts(value).day) : '',!value || !dates.inside(value,limit.min,limit.max),value === selected,!!value && value.slice(0,7) !== display.slice(0,7)); }
    } else {
      const decade = Math.floor(date.year/10)*10;
      for (let line = 0; line < 3; line++) {
        const parent = row();
        for (let column = 0; column < 4; column++) {
          const index = line*4+column, year = mode === 'year' ? date.year : decade-1+index, month = mode === 'year' ? index+1 : 1;
          const value = year >= 1 && year <= 9999 ? dates.iso(year,month,1) : null;
          const end = value && dates.iso(year,mode === 'year' ? month : 12,mode === 'year' ? dates.monthDays(year,month) : 31);
          const unavailable = !value || end < limit.min || value > limit.max;
          const content = mode === 'year' ? format.month.format(dates.utc(value)) : value ? String(year) : '';
          cell(parent,value,content,unavailable,mode === 'year' ? month === date.month : year === date.year,mode === 'decade' && (year < decade || year > decade+9));
        }
      }
    }
    if (!target) { target = grid.querySelector('button:not(:disabled)'); if (target) target.tabIndex = 0; }
    popup.replaceChildren(header,grid); position();
    const retained = retainAction && popup.querySelector('[data-action="'+retainAction+'"]:not(:disabled)');
    if (focusCell && target) target.focus({preventScroll:true}); else if (retained) retained.focus({preventScroll:true});
  }
  function move(value) {
    if (!value || !owner) return;
    const limit = bounds(owner);
    // Day keyboard selection rejects dates beyond the bounds; period navigation instead coerces DisplayDate.
    if (mode === 'month' && !dates.inside(value,limit.min,limit.max)) return;
    display = dates.clamp(value,limit.min,limit.max);
    if (mode === 'month') select(owner,display);
    draw(true);
  }
  function calendarKey(event) {
    if (!owner) return;
    const key = event.key;
    if (key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); const state = owner, value = original; select(state,value); close(true); return;
    }
    if (key === 'Tab') { close(true); return; }
    if (event.altKey || event.metaKey) return;
    const date = dates.parts(display);
    if (event.ctrlKey && key === 'ArrowUp') { if (mode !== 'decade') { mode = mode === 'month' ? 'year' : 'decade'; draw(true); } }
    else if (event.ctrlKey && key === 'ArrowDown') { if (mode === 'month' && event.shiftKey) move(dates.addDays(display,7)); else if (mode !== 'month') { mode = mode === 'decade' ? 'year' : 'month'; draw(true); } }
    else if (key === 'Enter' || key === ' ') {
      if (event.target.closest('[data-action=up],[data-action=previous],[data-action=next]')) return;
      if (mode === 'month') { select(owner,display); close(true); } else { mode = mode === 'decade' ? 'year' : 'month'; draw(true); }
    } else if (key === 'ArrowLeft' || key === 'ArrowRight') {
      const step = key === 'ArrowLeft' ? -1 : 1; move(mode === 'month' ? dates.addDays(display,step) : dates.addMonths(display,step*(mode === 'year' ? 1 : 12)));
    } else if (key === 'ArrowUp' || key === 'ArrowDown') {
      const step = key === 'ArrowUp' ? -1 : 1; move(mode === 'month' ? dates.addDays(display,step*7) : dates.addMonths(display,step*(mode === 'year' ? 4 : 48)));
    } else if (key === 'PageUp' || key === 'PageDown') {
      const step = key === 'PageUp' ? -1 : 1; move(dates.addMonths(display,step*(mode === 'month' ? 1 : mode === 'year' ? 12 : 120)));
    } else if (key === 'Home' || key === 'End') {
      const end = key === 'End', year = mode === 'decade' ? Math.max(1,Math.min(9999,Math.floor(date.year/10)*10+(end ? 9 : 0))) : date.year;
      const value = mode === 'month' ? dates.iso(year,date.month,end ? dates.monthDays(year,date.month) : 1) : dates.iso(year,mode === 'year' && end ? 12 : 1,1);
      move(value);
    } else return;
    event.preventDefault(); event.stopPropagation();
  }
  function ensurePopup() {
    if (popup) return;
    popup = document.createElement('div'); popup.id = popupId; popup.className = 'monitor-date-calendar scroll'; popup.hidden = true; popup.setAttribute('role','dialog'); popup.setAttribute('aria-modal','false');
    listen(popup,'keydown',calendarKey);
    listen(popup,'click',event => {
      const target = event.target.closest('button[data-action]'); if (!owner || !target || target.disabled || !popup.contains(target)) return;
      const action = target.dataset.action;
      if (action === 'previous' || action === 'next') { const next = period(action === 'next' ? 1 : -1); if (next) { display = next; draw(false,action); } }
      else if (action === 'up') { mode = mode === 'month' ? 'year' : 'decade'; draw(true); }
      else if (action === 'day') { if (select(owner,target.dataset.date)) close(true); }
      else { const limit = bounds(owner); display = dates.clamp(target.dataset.date,limit.min,limit.max); mode = action === 'year' ? 'year' : 'month'; draw(true); }
    });
    document.body.append(popup);
  }
  function open(state) {
    if (!usable(state) || state.input.closest('[hidden]')) return;
    if (owner === state) { close(true); return; }
    close(); commitText(state); ensurePopup(); owner = state; original = state.input.value; mode = 'month';
    const limit = bounds(state), today = new Date(), fallback = dates.iso(today.getFullYear(),today.getMonth()+1,today.getDate());
    display = dates.clamp(dates.parts(original) ? original : fallback,limit.min,limit.max);
    state.text.setAttribute('aria-expanded','true'); state.trigger.setAttribute('aria-expanded','true'); popup.hidden = false; draw(true);
  }
  function attach() {
    if (attached) return; attached = true;
    listen(document,'pointerdown',event => { if (owner && !owner.wrap.contains(event.target) && !popup.contains(event.target)) close(); },true);
    listen(document,'focusin',event => { if (owner && !owner.wrap.contains(event.target) && !popup.contains(event.target)) close(); });
    listen(document,'scroll',event => { if (owner && event.target !== popup && !popup.contains(event.target)) close(); },{capture:true,passive:true});
    listen(document,'visibilitychange',() => { if (document.hidden) close(); });
    listen(window,'blur',() => close()); listen(window,'resize',() => close()); listen(window,'pagehide',() => close());
  }
  function bind(root = document, options = {}) {
    if (options.locale) render(options);
    attach();
    for (const input of root.querySelectorAll('#history-from,#history-to')) {
      if (fields.has(input)) continue;
      const type = input.getAttribute('type'), wrap = document.createElement('span'), text = document.createElement('input'), trigger = button('monitor-date-trigger symbol','\uE787','open');
      wrap.className = 'monitor-date-field'; text.id = input.id+'-text'; text.type = 'text'; text.className = 'monitor-date-text'; text.autocomplete = 'off'; text.spellcheck = false;
      text.setAttribute('aria-haspopup','dialog'); text.setAttribute('aria-controls',popupId); text.setAttribute('aria-expanded','false');
      trigger.setAttribute('aria-haspopup','dialog'); trigger.setAttribute('aria-controls',popupId); trigger.setAttribute('aria-expanded','false');
      input.before(wrap); wrap.append(input,text,trigger); input.type = 'hidden';
      const state = {input,wrap,text,trigger,type,last:input.value,dirty:false}; fields.set(input,state);
      listen(text,'input',() => { state.dirty = true; }); listen(text,'blur',() => commitText(state));
      listen(text,'keydown',event => {
        if (event.altKey && event.key === 'ArrowDown') { event.preventDefault(); event.stopPropagation(); open(state); }
        else if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); commitText(state); }
      });
      listen(trigger,'click',() => open(state));
      listen(input,'change',() => { if (state.notifying) return; sync(state,true); if (owner === state) { const limit = bounds(state); display = dates.clamp(state.input.value || display,limit.min,limit.max); draw(); } });
      sync(state,true);
    }
    render(options);
  }
  function render(options = {}) {
    const nextLocale = options.locale ? dates.culture(options.locale).locale : locale, changed = nextLocale !== locale; locale = nextLocale;
    let redraw = changed;
    for (const state of fields.values()) {
      if (state.last !== state.input.value || state.min !== state.input.min || state.max !== state.input.max || state.disabled !== state.input.disabled || state.label !== label(state)) redraw = true;
      sync(state,changed);
    }
    if (owner && (!owner.input.isConnected || !usable(owner) || owner.input.closest('[hidden]'))) close();
    else if (owner && redraw) { const limit = bounds(owner); display = dates.clamp(display,limit.min,limit.max); const focused = popup.contains(document.activeElement); draw(focused); }
  }
  function focus(id = 'history-from') {
    const state = Array.from(fields.values()).find(field => field.input.id === id);
    if (state && !state.text.disabled) state.text.focus({preventScroll:true});
  }
  function destroy() {
    close();
    for (const remove of removers.splice(0)) remove();
    for (const state of fields.values()) { if (state.wrap.contains(state.input) && state.wrap.parentNode) state.wrap.replaceWith(state.input); if (state.type === null) state.input.removeAttribute('type'); else state.input.setAttribute('type',state.type); }
    fields.clear(); if (popup) popup.remove(); popup = null; attached = false;
  }
  return {bind,render,focus,contains,close,destroy};
})();
`;
