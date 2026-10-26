// Keep native select values, labels and change handlers; only the popup is in-document.
// mini-electron's separate Blink page-popup widget may block its renderer compositor.
export const MONITOR_SELECT_PICKER_SCRIPT = String.raw`
const monitorSelectPicker = (() => {
  let popup = null, owner = null, rows = [], active = -1, search = '', searchAt = 0;
  const popupId = 'monitor-select-picker';
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
    const select = owner; owner = null; rows = []; active = -1; search = ''; searchAt = 0;
    popup.hidden = true; popup.replaceChildren();
    select.setAttribute('aria-expanded', 'false'); select.removeAttribute('aria-activedescendant');
    if (restoreFocus && select.isConnected && !select.disabled) select.focus({ preventScroll: true });
    return true;
  }
  function activate(index, scroll = true) {
    if (!owner || index < 0 || index >= rows.length || rows[index].button.disabled) return;
    if (active !== index) {
      if (active >= 0) rows[active].button.dataset.active = 'false';
      active = index; rows[index].button.dataset.active = 'true';
      owner.setAttribute('aria-activedescendant', rows[index].button.id);
    }
    if (scroll) rows[index].button.scrollIntoView({ block: 'nearest' });
  }
  function nextIndex(select, start, direction) {
    for (let index = start + direction; index >= 0 && index < select.options.length; index += direction) {
      if (enabled(select.options[index])) return index;
    }
    return start;
  }
  function position() {
    const rect = owner.getBoundingClientRect(), inset = 8, gap = 4;
    popup.style.width = Math.min(Math.max(rect.width, 140), window.innerWidth - inset * 2) + 'px';
    popup.style.left = Math.max(inset, Math.min(rect.left, window.innerWidth - popup.offsetWidth - inset)) + 'px';
    const below = Math.max(0, window.innerHeight - rect.bottom - gap - inset), above = Math.max(0, rect.top - gap - inset);
    const down = below >= Math.min(200, popup.scrollHeight) || below >= above;
    popup.style.maxHeight = Math.max(1, Math.min(320, down ? below : above)) + 'px';
    popup.style.top = (down ? rect.bottom + gap : Math.max(inset, rect.top - gap - popup.offsetHeight)) + 'px';
  }
  function ensurePopup() {
    if (popup) return;
    popup = document.createElement('div'); popup.id = popupId; popup.className = 'monitor-select-popup scroll';
    popup.setAttribute('role', 'listbox'); popup.hidden = true;
    popup.addEventListener('pointerdown', event => event.preventDefault());
    popup.addEventListener('pointermove', event => {
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
    popup.setAttribute('aria-label', select.getAttribute('aria-label') || select.name || select.id);
    popup.setAttribute('aria-labelledby', select.id);
    const style = getComputedStyle(select); popup.style.font = style.font;
    const fragment = document.createDocumentFragment();
    rows = Array.from(select.options, (option, index) => {
      const button = document.createElement('button'); button.type = 'button'; button.tabIndex = -1;
      button.id = popupId + '-option-' + index; button.className = 'monitor-select-option';
      button.setAttribute('role', 'option'); button.setAttribute('aria-selected', String(index === select.selectedIndex));
      button.dataset.value = option.value; button.dataset.index = String(index); button.disabled = !enabled(option);
      const check = document.createElement('span'); check.className = 'symbol monitor-select-check';
      check.setAttribute('aria-hidden', 'true'); check.textContent = '\uE73E';
      const text = document.createElement('span'); text.className = 'monitor-select-label'; text.textContent = label(option);
      button.title = label(option); button.append(check, text); fragment.append(button); return { option, button };
    });
    popup.replaceChildren(fragment); popup.style.visibility = 'hidden'; popup.hidden = false;
    select.setAttribute('aria-expanded', 'true'); select.focus({ preventScroll: true });
    position(); popup.style.visibility = '';
    const initial = select.selectedIndex >= 0 && enabled(select.options[select.selectedIndex]) ? select.selectedIndex : nextIndex(select, -1, 1);
    activate(initial);
  }
  function keydown(select, event) {
    const opened = owner === select, key = event.key;
    if (key === 'Tab') { if (opened) close(); return; }
    if (key === 'Escape') {
      if (opened) { event.preventDefault(); event.stopPropagation(); close(true); }
      return;
    }
    if ((key === 'F4' && !event.altKey) || (event.altKey && (key === 'ArrowDown' || key === 'ArrowUp')) || key === ' ' || key === 'Enter') {
      event.preventDefault(); event.stopPropagation();
      if (opened) { const index = active; close(true); if (key === 'Enter' || key === ' ') changed(select, index); }
      else open(select);
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    let index = opened ? active : select.selectedIndex;
    if (key === 'ArrowDown' || key === 'ArrowUp') index = nextIndex(select, index, key === 'ArrowDown' ? 1 : -1);
    else if (key === 'Home') index = nextIndex(select, -1, 1);
    else if (key === 'End') index = nextIndex(select, select.options.length, -1);
    else if (key === 'PageDown' || key === 'PageUp') {
      const direction = key === 'PageDown' ? 1 : -1;
      for (let count = 0; count < 8; count++) index = nextIndex(select, index, direction);
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
    if (opened) activate(index); else changed(select, index);
  }
  function install() {
    for (const select of document.querySelectorAll('select')) {
      select.setAttribute('aria-haspopup', 'listbox'); select.setAttribute('aria-controls', popupId); select.setAttribute('aria-expanded', 'false');
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
