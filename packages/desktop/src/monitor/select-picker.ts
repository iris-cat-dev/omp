/** Windows CurrencyTable.Search: code prefix, then localized/English/symbol word starts. */
export function currencySearchRank(
  query: string,
  currency: {
    code: string;
    name: string;
    englishName: string;
    symbol: string;
    alternateSymbol?: string;
  },
): number {
  const fold = (value: string) => value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
  const needle = fold(query.trim());
  if (!needle) return 0;
  if (fold(currency.code).startsWith(needle)) return 0;
  for (const value of [
    currency.name,
    currency.englishName,
    currency.symbol,
    currency.alternateSymbol || "",
  ]) {
    const text = fold(value);
    for (let index = 0; index <= text.length - needle.length; index++) {
      if (
        (index === 0 ||
          !/[\p{L}\p{N}\p{Mc}]/u.test(text[index - 1]!) ||
          /[\u2e80-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/u.test(text[index]!)) &&
        text.startsWith(needle, index)
      )
        return 1;
    }
  }
  return -1;
}

// Keep native select values, labels and change handlers; only the popup is in-document.
// mini-electron's separate Blink page-popup widget may block its renderer compositor.
export const MONITOR_SELECT_PICKER_SCRIPT = String.raw`
const monitorSelectPicker = (() => {
  let popup = null, owner = null, rows = [], active = -1, search = '', searchAt = 0, searchInput = null, currencyList = null, empty = null, clearSearch = null, pointerX = null, pointerY = null;
  const currencySearchRank = ${currencySearchRank.toString()};
  const popupId = 'monitor-select-picker';
  const installed = new WeakSet();
  const enabled = option => !option.disabled && !(option.parentElement.tagName === 'OPTGROUP' && option.parentElement.disabled);
  const label = option => option.label || option.textContent;
  function changed(select, index) {
    if (select.disabled || index < 0 || index >= select.options.length || !enabled(select.options[index])) return;
    const previous = select.selectedIndex; select.selectedIndex = index;
    if (previous !== select.selectedIndex) {
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }
  function close(restoreFocus = false) {
    if (!owner) return false;
    const fade = !!searchInput;
    const select = owner; owner = null; rows = []; active = -1; search = ''; searchAt = 0; searchInput = currencyList = empty = clearSearch = null; pointerX = pointerY = null;
    monitorPopupMotion.hide(popup,fade,() => { if (!owner) popup.replaceChildren(); });
    select.setAttribute('aria-expanded', 'false'); select.removeAttribute('aria-activedescendant');
    if (restoreFocus && select.isConnected && !select.disabled) select.focus({ preventScroll: true });
    return true;
  }
  function activate(index, scroll = true) {
    if (!owner || index < 0 || index >= rows.length || rows[index].button.disabled || rows[index].button.hidden) return;
    if (active !== index) {
      if (active >= 0) { rows[active].button.dataset.active = 'false'; if (searchInput) rows[active].button.setAttribute('aria-selected','false'); }
      active = index; rows[index].button.dataset.active = 'true'; if (searchInput) rows[index].button.setAttribute('aria-selected','true');
      owner.setAttribute('aria-activedescendant', rows[index].button.id);
      if (searchInput) searchInput.setAttribute('aria-activedescendant',rows[index].button.id);
    }
    if (scroll) rows[index].button.scrollIntoView({ block: 'nearest' });
  }
  function nextIndex(select, start, direction) {
    for (let index = start + direction; index >= 0 && index < select.options.length; index += direction) {
      if (enabled(select.options[index])) return index;
    }
    return start;
  }
  function currencyRows(query, initial = false) {
    const ranked = rows.map((row,index) => ({...row,index,rank:currencySearchRank(query,{code:row.option.value,name:row.option.dataset.localizedName || label(row.option),englishName:row.option.dataset.englishName || '',symbol:row.option.dataset.symbol || '',alternateSymbol:row.option.dataset.alternateSymbol || ''})})).filter(row => row.rank >= 0).sort((a,b) => a.rank-b.rank || a.index-b.index);
    const fragment = document.createDocumentFragment(); let group = '';
    for (const row of rows) row.button.hidden = true;
    for (const row of ranked) {
      const title = row.option.parentElement.tagName === 'OPTGROUP' ? row.option.parentElement.label : '';
      if (!query.trim() && title && title !== group) { const header = document.createElement('div'); header.className = 'monitor-currency-group'; header.setAttribute('role','presentation'); header.textContent = title; fragment.append(header); group = title; }
      row.button.hidden = false; fragment.append(row.button);
    }
    currencyList.replaceChildren(fragment); empty.hidden = ranked.length > 0; clearSearch.hidden = !query;
    if (active >= 0) { rows[active].button.dataset.active = 'false'; rows[active].button.setAttribute('aria-selected','false'); } active = -1;
    owner.removeAttribute('aria-activedescendant'); searchInput.removeAttribute('aria-activedescendant');
    const chosen = initial ? ranked.find(row => row.index === owner.selectedIndex && !row.button.disabled) : null;
    const first = chosen || ranked.find(row => !row.button.disabled); if (first) activate(first.index);
  }
  function nextVisibleIndex(start,direction) {
    const shown = currencyList ? Array.from(currencyList.querySelectorAll('.monitor-select-option')).map(button => Number(button.dataset.index)) : rows.map((_,index) => index);
    let position = shown.indexOf(start); if (position < 0) position = direction > 0 ? -1 : shown.length;
    for (position += direction; position >= 0 && position < shown.length; position += direction) { const index = shown[position]; if (!rows[index].button.disabled) return index; }
    return start;
  }
  function position() {
    const rect = owner.getBoundingClientRect(), inset = 8, gap = 4;
    popup.style.width = Math.min(searchInput ? 320 : Math.max(rect.width,140),window.innerWidth-inset*2)+'px';
    const width = popup.offsetWidth || parseFloat(popup.style.width);
    popup.style.left = Math.max(inset, Math.min(searchInput ? rect.right-width : rect.left,window.innerWidth-width-inset))+'px';
    const below = Math.max(0, window.innerHeight - rect.bottom - gap - inset), above = Math.max(0, rect.top - gap - inset);
    const down = below >= Math.min(200, popup.scrollHeight) || below >= above;
    popup.style.maxHeight = Math.max(1,Math.min(searchInput ? 400 : 320,down ? below : above))+'px';
    popup.style.top = (down ? rect.bottom + gap : Math.max(inset, rect.top - gap - popup.offsetHeight)) + 'px';
  }
  function ensurePopup() {
    if (popup) return;
    popup = document.createElement('div'); popup.id = popupId; popup.className = 'monitor-select-popup scroll';
    popup.setAttribute('role', 'listbox'); popup.hidden = true;
    popup.addEventListener('pointerdown',event => { if (!event.target.closest('input')) event.preventDefault(); });
    popup.addEventListener('pointermove', event => {
      if (searchInput) { if (event.clientX === pointerX && event.clientY === pointerY) return; pointerX = event.clientX; pointerY = event.clientY; }
      const button = event.target.closest('.monitor-select-option');
      if (button && popup.contains(button)) activate(Number(button.dataset.index), false);
    });
    popup.addEventListener('click', event => {
      const button = event.target.closest('.monitor-select-option');
      if (!owner || !button || button.disabled || !popup.contains(button)) return;
      const select = owner, index = Number(button.dataset.index), option = rows[index].option;
      if (select.options[index] !== option || !enabled(option)) { close(true); return; }
      close(true); changed(select, index);
    });
    popup.addEventListener('keydown',event => {
      if (owner && searchInput && event.target !== searchInput && ['ArrowUp','ArrowDown','Home','End','PageUp','PageDown','Enter',' ','Escape','Tab'].includes(event.key)) keydown(owner,event);
    });
    document.body.append(popup);
    document.addEventListener('pointerdown', event => {
      if (owner && !owner.contains(event.target) && !popup.contains(event.target)) close();
    }, { capture: true });
    document.addEventListener('focusin', event => {
      if (owner && event.target !== owner && !popup.contains(event.target)) close();
    });
    document.addEventListener('scroll', event => {
      if (owner && event.target !== popup && !popup.contains(event.target)) close();
    }, { capture: true, passive: true });
    document.addEventListener('visibilitychange', () => { if (document.hidden) close(); });
    window.addEventListener('blur', () => close());
    window.addEventListener('resize', () => close());
    window.addEventListener('pagehide', () => close());
  }
  function open(select) {
    if (select.disabled || !select.options.length) return;
    if (owner === select) { close(true); return; }
    close(); ensurePopup(); owner = select; search = ''; searchAt = 0;
    const searchable = select.dataset.searchable === 'true';
    select.setAttribute('aria-haspopup',searchable ? 'dialog' : 'listbox');
    popup.classList.toggle('monitor-currency-popup',searchable); popup.setAttribute('role',searchable ? 'dialog' : 'listbox');
    popup.setAttribute('aria-label',select.getAttribute('aria-label') || select.name || select.id); popup.setAttribute('aria-labelledby',select.id);
    const style = getComputedStyle(select); popup.style.font = style.font;
    const fragment = document.createDocumentFragment();
    rows = Array.from(select.options, (option, index) => {
      const button = document.createElement('button'); button.type = 'button'; button.tabIndex = -1;
      button.id = popupId + '-option-' + index; button.className = 'monitor-select-option';
      button.setAttribute('role', 'option'); button.setAttribute('aria-selected', String(!searchable && index === select.selectedIndex));
      button.dataset.value = option.value; button.dataset.index = String(index); button.dataset.current = String(index === select.selectedIndex); button.disabled = !enabled(option);
      if (searchable) button.setAttribute('aria-current',String(index === select.selectedIndex));
      const check = document.createElement('span'); check.className = 'symbol monitor-select-check';
      check.setAttribute('aria-hidden', 'true'); check.textContent = '\uE73E';
      if (searchable) {
        const code = document.createElement('span'); code.className = 'monitor-currency-code'; code.textContent = option.value;
        const name = document.createElement('span'); name.className = 'monitor-currency-name'; name.textContent = option.dataset.localizedName || label(option);
        const symbol = document.createElement('span'); symbol.className = 'monitor-currency-symbol'; symbol.textContent = option.dataset.symbol || '';
        button.append(check,code,name,symbol);
      } else { const text = document.createElement('span'); text.className = 'monitor-select-label'; text.textContent = label(option); button.append(check,text); }
      button.title = label(option); fragment.append(button); return {option,button};
    });
    if (searchable) {
      const header = document.createElement('div'); header.className = 'monitor-currency-search';
      searchInput = document.createElement('input'); searchInput.id = 'monitor-currency-search'; searchInput.type = 'text'; searchInput.maxLength = 40; searchInput.placeholder = select.dataset.searchLabel || ''; searchInput.setAttribute('aria-label',searchInput.placeholder); searchInput.setAttribute('role','combobox'); searchInput.setAttribute('aria-expanded','true'); searchInput.setAttribute('aria-autocomplete','list'); searchInput.setAttribute('aria-controls',popupId+'-list');
      const icon = document.createElement('span'); icon.className = 'symbol'; icon.textContent = '\uE721'; icon.setAttribute('aria-hidden','true');
      clearSearch = document.createElement('button'); clearSearch.type = 'button'; clearSearch.className = 'subtle symbol'; clearSearch.textContent = '\uE711'; clearSearch.tabIndex = -1; clearSearch.setAttribute('aria-label',select.dataset.clearLabel || ''); clearSearch.addEventListener('click',() => { searchInput.value = ''; currencyRows(''); searchInput.focus(); });
      header.append(searchInput,icon,clearSearch);
      currencyList = document.createElement('div'); currencyList.id = popupId+'-list'; currencyList.className = 'monitor-currency-list scroll'; currencyList.setAttribute('role','listbox'); currencyList.setAttribute('aria-label',select.getAttribute('aria-label') || select.id);
      empty = document.createElement('p'); empty.className = 'monitor-currency-empty'; empty.textContent = select.dataset.emptyLabel || ''; empty.setAttribute('role','status');
      popup.replaceChildren(header,currencyList,empty); currencyRows('',true);
      searchInput.addEventListener('input',() => currencyRows(searchInput.value));
      searchInput.addEventListener('keydown',event => { if (['ArrowUp','ArrowDown','PageUp','PageDown','Enter','Escape','Tab'].includes(event.key)) keydown(select,event); });
    } else popup.replaceChildren(fragment);
    popup.style.visibility = 'hidden'; monitorPopupMotion.show(popup,!!searchInput); select.setAttribute('aria-expanded','true');
    if (searchInput) searchInput.focus({preventScroll:true}); else select.focus({preventScroll:true});
    position(); popup.style.visibility = '';
    if (!searchInput) { const initial = select.selectedIndex >= 0 && enabled(select.options[select.selectedIndex]) ? select.selectedIndex : nextIndex(select,-1,1); activate(initial); }
    else if (active >= 0) { const row = rows[active].button,viewport = currencyList.getBoundingClientRect(),bounds = row.getBoundingClientRect(); currencyList.scrollTop = Math.max(0,bounds.top-viewport.top+currencyList.scrollTop-(currencyList.clientHeight-bounds.height)/2); }
  }
  function keydown(select,event) {
    const opened = owner === select, key = event.key;
    if (key === 'Tab') {
      if (opened && searchInput) { event.preventDefault(); event.stopPropagation(); const row = active >= 0 ? rows[active].button : null; if (event.target === searchInput && row && !row.disabled && !row.hidden) row.focus({preventScroll:true}); else searchInput.focus({preventScroll:true}); }
      else if (opened) close();
      return;
    }
    if (key === 'Escape') {
      if (opened) { event.preventDefault(); event.stopPropagation(); close(true); }
      return;
    }
    if ((key === 'F4' && !event.altKey) || (event.altKey && (key === 'ArrowDown' || key === 'ArrowUp')) || key === ' ' || key === 'Enter') {
      event.preventDefault(); event.stopPropagation();
      if (opened) { const index = active; if (searchInput && index < 0 && key === 'Enter') return; close(true); if (key === 'Enter' || key === ' ') changed(select,index); }
      else open(select);
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    let index = opened ? active : select.selectedIndex;
    if (key === 'ArrowDown' || key === 'ArrowUp') index = opened ? nextVisibleIndex(index,key === 'ArrowDown' ? 1 : -1) : nextIndex(select,index,key === 'ArrowDown' ? 1 : -1);
    else if (key === 'Home') index = opened ? nextVisibleIndex(-1,1) : nextIndex(select,-1,1);
    else if (key === 'End') index = opened ? nextVisibleIndex(-1,-1) : nextIndex(select,select.options.length,-1);
    else if (key === 'PageDown' || key === 'PageUp') {
      const direction = key === 'PageDown' ? 1 : -1;
      for (let count = 0; count < 8; count++) index = opened ? nextVisibleIndex(index,direction) : nextIndex(select,index,direction);
    } else if (key.length === 1) {
      const now = performance.now(), character = key.toLocaleLowerCase();
      search = now - searchAt > 750 ? character : search + character; searchAt = now;
      if (search.length > 1 && Array.from(search).every(value => value === character)) search = character;
      let found = -1;
      for (let offset = 1; offset <= select.options.length; offset++) {
        const candidate = (index + offset + select.options.length) % select.options.length, option = select.options[candidate];
        if (enabled(option) && label(option).trim().toLocaleLowerCase().startsWith(search)) { found = candidate; break; }
      }
      if (found >= 0) index = found;
    } else return;
    event.preventDefault(); event.stopPropagation();
    if (opened) { activate(index); if (searchInput && event.target !== searchInput && active >= 0) rows[active].button.focus({preventScroll:true}); } else changed(select,index);
  }
  // Reuse this picker for dynamically mounted sections without rebinding existing selects.
  function install(root = document) {
    if (owner && !owner.isConnected) close();
    for (const select of root.querySelectorAll('select')) {
      if (installed.has(select)) continue;
      installed.add(select);
      select.setAttribute('aria-haspopup',select.dataset.searchable === 'true' ? 'dialog' : 'listbox'); select.setAttribute('aria-controls', popupId); select.setAttribute('aria-expanded', 'false');
      select.addEventListener('mousedown', event => {
        if (event.button !== 0) return;
        event.preventDefault(); if (!select.disabled) open(select);
      });
      select.addEventListener('click', event => {
        event.preventDefault(); if (event.detail === 0 && !select.disabled) open(select);
      });
      select.addEventListener('keydown', event => keydown(select, event));
      select.addEventListener('keypress', event => {
        if (event.key === ' ' || event.key === 'Enter') event.preventDefault();
      });
      select.addEventListener('focus', () => { search = ''; searchAt = 0; });
    }
  }
  return { install, close };
})();
`;
