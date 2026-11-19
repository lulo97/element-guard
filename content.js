// Element Guard - content script
// 1) Hides elements matching saved rules.  2) Provides the element picker.
(() => {
  if (window.__elementGuardLoaded) return;
  window.__elementGuardLoaded = true;

  const HOST = location.hostname.replace(/^www\./, '');
  let rules = [];
  let enabled = true;
  let styleEl = null;

  /* ---------------- Hiding ---------------- */

  function hostMatches(ruleHost) {
    return ruleHost === '*' || HOST === ruleHost || HOST.endsWith('.' + ruleHost);
  }

  function applyStyles() {
    const list = enabled ? rules.filter(r => hostMatches(r.host)) : [];
    if (!list.length) {
      if (styleEl) styleEl.remove();
      return;
    }
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'element-guard-hide-style';
    }
    // One rule per line: an invalid selector only drops its own rule.
    const css = list.map(r => `${r.selector} { display: none !important; }`).join('\n');
    if (styleEl.textContent !== css) styleEl.textContent = css;
    const root = document.documentElement || document.head;
    if (root && !styleEl.isConnected) root.appendChild(styleEl);
  }

  chrome.storage.local.get(['elementRules', 'enabled'], (d) => {
    rules = d.elementRules || [];
    enabled = d.enabled !== false;
    applyStyles();
  });

  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local') return;
    if (ch.elementRules) rules = ch.elementRules.newValue || [];
    if (ch.enabled) enabled = ch.enabled.newValue !== false;
    applyStyles();
  });

  // Re-attach our stylesheet if a page script removes it.
  if (document.documentElement) {
    new MutationObserver(() => {
      if (enabled && styleEl && !styleEl.isConnected) applyStyles();
    }).observe(document.documentElement, { childList: true });
  }

  /* ---------------- Selector generation ---------------- */

  const esc = (s) => CSS.escape(s);

  function count(sel) {
    try { return document.querySelectorAll(sel).length; } catch { return -1; }
  }

  function stableClasses(el) {
    return [...el.classList].filter(c =>
      c.length <= 40 &&
      !/\d{4,}/.test(c) &&
      !/^(hover|active|focus|focused|selected|open|opened|show|visible|loaded|loading|ng-|is-|has-|js-|eg-)/i.test(c)
    );
  }

  const isDynamicId = (id) => /\d{4,}/.test(id) || id.length > 40;

  function segment(el) {
    let s = el.tagName.toLowerCase();
    const cls = stableClasses(el).slice(0, 3);
    if (cls.length) s += cls.map(c => '.' + esc(c)).join('');
    return s;
  }

  function nth(el) {
    const p = el.parentElement;
    if (!p) return '';
    const same = [...p.children].filter(c => c.tagName === el.tagName);
    return same.length > 1 ? `:nth-of-type(${same.indexOf(el) + 1})` : '';
  }

  function buildSelector(el) {
    const tag = el.tagName.toLowerCase();

    if (el.id && !isDynamicId(el.id)) {
      const s = '#' + esc(el.id);
      if (count(s) === 1) return s;
    }

    // Ad links: block every link to the same advertiser domain.
    if (tag === 'a' && el.href) {
      try {
        const u = new URL(el.href);
        const external = /^https?:$/.test(u.protocol) && u.hostname.replace(/^www\./, '') !== HOST;
        if (external && (el.querySelector('img') || /nofollow|sponsored/i.test(el.rel))) {
          return `a[href*="${u.hostname}"]`;
        }
      } catch {}
    }

    const cls = stableClasses(el);
    if (cls.length) {
      const classPart = cls.map(c => '.' + esc(c)).join('');
      if (count(tag + classPart) === 1) return tag + classPart;
      if (count(classPart) === 1) return classPart;
      for (const c of cls) {
        const s = '.' + esc(c);
        if (count(s) === 1) return s;
      }
    }

    // Fall back to a path from the nearest unique ancestor.
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
      if (cur.id && !isDynamicId(cur.id)) { parts.unshift('#' + esc(cur.id)); break; }
      parts.unshift(segment(cur) + nth(cur));
      const sel = parts.join(' > ');
      if (count(sel) === 1) return sel;
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }

  /* ---------------- Picker ---------------- */

  let picker = null;

  function startPicker() {
    if (picker) return;
    picker = createPicker();
  }

  function createPicker() {
    const host = document.createElement('div');
    host.id = 'element-guard-ui';
    host.style.cssText =
      'all: initial !important; position: fixed !important; inset: 0 !important;' +
      'z-index: 2147483647 !important; pointer-events: none !important;';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>
        :host { font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
        * { box-sizing: border-box; }
        .box { position: fixed; pointer-events: none; border: 2px solid #f2a93b;
               background: rgba(242,169,59,.18); border-radius: 2px; transition: all .05s linear; }
        .box[hidden], .hint[hidden], .modal[hidden], .toast[hidden] { display: none; }
        .tag { position: absolute; left: -2px; top: -22px; background: #f2a93b; color: #1a1305;
               font: 600 11px/18px ui-monospace, Consolas, monospace; padding: 0 6px; border-radius: 3px;
               white-space: nowrap; max-width: 60vw; overflow: hidden; text-overflow: ellipsis; }
        .tag.below { top: auto; bottom: -22px; }
        .hint { position: fixed; top: 12px; left: 50%; transform: translateX(-50%);
                background: #14161a; color: #ece8df; border: 1px solid #3a3d44; border-radius: 999px;
                padding: 7px 16px; box-shadow: 0 6px 24px rgba(0,0,0,.35); pointer-events: none; }
        .hint b { color: #f2a93b; font-weight: 600; }
        .modal { position: fixed; right: 16px; width: 360px; max-width: calc(100vw - 32px);
                 background: #14161a; color: #ece8df; border: 1px solid #3a3d44; border-radius: 12px;
                 padding: 14px; box-shadow: 0 14px 40px rgba(0,0,0,.5); pointer-events: auto; }
        .modal.bottom { bottom: 16px; } .modal.top { top: 16px; }
        h3 { margin: 0 0 10px; font-size: 15px; font-weight: 650; }
        .preview { background: #1d2026; border: 1px solid #2d3036; border-radius: 6px; padding: 7px 9px;
                   font: 11px/1.5 ui-monospace, Consolas, monospace; color: #b9b4a7; word-break: break-all;
                   max-height: 74px; overflow: auto; margin-bottom: 10px; }
        label.lbl { display: block; font-size: 11px; color: #8d8a80; margin-bottom: 4px; }
        textarea { width: 100%; resize: vertical; min-height: 46px; background: #1d2026; color: #f6f2e8;
                   border: 1px solid #3a3d44; border-radius: 6px; padding: 7px 9px;
                   font: 12px/1.45 ui-monospace, Consolas, monospace; outline: none; }
        textarea:focus { border-color: #f2a93b; }
        .info { margin: 6px 0 10px; font-size: 12px; color: #8fd0a8; min-height: 18px; }
        .info.warn { color: #f2a93b; } .info.err { color: #ef7a6a; }
        .row { display: flex; gap: 6px; margin-bottom: 10px; }
        .scope { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; font-size: 12px; }
        .scope label { display: flex; gap: 6px; align-items: center; cursor: pointer; }
        button { font: inherit; border-radius: 7px; cursor: pointer; padding: 7px 12px;
                 border: 1px solid #3a3d44; background: #1d2026; color: #ece8df; }
        button:hover { border-color: #f2a93b; }
        button:focus-visible, textarea:focus-visible { outline: 2px solid #f2a93b; outline-offset: 1px; }
        .actions { display: flex; gap: 8px; justify-content: flex-end; }
        .primary { background: #f2a93b; border-color: #f2a93b; color: #1a1305; font-weight: 650; }
        .primary:disabled { opacity: .4; cursor: not-allowed; }
        .toast { position: fixed; bottom: 16px; right: 16px; background: #14161a; color: #ece8df;
                 border: 1px solid #3a3d44; border-radius: 10px; padding: 10px 12px; display: flex;
                 gap: 12px; align-items: center; box-shadow: 0 10px 30px rgba(0,0,0,.45); pointer-events: auto; }
        .toast button { padding: 3px 10px; }
      </style>
      <div class="box" hidden><span class="tag"></span></div>
      <div class="hint"><b>Click</b> the element you want to block &nbsp;·&nbsp; <b>Esc</b> to cancel</div>
      <div class="modal bottom" hidden>
        <h3>Block this element?</h3>
        <div class="preview" id="pv"></div>
        <label class="lbl" for="sel">CSS selector (editable)</label>
        <textarea id="sel" spellcheck="false" rows="2"></textarea>
        <div class="info" id="info"></div>
        <div class="row">
          <button id="up" title="Select the parent element">↑ Parent</button>
          <button id="down" title="Select a child element">↓ Child</button>
        </div>
        <div class="scope">
          <label><input type="radio" name="scope" value="site" checked> This site only (<span id="hostName"></span>)</label>
          <label><input type="radio" name="scope" value="all"> All sites</label>
        </div>
        <div class="actions">
          <button id="cancel">Cancel</button>
          <button id="ok" class="primary">Block</button>
        </div>
      </div>
      <div class="toast" hidden><span id="toastMsg"></span><button id="undo">Undo</button></div>
    `;
    document.documentElement.appendChild(host);

    const $ = (s) => root.querySelector(s);
    const box = $('.box'), tagEl = $('.tag'), hint = $('.hint'), modal = $('.modal');
    const pv = $('#pv'), selInput = $('#sel'), info = $('#info'), okBtn = $('#ok');
    const toastEl = $('.toast');
    $('#hostName').textContent = HOST || 'this page';

    const previewStyle = document.createElement('style');
    previewStyle.id = 'element-guard-preview-style';

    let stage = 'pick';          // 'pick' | 'confirm' | 'done'
    let target = null;
    let stack = [];              // for "Child" navigation
    let toastTimer = null;

    const inUI = (e) => e.target === host || (e.composedPath && e.composedPath().includes(host));
    const isRoot = (el) => el === document.documentElement || el === document.body;

    function describe(el) {
      let s = el.tagName.toLowerCase();
      if (el.id) s += '#' + el.id;
      const cls = [...el.classList].slice(0, 2);
      if (cls.length) s += '.' + cls.join('.');
      const r = el.getBoundingClientRect();
      return `${s}  ${Math.round(r.width)}×${Math.round(r.height)}`;
    }

    function drawBox() {
      if (!target || !target.isConnected) { box.hidden = true; return; }
      const r = target.getBoundingClientRect();
      box.hidden = false;
      box.style.left = r.left + 'px';
      box.style.top = r.top + 'px';
      box.style.width = r.width + 'px';
      box.style.height = r.height + 'px';
      tagEl.textContent = describe(target);
      tagEl.classList.toggle('below', r.top < 26);
    }

    function setTarget(el) {
      if (!el || el === host || el.nodeType !== 1) return;
      target = el;
      drawBox();
    }

    function updateInfo() {
      const sel = selInput.value.trim();
      previewStyle.textContent = '';
      okBtn.disabled = true;
      if (!sel) { info.className = 'info err'; info.textContent = 'Enter a selector.'; return; }
      let list;
      try { list = document.querySelectorAll(sel); }
      catch { info.className = 'info err'; info.textContent = 'Invalid selector.'; return; }
      if (!list.length) { info.className = 'info warn'; info.textContent = 'Matches nothing on this page.'; return; }
      if ([...list].some(isRoot)) {
        info.className = 'info err';
        info.textContent = 'This would hide the whole page. Pick something smaller.';
        return;
      }
      info.className = list.length > 1 ? 'info warn' : 'info';
      info.textContent = list.length === 1
        ? 'Matches 1 element (shown outlined on the page).'
        : `Matches ${list.length} elements (all outlined on the page).`;
      okBtn.disabled = false;
      previewStyle.textContent = `${sel} { outline: 3px solid #f2a93b !important; outline-offset: -3px !important; }`;
      if (!previewStyle.isConnected) document.documentElement.appendChild(previewStyle);
    }

    function refreshModal(regenerate = true) {
      if (!target) return;
      if (regenerate) selInput.value = buildSelector(target);
      const shell = target.cloneNode(false).outerHTML || '';
      pv.textContent = shell.length > 260 ? shell.slice(0, 260) + '…' : shell;
      updateInfo();
      const r = target.getBoundingClientRect();
      const mid = r.top + r.height / 2;
      modal.classList.toggle('top', mid > innerHeight / 2);
      modal.classList.toggle('bottom', mid <= innerHeight / 2);
    }

    function showConfirm() {
      stage = 'confirm';
      stack = [];
      hint.hidden = true;
      modal.hidden = false;
      refreshModal();
      selInput.focus({ preventScroll: true });
    }

    /* ---- page-level listeners ---- */
    const BLOCKED = ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend',
                     'dblclick', 'contextmenu', 'auxclick'];
    const opts = { capture: true, passive: false };

    function onMove(e) {
      if (stage !== 'pick' || inUI(e)) return;
      setTarget(e.target);
    }
    function onBlock(e) {
      if (inUI(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    }
    function onClick(e) {
      if (inUI(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (stage === 'done') return;
      setTarget(e.target);        // in confirm stage, clicking re-selects
      showConfirm();
    }
    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        close();
      }
    }
    const onScroll = () => drawBox();

    window.addEventListener('mousemove', onMove, opts);
    window.addEventListener('click', onClick, opts);
    BLOCKED.forEach(t => window.addEventListener(t, onBlock, opts));
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll, true);

    function detach() {
      window.removeEventListener('mousemove', onMove, opts);
      window.removeEventListener('click', onClick, opts);
      BLOCKED.forEach(t => window.removeEventListener(t, onBlock, opts));
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll, true);
    }

    function close() {
      detach();
      clearTimeout(toastTimer);
      previewStyle.remove();
      host.remove();
      picker = null;
    }

    /* ---- modal wiring ---- */
    // Keep typing inside our UI from triggering page hotkeys.
    ['keydown', 'keyup', 'keypress'].forEach(t =>
      modal.addEventListener(t, (e) => e.stopPropagation()));

    selInput.addEventListener('input', updateInfo);
    selInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!okBtn.disabled) okBtn.click(); }
    });

    $('#up').addEventListener('click', () => {
      const p = target && target.parentElement;
      if (p && p !== document.documentElement) { stack.push(target); setTarget(p); refreshModal(); }
    });
    $('#down').addEventListener('click', () => {
      const c = stack.pop() || (target && target.firstElementChild);
      if (c) { setTarget(c); refreshModal(); }
    });
    $('#cancel').addEventListener('click', close);

    okBtn.addEventListener('click', async () => {
      const selector = selInput.value.trim();
      const scope = root.querySelector('input[name="scope"]:checked').value;
      const ruleHost = scope === 'all' ? '*' : HOST;
      let n = 0;
      try { n = document.querySelectorAll(selector).length; } catch { return; }
      if (!n) return;

      const rule = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        selector, host: ruleHost, created: Date.now()
      };
      const { elementRules = [] } = await chrome.storage.local.get('elementRules');
      if (!elementRules.some(r => r.selector === selector && r.host === ruleHost)) {
        elementRules.push(rule);
        await chrome.storage.local.set({ elementRules });
      }

      stage = 'done';
      detach();
      previewStyle.remove();
      box.hidden = true;
      modal.hidden = true;
      hint.hidden = true;
      $('#toastMsg').textContent = `Blocked ${n} element${n > 1 ? 's' : ''}.`;
      toastEl.hidden = false;

      $('#undo').onclick = async () => {
        const d = await chrome.storage.local.get('elementRules');
        await chrome.storage.local.set({
          elementRules: (d.elementRules || []).filter(r => !(r.selector === selector && r.host === ruleHost))
        });
        close();
      };
      toastTimer = setTimeout(close, 6000);
    });

    return { close };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'START_PICKER') { startPicker(); sendResponse({ ok: true }); }
    else if (msg && msg.type === 'PING') sendResponse({ ok: true });
  });
})();
