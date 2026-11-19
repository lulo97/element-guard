// Element Guard - popup
let rules = [];
let enabled = true;
let tabHost = '';
let filterText = '';

const $ = (id) => document.getElementById(id);
const hostMatches = (ruleHost) =>
  ruleHost === '*' || tabHost === ruleHost || (tabHost && tabHost.endsWith('.' + ruleHost));

function toast(msg, kind = '') {
  const el = $('toast');
  el.textContent = msg;
  el.className = `toast ${kind} show`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.className = 'toast'; }, 2200);
}

async function load() {
  const d = await chrome.storage.local.get(['elementRules', 'enabled']);
  rules = d.elementRules || [];
  enabled = d.enabled !== false;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabHost = new URL(tab.url).hostname.replace(/^www\./, '');
  } catch { tabHost = ''; }
  render();
}

const save = () => chrome.storage.local.set({ elementRules: rules });

function ruleItem(r, showHost) {
  const item = document.createElement('div');
  item.className = 'item';
  const main = document.createElement('div');
  main.className = 'item-main';
  const sel = document.createElement('div');
  sel.className = 'item-sel';
  sel.textContent = r.selector;
  sel.title = r.selector;
  main.appendChild(sel);
  if (showHost) {
    const h = document.createElement('div');
    h.className = 'item-host' + (r.host === '*' ? ' global' : '');
    h.textContent = r.host === '*' ? 'All sites' : r.host;
    main.appendChild(h);
  } else if (r.host === '*') {
    const h = document.createElement('div');
    h.className = 'item-host global';
    h.textContent = 'All sites';
    main.appendChild(h);
  }
  const del = document.createElement('button');
  del.className = 'del';
  del.textContent = '×';
  del.title = 'Remove rule';
  del.setAttribute('aria-label', 'Remove rule');
  del.addEventListener('click', async () => {
    rules = rules.filter(x => x.id !== r.id);
    await save();
    render();
  });
  item.append(main, del);
  return item;
}

function fillList(el, list, showHost, emptyMsg) {
  el.innerHTML = '';
  if (!list.length) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = emptyMsg;
    el.appendChild(e);
    return;
  }
  list.forEach(r => el.appendChild(ruleItem(r, showHost)));
}

function render() {
  $('masterToggle').checked = enabled;
  $('toggleLabel').textContent = enabled ? 'On' : 'Off';
  $('siteName').textContent = tabHost || 'No site on this tab';

  const siteRules = rules.filter(r => hostMatches(r.host));
  $('siteCount').textContent = siteRules.length;
  $('allCount').textContent = rules.length;
  fillList($('siteList'), siteRules, false, 'Nothing blocked here yet. Use “Pick an element”.');

  const q = filterText.toLowerCase();
  const filtered = q ? rules.filter(r => r.selector.toLowerCase().includes(q) || r.host.includes(q)) : rules;
  fillList($('allList'), [...filtered].sort((a, b) => a.host.localeCompare(b.host)), true,
           q ? 'No rules match your filter.' : 'No rules yet.');
}

// Tabs
document.querySelectorAll('.tab-btn').forEach(btn => btn.addEventListener('click', () => {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  btn.classList.add('active');
  $('panel-' + btn.dataset.tab).classList.add('active');
}));

// Master toggle
$('masterToggle').addEventListener('change', async (e) => {
  enabled = e.target.checked;
  await chrome.storage.local.set({ enabled });
  render();
  toast(enabled ? 'Blocking on' : 'Blocking paused', enabled ? 'ok' : '');
});

// Pick
$('pickBtn').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id || (tab.url && !/^(https?|file):/.test(tab.url))) {
    toast('Can’t pick on this page', 'err');
    return;
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'START_PICKER' });
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      await chrome.tabs.sendMessage(tab.id, { type: 'START_PICKER' });
    } catch {
      toast('Reload the page, then try again', 'err');
      return;
    }
  }
  window.close();
});

// Manual add
$('manualAdd').addEventListener('click', async () => {
  const selector = $('manualInput').value.trim();
  if (!selector) { toast('Enter a selector', 'err'); return; }
  try { document.createDocumentFragment().querySelector(selector); }
  catch { toast('Invalid selector', 'err'); return; }
  const host = $('manualScope').value === 'all' ? '*' : tabHost;
  if (!host) { toast('Open a website tab first', 'err'); return; }
  if (rules.some(r => r.selector === selector && r.host === host)) { toast('Rule already exists', 'err'); return; }
  rules.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), selector, host, created: Date.now() });
  await save();
  $('manualInput').value = '';
  render();
  toast('Rule added', 'ok');
});
$('manualInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('manualAdd').click(); });

$('filterInput').addEventListener('input', e => { filterText = e.target.value.trim(); render(); });

// Export / import / clear
$('exportBtn').addEventListener('click', () => {
  const data = { version: 1, exported: new Date().toISOString(), elementRules: rules };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `element-guard-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast('Rules exported', 'ok');
});

$('importBtn').addEventListener('click', () => $('importFile').click());
$('importFile').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async (ev) => {
    try {
      const data = JSON.parse(ev.target.result);
      if (!Array.isArray(data.elementRules)) throw new Error('bad format');
      let added = 0;
      for (const r of data.elementRules) {
        if (!r || typeof r.selector !== 'string' || typeof r.host !== 'string') continue;
        if (rules.some(x => x.selector === r.selector && x.host === r.host)) continue;
        rules.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
                     selector: r.selector, host: r.host, created: r.created || Date.now() });
        added++;
      }
      await save();
      render();
      toast(`Imported ${added} rule${added !== 1 ? 's' : ''}`, 'ok');
    } catch { toast('Invalid JSON file', 'err'); }
    e.target.value = '';
  };
  reader.readAsText(file);
});

$('clearBtn').addEventListener('click', async () => {
  if (!confirm('Delete ALL Element Guard rules?')) return;
  rules = [];
  await save();
  render();
  toast('All rules deleted');
});

load();
