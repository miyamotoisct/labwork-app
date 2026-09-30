'use strict';

/* ===== ユーティリティ ===== */
const $ = (sel, el = document) => el.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
const nowISO = () => new Date().toISOString();
const fmtDate = iso => iso ? new Date(iso).toLocaleString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
const fmtSize = n => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
const clone = o => JSON.parse(JSON.stringify(o));
const MAX_FILE_SIZE = 50 * 1024 * 1024;

const CONN_KEY = 'gyomu.conn';
function loadConn() {
  try {
    const c = JSON.parse(localStorage.getItem(CONN_KEY) || 'null');
    if (c && typeof c === 'object') return c;
  } catch (_) {}
  const d = window.APP_CONFIG || {};
  return { mode: d.mode || 'gas', gasUrl: d.gasUrl || '', password: '', owner: d.owner || '', repo: d.repo || '', branch: d.branch || 'main', token: '' };
}
function saveConn(c) { localStorage.setItem(CONN_KEY, JSON.stringify(c)); }
function connReady(c) {
  if (c.mode === 'local') return true;
  if (c.mode === 'github') return !!(c.owner && c.repo && c.token);
  return !!(c.gasUrl && c.password);
}
function makeStore(c) {
  if (c.mode === 'local') return new Store(new LocalBackend());
  if (c.mode === 'github') return new Store(new GitHubBackend(c));
  return new GasStore(c);
}
function connMissingMessage(c) {
  if (c.mode === 'github') return 'オーナー・リポジトリ名・トークンをすべて入力してください';
  return 'Web アプリの URL とパスワードを入力してください';
}

let toastTimer;
function toast(msg, kind = 'info') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'show ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, kind === 'error' ? 5000 : 2500);
}

/* ===== 状態 ===== */
const state = {
  conn: loadConn(),
  connDraft: null,
  store: null,
  settings: null,
  index: null,
  draft: null,          // 設定画面での編集中データ
  view: null,
  category: 'purchase',
  filter: 'active',
  search: '',
  project: null,
  activeSection: null,
  saveTimer: null,
  saving: false,
  pendingSave: false,
  dirty: new Set(),     // 未保存の変更（項目ID / 'title' / 'memo' / 'status' / '*'）
  saveStatus: '',
  lastRefresh: 0,
};

/* ===== 起動 ===== */
document.addEventListener('DOMContentLoaded', init);

async function init() {
  const app = $('#app');
  app.addEventListener('input', onInput);
  app.addEventListener('change', onChange);
  app.addEventListener('click', onClick);
  app.addEventListener('submit', onSubmit);
  window.addEventListener('hashchange', route);
  window.addEventListener('focus', () => { if (Date.now() - state.lastRefresh > 15000) refresh(false); });
  window.addEventListener('beforeunload', e => {
    if (state.dirty.size || state.saveTimer || state.saving || state.settingsSaveTimer || state.settingsSaving) { e.preventDefault(); e.returnValue = ''; }
  });
  $('#btn-refresh').addEventListener('click', () => refresh(true));
  app.innerHTML = '<p class="help">読み込み中…</p>';
  await connect();
  route();
}

async function connect() {
  state.store = null; state.settings = null; state.index = null; state.draft = null;
  updateConnBadge();
  if (!connReady(state.conn)) return false;
  const store = makeStore(state.conn);
  try {
    const [settings, index] = await Promise.all([store.loadSettings(), store.loadIndex()]);
    state.store = store; state.settings = settings; state.index = index;
    state.lastRefresh = Date.now();
    updateConnBadge();
    return true;
  } catch (e) {
    toast('接続に失敗しました: ' + e.message, 'error');
    updateConnBadge();
    return false;
  }
}

function updateConnBadge() {
  const b = $('#conn-badge');
  if (state.store) { b.textContent = state.store.label; b.className = 'badge ok'; }
  else { b.textContent = '未接続'; b.className = 'badge'; }
}

/* ===== ルーティング ===== */
async function route() {
  if (state.saveTimer) { clearTimeout(state.saveTimer); state.saveTimer = null; await saveNow(); }
  if (state.settingsSaveTimer) { clearTimeout(state.settingsSaveTimer); state.settingsSaveTimer = null; await saveSettingsNow(); }
  const h = location.hash || '#/';
  let m;
  if (h === '#/settings') { state.project = null; return renderSettings(); }
  if (!state.store) { state.project = null; return renderConnectPrompt(); }
  if ((m = h.match(/^#\/p\/([\w-]+)$/))) return openProject(m[1]);
  if ((m = h.match(/^#\/c\/(\w+)$/)) && CATEGORIES.some(c => c.id === m[1])) state.category = m[1];
  state.project = null;
  renderList();
}

async function refresh(manual) {
  if (!state.store) return;
  state.lastRefresh = Date.now();
  try {
    if (state.view === 'project' && state.project) {
      if (state.dirty.size || state.saveTimer || state.saving) return;
      const p = await state.store.loadProject(state.project.id);
      if (!p) { toast('このプロジェクトは削除されています', 'error'); location.hash = '#/c/' + state.project.category; return; }
      if (p.updatedAt !== state.project.updatedAt) {
        state.project = p; renderProject();
        if (manual) toast('最新の状態を読み込みました');
      } else if (manual) toast('最新の状態です');
    } else {
      const [settings, index] = await Promise.all([state.store.loadSettings(), state.store.loadIndex()]);
      state.settings = settings; state.index = index;
      if (state.view === 'list') renderList();
      if (manual) toast('最新の状態を読み込みました');
    }
  } catch (e) {
    toast('読み込みに失敗しました: ' + e.message, 'error');
  }
}

/* ===== 未接続画面 ===== */
function renderConnectPrompt() {
  state.view = 'connect';
  $('#app').innerHTML = `
    <section class="panel center">
      <h2>ようこそ</h2>
      <p class="help">はじめに「設定」でデータの保存先（Web アプリの URL とパスワード）を登録してください。</p>
      <a href="#/settings" class="btn primary">設定を開く</a>
    </section>`;
}

/* ===== 一覧画面 ===== */
function renderList() {
  state.view = 'list';
  const tabs = CATEGORIES.map(c => {
    const n = state.index.projects.filter(p => p.category === c.id && p.status !== 'done').length;
    return `<a class="tab ${c.id === state.category ? 'active' : ''}" href="#/c/${c.id}">${esc(c.name)}<span class="count">${n}</span></a>`;
  }).join('');
  $('#app').innerHTML = `
    <nav class="tabs">${tabs}</nav>
    <div class="toolbar">
      <form id="new-project" class="inline-form">
        <input name="title" placeholder="新しいプロジェクト名（例: ○○の購入、○○学会）" required autocomplete="off">
        <button class="btn primary">＋ 作成</button>
      </form>
      <div class="filters">
        <select id="filter">
          <option value="active" ${state.filter === 'active' ? 'selected' : ''}>進行中</option>
          <option value="done" ${state.filter === 'done' ? 'selected' : ''}>完了</option>
          <option value="all" ${state.filter === 'all' ? 'selected' : ''}>すべて</option>
        </select>
        <input id="search" type="search" placeholder="検索" value="${esc(state.search)}">
      </div>
    </div>
    <div class="cards" id="cards"></div>`;
  renderCards();
}

function renderCards() {
  let list = state.index.projects.filter(p => p.category === state.category);
  if (state.filter === 'active') list = list.filter(p => p.status !== 'done');
  else if (state.filter === 'done') list = list.filter(p => p.status === 'done');
  const q = state.search.trim().toLowerCase();
  if (q) list = list.filter(p => (p.title || '').toLowerCase().includes(q));
  list.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  $('#cards').innerHTML = list.length ? list.map(cardHTML).join('') : '<p class="empty">プロジェクトはありません</p>';
}

function cardHTML(p) {
  const pct = p.total ? Math.round(p.done / p.total * 100) : 0;
  return `
    <a class="card ${p.status === 'done' ? 'done' : ''}" href="#/p/${p.id}">
      <div class="card-title">${esc(p.title)}</div>
      <div class="progress"><div style="width:${pct}%"></div></div>
      <div class="card-meta">
        <span>${p.done}/${p.total} 完了</span>
        <span>${fmtDate(p.updatedAt)}</span>
        ${p.status === 'done' ? '<span class="badge done">完了</span>' : ''}
      </div>
    </a>`;
}

async function createProject(title) {
  const tpl = state.settings.templates[state.category] || DEFAULT_TEMPLATES[state.category];
  const p = {
    id: uid(), category: state.category, title, status: 'active',
    createdAt: nowISO(), updatedAt: nowISO(), memo: '',
    sections: tpl.map(s => ({ id: uid(), name: s.name, items: s.items.map(i => newItem(i.label, i.type)) })),
  };
  try {
    await persistProject(p);
    location.hash = '#/p/' + p.id;
  } catch (e) {
    toast('作成に失敗しました: ' + e.message, 'error');
  }
}

function newItem(label, type) { return { id: uid(), label, type, value: defaultValue(type) }; }

/* ===== プロジェクト画面 ===== */
async function openProject(id) {
  try {
    const p = await state.store.loadProject(id);
    if (!p) { toast('プロジェクトが見つかりません', 'error'); location.hash = '#/'; return; }
    state.project = p;
    state.dirty.clear();
    state.saveStatus = '';
    if (!p.sections.some(s => s.id === state.activeSection)) state.activeSection = p.sections[0] && p.sections[0].id;
    state.category = p.category;
    renderProject();
  } catch (e) {
    toast('読み込みに失敗しました: ' + e.message, 'error');
  }
}

function progressOf(p) {
  let done = 0, total = 0;
  for (const s of p.sections) for (const it of s.items) { total++; if (isDone(it)) done++; }
  return { done, total };
}
const secDone = s => s.items.filter(isDone).length;
function currentSection() {
  const p = state.project;
  return p.sections.find(s => s.id === state.activeSection) || p.sections[0];
}
function findItem(id) {
  for (const s of state.project.sections) for (const it of s.items) if (it.id === id) return it;
  return null;
}

function renderProject() {
  state.view = 'project';
  const p = state.project;
  const cat = CATEGORIES.find(c => c.id === p.category) || { name: p.category };
  const prog = progressOf(p);
  const pct = prog.total ? Math.round(prog.done / prog.total * 100) : 0;
  const sec = currentSection();
  if (sec) state.activeSection = sec.id;
  const typeOpts = Object.entries(ITEM_TYPES).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');

  $('#app').innerHTML = `
    <div class="project-head">
      <a href="#/c/${p.category}" class="back">← ${esc(cat.name)} の一覧へ</a>
      <div class="title-row">
        <input id="p-title" class="title-input" value="${esc(p.title)}" placeholder="タイトル">
        <span id="save-status" class="save-status">${esc(state.saveStatus)}</span>
      </div>
      <div class="head-actions">
        <span class="progress-text" id="p-progress-text">${prog.done}/${prog.total} 完了</span>
        <div class="progress"><div id="p-progress" style="width:${pct}%"></div></div>
        <button id="btn-status" class="btn">${p.status === 'done' ? '進行中に戻す' : '✓ 完了にする'}</button>
        <button id="btn-delete" class="btn ghost danger">削除</button>
      </div>
    </div>
    <nav class="tabs sub">
      ${p.sections.map(s => `<button class="tab ${sec && s.id === sec.id ? 'active' : ''}" data-sec="${s.id}">${esc(s.name)}<span class="count">${secDone(s)}/${s.items.length}</span></button>`).join('')}
      <button class="tab add" id="btn-add-section" title="タブを追加">＋</button>
    </nav>
    ${sec ? `
    <section class="items">
      ${sec.items.map((it, i) => itemHTML(it, i, sec.items.length)).join('')}
      <form id="add-item" class="add-item">
        <input name="label" placeholder="追加する項目名" required autocomplete="off">
        <select name="type">${typeOpts}</select>
        <button class="btn">＋ 項目を追加</button>
      </form>
      <div class="section-actions">
        <button id="btn-rename-section" class="btn ghost small">タブ名を変更</button>
        ${p.sections.length > 1 ? '<button id="btn-delete-section" class="btn ghost small danger">このタブを削除</button>' : ''}
      </div>
    </section>` : '<p class="empty">タブがありません。「＋」でタブを追加してください。</p>'}
    <section class="memo">
      <label for="p-memo">メモ・連絡事項</label>
      <textarea id="p-memo" placeholder="連絡事項などを自由に記入できます">${esc(p.memo)}</textarea>
    </section>`;
}

function itemHTML(it, i, n) {
  return `
    <div class="item ${isDone(it) ? 'done' : ''}" data-id="${it.id}">
      <div class="item-head">
        <span class="check">${isDone(it) ? '✓' : ''}</span>
        <input class="item-label" value="${esc(it.label)}" title="クリックして名称を変更" placeholder="項目名">
        <span class="type-name">${esc(ITEM_TYPES[it.type] || it.type)}</span>
        <div class="item-tools">
          <button type="button" data-act="up" title="上へ" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button type="button" data-act="down" title="下へ" ${i === n - 1 ? 'disabled' : ''}>↓</button>
          <button type="button" data-act="del" class="danger" title="項目を削除">×</button>
        </div>
      </div>
      <div class="item-body">${controlHTML(it)}</div>
    </div>`;
}

function controlHTML(it) {
  const v = it.value || (it.value = defaultValue(it.type));
  switch (it.type) {
    case 'check':
      return `<label class="chk"><input type="checkbox" data-f="checked" ${v.checked ? 'checked' : ''}> 完了</label>`;
    case 'yes_no':
      return `<div class="radios">
        <label><input type="radio" name="r-${it.id}" data-f="answer" value="yes" ${v.answer === 'yes' ? 'checked' : ''}> 有</label>
        <label><input type="radio" name="r-${it.id}" data-f="answer" value="no" ${v.answer === 'no' ? 'checked' : ''}> 無</label>
      </div>`;
    case 'text':
      return `<input type="text" data-f="text" value="${esc(v.text)}" placeholder="入力してください">`;
    case 'textarea':
      return `<textarea data-f="text" rows="4" placeholder="入力してください">${esc(v.text)}</textarea>`;
    case 'schedule':
    case 'daterange':
      return `<div class="dates">
        <label>出発日<input type="date" data-f="start" value="${esc(v.start)}"></label>
        <label>帰学日<input type="date" data-f="end" value="${esc(v.end)}" ${v.dayTrip ? 'disabled' : ''}></label>
        ${it.type === 'schedule' ? `<label class="chk"><input type="checkbox" data-f="dayTrip" ${v.dayTrip ? 'checked' : ''}> 日帰り</label>` : ''}
      </div>`;
    case 'budget': {
      const opts = state.settings.budgets.slice();
      if (v.budget && !opts.includes(v.budget)) opts.push(v.budget);
      return `<select data-f="budget">
        <option value="">— 予算を選択 —</option>
        ${opts.map(b => `<option value="${esc(b)}" ${b === v.budget ? 'selected' : ''}>${esc(b)}</option>`).join('')}
      </select><a href="#/settings" class="hint">選択肢を編集</a>`;
    }
    case 'done_or_na':
      return `<div class="radios">
        <label><input type="radio" name="r-${it.id}" data-f="state" value="" ${!v.state ? 'checked' : ''}> 未</label>
        <label><input type="radio" name="r-${it.id}" data-f="state" value="done" ${v.state === 'done' ? 'checked' : ''}> 終了</label>
        <label><input type="radio" name="r-${it.id}" data-f="state" value="na" ${v.state === 'na' ? 'checked' : ''}> 不要</label>
      </div>`;
    case 'file':
    case 'file_or_physical':
      return `
        <ul class="files">${(v.files || []).map(f => `
          <li>
            <a href="#" data-act="dl" data-fid="${f.id}">${esc(f.name)}</a>
            <span class="fsize">${fmtSize(f.size)}</span>
            <button type="button" data-act="fdel" data-fid="${f.id}" title="削除">×</button>
          </li>`).join('')}
        </ul>
        <label class="btn small upload">📎 ファイルを追加<input type="file" multiple hidden data-act="upload"></label>
        ${it.type === 'file_or_physical' ? `<label class="chk"><input type="checkbox" data-f="physical" ${v.physical ? 'checked' : ''}> 現物提出済み</label>` : ''}`;
    default:
      return '<p class="help">未対応の項目種類です</p>';
  }
}

function rerenderItem(it) {
  const row = $(`.item[data-id="${it.id}"]`);
  if (!row) return;
  $('.item-body', row).innerHTML = controlHTML(it);
  updateDoneUI(row, it);
}

function updateDoneUI(row, it) {
  const done = isDone(it);
  row.classList.toggle('done', done);
  $('.check', row).textContent = done ? '✓' : '';
  const p = state.project;
  const prog = progressOf(p);
  const pct = prog.total ? Math.round(prog.done / prog.total * 100) : 0;
  $('#p-progress').style.width = pct + '%';
  $('#p-progress-text').textContent = `${prog.done}/${prog.total} 完了`;
  for (const s of p.sections) {
    const tab = $(`.tab[data-sec="${s.id}"] .count`);
    if (tab) tab.textContent = `${secDone(s)}/${s.items.length}`;
  }
}

function setStatus(text, isError) {
  state.saveStatus = text;
  const el = $('#save-status');
  if (el) { el.textContent = text; el.classList.toggle('error', !!isError); }
}

/* ===== 保存 ===== */
function summaryOf(p) {
  const prog = progressOf(p);
  return { id: p.id, category: p.category, title: p.title, status: p.status, done: prog.done, total: prog.total, createdAt: p.createdAt, updatedAt: p.updatedAt };
}

async function persistProject(p) {
  const summary = summaryOf(p);
  await state.store.saveProject(p, summary);
  state.index = await state.store.updateIndex(idx => {
    const s = summary;
    const i = idx.projects.findIndex(x => x.id === p.id);
    if (i >= 0) idx.projects[i] = s; else idx.projects.push(s);
  });
}

function scheduleSave() {
  setStatus('未保存の変更があります');
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => { state.saveTimer = null; saveNow(); }, 800);
}

async function saveNow() {
  const p = state.project;
  if (!p || !state.store) return;
  if (state.saving) { state.pendingSave = true; return; }
  state.saving = true;
  p.updatedAt = nowISO();
  const dirty = new Set(state.dirty);
  setStatus('保存中…');
  try {
    await persistProject(p);
    for (const k of dirty) state.dirty.delete(k);
    setStatus(state.dirty.size ? '未保存の変更があります' : '保存済み ' + new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }));
  } catch (e) {
    if (e.conflict) {
      try { await resolveConflict(p, dirty); }
      catch (e2) { setStatus('保存エラー', true); toast('保存に失敗しました: ' + e2.message, 'error'); }
    } else {
      setStatus('保存エラー', true);
      toast('保存に失敗しました: ' + e.message, 'error');
    }
  } finally {
    state.saving = false;
    if (state.pendingSave) { state.pendingSave = false; saveNow(); }
  }
}

// 他の利用者が同じプロジェクトを更新していた場合: 最新版に自分の変更だけを重ねて保存し直す
async function resolveConflict(local, dirty) {
  const remote = await state.store.loadProject(local.id);
  if (!remote) throw new StorageError('このプロジェクトは他の利用者によって削除されました');
  const remoteItems = new Map();
  for (const s of remote.sections) for (const it of s.items) remoteItems.set(it.id, it);
  for (const s of local.sections) for (const it of s.items) {
    if (!dirty.has(it.id)) continue;
    const r = remoteItems.get(it.id);
    if (r) { r.value = it.value; r.label = it.label; }
  }
  if (dirty.has('title')) remote.title = local.title;
  if (dirty.has('memo')) remote.memo = local.memo;
  if (dirty.has('status')) remote.status = local.status;
  remote.updatedAt = nowISO();
  await persistProject(remote);
  if (state.project && state.project.id === local.id) {
    state.project = remote;
    for (const k of dirty) state.dirty.delete(k);
    renderProject();
    setStatus('保存済み（他の利用者の更新を取り込みました）');
    toast(dirty.has('*') ? '他の利用者の更新と重なったため、項目の追加・削除・並べ替えは反映されませんでした。内容を確認してください。' : '他の利用者の更新を取り込みました');
  }
}

/* ===== イベント処理 ===== */
const IMMEDIATE_TYPES = new Set(['checkbox', 'radio', 'select-one', 'date', 'file']);

function onInput(e) {
  const t = e.target;
  if (IMMEDIATE_TYPES.has(t.type)) return; // change で扱う
  if (state.view === 'project') return projectFieldChange(t);
  if (state.view === 'settings') return settingsFieldChange(t);
  if (state.view === 'list' && t.id === 'search') { state.search = t.value; renderCards(); }
}

function onChange(e) {
  const t = e.target;
  if (state.view === 'list' && t.id === 'filter') { state.filter = t.value; renderCards(); return; }
  if (state.view === 'settings') {
    if (t.name === 'mode') { showModeFields(t.value); return; }
    if (IMMEDIATE_TYPES.has(t.type)) settingsFieldChange(t);
    return;
  }
  if (state.view !== 'project') return;
  if (t.dataset.act === 'upload') {
    const row = t.closest('.item');
    const it = row && findItem(row.dataset.id);
    if (it && t.files.length) uploadFiles(it, Array.from(t.files));
    t.value = '';
    return;
  }
  if (IMMEDIATE_TYPES.has(t.type)) projectFieldChange(t);
}

function projectFieldChange(t) {
  const p = state.project;
  if (!p) return;
  if (t.id === 'p-title') { p.title = t.value; state.dirty.add('title'); scheduleSave(); return; }
  if (t.id === 'p-memo') { p.memo = t.value; state.dirty.add('memo'); scheduleSave(); return; }
  const row = t.closest('.item');
  if (!row) return;
  const it = findItem(row.dataset.id);
  if (!it) return;
  if (t.classList.contains('item-label')) { it.label = t.value; state.dirty.add(it.id); scheduleSave(); return; }
  const f = t.dataset.f;
  if (!f) return;
  it.value[f] = t.type === 'checkbox' ? t.checked : t.value;
  if (f === 'dayTrip') {
    const end = $('[data-f="end"]', row);
    if (end) end.disabled = !!it.value.dayTrip;
  }
  state.dirty.add(it.id);
  updateDoneUI(row, it);
  scheduleSave();
}

function onSubmit(e) {
  const form = e.target;
  e.preventDefault();
  if (form.id === 'new-project') {
    const title = form.title.value.trim();
    if (title) createProject(title);
    return;
  }
  if (form.id === 'add-item') {
    const sec = currentSection();
    const label = form.label.value.trim();
    if (!sec || !label) return;
    sec.items.push(newItem(label, form.type.value));
    structuralChange();
    return;
  }
  if (form.id === 'conn-form') return saveConnection(form);
  if (form.id === 'budget-add') {
    const b = form.b.value.trim();
    if (b && !state.draft.budgets.includes(b)) { state.draft.budgets.push(b); rerenderSettings(); }
    return;
  }
}

function onClick(e) {
  if (state.view === 'project') return projectClick(e);
  if (state.view === 'settings') return settingsClick(e);
}

function structuralChange() {
  state.dirty.add('*');
  renderProject();
  scheduleSave();
}

async function projectClick(e) {
  const p = state.project;
  const btn = e.target.closest('[data-act], [data-sec], #btn-status, #btn-delete, #btn-add-section, #btn-rename-section, #btn-delete-section');
  if (!btn || !p) return;

  if (btn.dataset.sec) { state.activeSection = btn.dataset.sec; renderProject(); return; }

  if (btn.id === 'btn-status') {
    p.status = p.status === 'done' ? 'active' : 'done';
    state.dirty.add('status');
    renderProject();
    clearTimeout(state.saveTimer); state.saveTimer = null;
    saveNow();
    return;
  }
  if (btn.id === 'btn-delete') {
    if (!confirm(`「${p.title}」を削除しますか？\n添付ファイルも削除されます。この操作は元に戻せません。`)) return;
    clearTimeout(state.saveTimer); state.saveTimer = null; state.dirty.clear();
    try {
      await state.store.deleteProject(p);
      state.index = await state.store.updateIndex(idx => { idx.projects = idx.projects.filter(x => x.id !== p.id); });
      toast('削除しました');
      state.project = null;
      location.hash = '#/c/' + p.category;
    } catch (err) {
      toast('削除に失敗しました: ' + err.message, 'error');
    }
    return;
  }
  if (btn.id === 'btn-add-section') {
    const name = prompt('新しいタブの名前', '');
    if (!name || !name.trim()) return;
    const s = { id: uid(), name: name.trim(), items: [] };
    p.sections.push(s);
    state.activeSection = s.id;
    structuralChange();
    return;
  }
  if (btn.id === 'btn-rename-section') {
    const sec = currentSection();
    const name = prompt('タブの名前', sec.name);
    if (!name || !name.trim()) return;
    sec.name = name.trim();
    structuralChange();
    return;
  }
  if (btn.id === 'btn-delete-section') {
    const sec = currentSection();
    if (!confirm(`タブ「${sec.name}」とその中の項目（${sec.items.length}件）を削除しますか？`)) return;
    for (const it of sec.items) for (const f of (it.value.files || [])) { try { await state.store.deleteFile(f); } catch (_) {} }
    p.sections = p.sections.filter(s => s !== sec);
    state.activeSection = p.sections[0] && p.sections[0].id;
    structuralChange();
    return;
  }

  const act = btn.dataset.act;
  const row = btn.closest('.item');
  const it = row && findItem(row.dataset.id);
  const sec = currentSection();
  if (!it) return;

  if (act === 'up' || act === 'down') {
    const i = sec.items.indexOf(it);
    const j = act === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= sec.items.length) return;
    [sec.items[i], sec.items[j]] = [sec.items[j], sec.items[i]];
    structuralChange();
  } else if (act === 'del') {
    if (!confirm(`項目「${it.label}」を削除しますか？`)) return;
    for (const f of (it.value.files || [])) { try { await state.store.deleteFile(f); } catch (_) {} }
    sec.items.splice(sec.items.indexOf(it), 1);
    structuralChange();
  } else if (act === 'dl') {
    e.preventDefault();
    downloadFile(it, btn.dataset.fid);
  } else if (act === 'fdel') {
    deleteFile(it, btn.dataset.fid);
  }
}

/* ===== ファイル ===== */
async function uploadFiles(it, files) {
  for (const f of files) {
    const limit = state.store.maxFileSize || MAX_FILE_SIZE;
    if (f.size > limit) { toast(`${f.name} は大きすぎます（上限 ${fmtSize(limit)}）`, 'error'); continue; }
    setStatus(`アップロード中: ${f.name}`);
    try {
      const meta = await state.store.uploadFile(state.project.id, f);
      it.value.files = it.value.files || [];
      it.value.files.push(meta);
      state.dirty.add(it.id);
    } catch (e) {
      toast(`アップロードに失敗しました: ${f.name} (${e.message})`, 'error');
    }
  }
  rerenderItem(it);
  scheduleSave();
}

async function downloadFile(it, fid) {
  const meta = (it.value.files || []).find(f => f.id === fid);
  if (!meta) return;
  toast('ダウンロード中…');
  try {
    const blob = await state.store.downloadFile(meta);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = meta.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) {
    toast('ダウンロードに失敗しました: ' + e.message, 'error');
  }
}

async function deleteFile(it, fid) {
  const meta = (it.value.files || []).find(f => f.id === fid);
  if (!meta || !confirm(`「${meta.name}」を削除しますか？`)) return;
  try {
    await state.store.deleteFile(meta);
    it.value.files = it.value.files.filter(f => f.id !== fid);
    state.dirty.add(it.id);
    rerenderItem(it);
    scheduleSave();
  } catch (e) {
    toast('削除に失敗しました: ' + e.message, 'error');
  }
}

/* ===== 設定画面 ===== */
function renderSettings() {
  state.view = 'settings';
  const c = state.connDraft || state.conn;
  const mode = ['gas', 'github', 'local'].includes(c.mode) ? c.mode : 'gas';
  const connected = !!state.store;
  if (!state.draft && state.settings) state.draft = clone(state.settings);

  $('#app').innerHTML = `
    <a href="#/" class="back">← 一覧へ</a>
    <h2>設定</h2>
    <section class="panel">
      <h3>データの保存先</h3>
      <p class="help">アプリ本体とは別の場所にデータを保存するため、アプリを更新しても入力した情報は失われません。設定はこのブラウザの中にだけ保存され、共有相手も同じ設定を自分のブラウザで一度入力します。</p>
      <form id="conn-form">
        <label class="radio"><input type="radio" name="mode" value="gas" ${mode === 'gas' ? 'checked' : ''}> Google Drive に保存（Apps Script 経由・推奨。共通パスワードだけで利用できます）</label>
        <label class="radio"><input type="radio" name="mode" value="github" ${mode === 'github' ? 'checked' : ''}> GitHub リポジトリに保存（上級者向け。利用者ごとにアクセストークンが必要です）</label>
        <label class="radio"><input type="radio" name="mode" value="local" ${mode === 'local' ? 'checked' : ''}> このブラウザの中だけに保存（お試し用。共有されません）</label>
        <div class="grid mode-fields" data-mode="gas" style="${mode === 'gas' ? '' : 'display:none'}">
          <label>Web アプリの URL（https://script.google.com/macros/s/…/exec）<input name="gasUrl" value="${esc(c.gasUrl || '')}" autocomplete="off"></label>
          <label>パスワード（Apps Script に設定した共通パスワード）<input name="password" type="password" value="${esc(c.password || '')}" autocomplete="off"></label>
        </div>
        <div class="grid mode-fields" data-mode="github" style="${mode === 'github' ? '' : 'display:none'}">
          <label>オーナー（GitHub のユーザー名 / 組織名）<input name="owner" value="${esc(c.owner || '')}" autocomplete="off"></label>
          <label>データ用リポジトリ名<input name="repo" value="${esc(c.repo || '')}" autocomplete="off"></label>
          <label>ブランチ<input name="branch" value="${esc(c.branch || 'main')}" autocomplete="off"></label>
          <label>アクセストークン（Fine-grained personal access token）<input name="token" type="password" value="${esc(c.token || '')}" autocomplete="off"></label>
        </div>
        <p class="help small">セットアップの手順は README.md を参照してください。</p>
        <div class="actions">
          <button type="button" id="btn-test" class="btn">接続テスト</button>
          <button class="btn primary">保存して接続</button>
          <span id="conn-result" class="help"></span>
        </div>
      </form>
    </section>
    ${connected && state.draft ? settingsDataHTML() : '<p class="help">保存先に接続すると、予算の選択肢とチェック項目のテンプレートを編集できます。</p>'}`;
}

function typeOptions(sel) {
  return Object.entries(ITEM_TYPES).map(([k, v]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${esc(v)}</option>`).join('');
}

function settingsDataHTML() {
  const d = state.draft;
  return `
    <section class="panel">
      <h3>予算の選択肢</h3>
      <p class="help">物品購入・国内出張・国外出張の「予算」で共通に使われる選択肢です。</p>
      <ul class="editable-list">
        ${d.budgets.map((b, i) => `<li><input data-budget="${i}" value="${esc(b)}"><button type="button" data-act="budget-del" data-i="${i}" class="danger" title="削除">×</button></li>`).join('')}
      </ul>
      <form id="budget-add" class="inline-form">
        <input name="b" placeholder="例: 科研費（基盤C）／運営費交付金" required autocomplete="off">
        <button class="btn">＋ 追加</button>
      </form>
    </section>
    <section class="panel">
      <h3>チェック項目のテンプレート</h3>
      <p class="help">新しいプロジェクトを作成したときに自動で作られるタブと項目です。既存のプロジェクトには影響しません。</p>
      ${CATEGORIES.map(c => templateHTML(c, d.templates[c.id])).join('')}
    </section>
    <div class="actions sticky">
      <span class="help" id="settings-status">${esc(state.settingsStatus || '変更は自動的に保存されます')}</span>
      <button type="button" id="btn-reset-templates" class="btn ghost small">テンプレートを初期値に戻す</button>
    </div>`;
}

function setSettingsStatus(text, isError) {
  state.settingsStatus = text;
  const el = $('#settings-status');
  if (el) { el.textContent = text; el.className = 'help' + (isError ? ' error' : ''); }
}

function cleanedSettings(d) {
  return normalizeSettings({
    budgets: d.budgets.map(b => b.trim()).filter(Boolean),
    templates: Object.fromEntries(Object.entries(d.templates).map(([k, secs]) => [k, secs.map(s => ({
      name: s.name.trim() || '項目',
      items: s.items.filter(i => i.label.trim()).map(i => ({ label: i.label.trim(), type: i.type })),
    }))])),
  });
}

function scheduleSettingsSave() {
  setSettingsStatus('未保存の変更があります');
  clearTimeout(state.settingsSaveTimer);
  state.settingsSaveTimer = setTimeout(() => { state.settingsSaveTimer = null; saveSettingsNow(); }, 800);
}

async function saveSettingsNow() {
  if (!state.draft || !state.store) return;
  if (state.settingsSaving) { state.settingsPending = true; return; }
  state.settingsSaving = true;
  const cleaned = cleanedSettings(state.draft);
  setSettingsStatus('保存中…');
  try {
    await state.store.saveSettings(cleaned);
    state.settings = cleaned;
    setSettingsStatus('保存済み ' + new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }));
  } catch (err) {
    setSettingsStatus('保存エラー: ' + err.message, true);
    toast('設定の保存に失敗しました: ' + err.message, 'error');
  } finally {
    state.settingsSaving = false;
    if (state.settingsPending) { state.settingsPending = false; saveSettingsNow(); }
  }
}

function templateHTML(c, secs) {
  return `
    <details class="tpl" data-cat="${c.id}" open>
      <summary>${esc(c.name)}</summary>
      ${secs.map((s, si) => `
        <div class="tpl-sec" data-si="${si}">
          <div class="tpl-sec-head">
            <input data-secname value="${esc(s.name)}" placeholder="タブ名">
            <button type="button" data-act="tsec-del" class="btn ghost small danger">タブを削除</button>
          </div>
          <ul>
            ${s.items.map((it, ii) => `
              <li data-ii="${ii}">
                <input data-tlabel value="${esc(it.label)}" placeholder="項目名">
                <select data-ttype>${typeOptions(it.type)}</select>
                <button type="button" data-act="titem-up" ${ii === 0 ? 'disabled' : ''}>↑</button>
                <button type="button" data-act="titem-down" ${ii === s.items.length - 1 ? 'disabled' : ''}>↓</button>
                <button type="button" data-act="titem-del" class="danger">×</button>
              </li>`).join('')}
          </ul>
          <button type="button" data-act="titem-add" class="btn small">＋ 項目を追加</button>
        </div>`).join('')}
      <button type="button" data-act="tsec-add" class="btn small">＋ タブを追加</button>
    </details>`;
}

function showModeFields(mode) {
  document.querySelectorAll('.mode-fields').forEach(el => { el.style.display = el.dataset.mode === mode ? '' : 'none'; });
}

function readConnForm() {
  const form = $('#conn-form');
  if (!form) return null;
  const mode = form.querySelector('input[name="mode"]:checked');
  return {
    mode: mode ? mode.value : 'gas',
    gasUrl: form.gasUrl.value.trim(),
    password: form.password.value,
    owner: form.owner.value.trim(),
    repo: form.repo.value.trim(),
    branch: form.branch.value.trim() || 'main',
    token: form.token.value.trim(),
  };
}

function settingsFieldChange(t) {
  const d = state.draft;
  if (t.closest('#conn-form')) return;
  if (!d) return;
  if (t.dataset.budget !== undefined) { d.budgets[+t.dataset.budget] = t.value; scheduleSettingsSave(); return; }
  const tpl = t.closest('.tpl');
  if (!tpl) return;
  const secs = d.templates[tpl.dataset.cat];
  const secEl = t.closest('.tpl-sec');
  if (!secEl) return;
  const sec = secs[+secEl.dataset.si];
  if (t.hasAttribute('data-secname')) { sec.name = t.value; scheduleSettingsSave(); return; }
  const li = t.closest('li');
  if (!li) return;
  const it = sec.items[+li.dataset.ii];
  if (t.hasAttribute('data-tlabel')) it.label = t.value;
  if (t.hasAttribute('data-ttype')) it.type = t.value;
  scheduleSettingsSave();
}

async function settingsClick(e) {
  const btn = e.target.closest('button');
  if (!btn) return;

  if (btn.id === 'btn-test') {
    const c = readConnForm();
    const out = $('#conn-result');
    out.textContent = '確認中…'; out.className = 'help';
    try {
      if (!connReady(c)) throw new Error(connMissingMessage(c));
      await makeStore(c).testConnection();
      out.textContent = '✓ 接続できます'; out.className = 'help ok';
    } catch (err) {
      out.textContent = '✗ ' + err.message; out.className = 'help error';
    }
    return;
  }

  const d = state.draft;
  if (!d) return;
  const act = btn.dataset.act;

  if (btn.id === 'btn-reset-templates') {
    if (!confirm('すべてのカテゴリのテンプレートを初期値に戻しますか？')) return;
    d.templates = clone(DEFAULT_TEMPLATES);
    rerenderSettings();
    return;
  }
  if (!act) return;

  if (act === 'budget-del') { d.budgets.splice(+btn.dataset.i, 1); rerenderSettings(); return; }

  const tpl = btn.closest('.tpl');
  if (!tpl) return;
  const secs = d.templates[tpl.dataset.cat];
  if (act === 'tsec-add') { secs.push({ name: '新しいタブ', items: [] }); rerenderSettings(); return; }
  const secEl = btn.closest('.tpl-sec');
  if (!secEl) return;
  const si = +secEl.dataset.si;
  const sec = secs[si];
  if (act === 'tsec-del') {
    if (secs.length <= 1) { toast('タブは最低1つ必要です', 'error'); return; }
    if (!confirm(`テンプレートのタブ「${sec.name}」を削除しますか？`)) return;
    secs.splice(si, 1); rerenderSettings(); return;
  }
  if (act === 'titem-add') { sec.items.push({ label: '', type: 'check' }); rerenderSettings(); return; }
  const li = btn.closest('li');
  if (!li) return;
  const ii = +li.dataset.ii;
  if (act === 'titem-del') { sec.items.splice(ii, 1); rerenderSettings(); return; }
  if (act === 'titem-up' && ii > 0) { [sec.items[ii - 1], sec.items[ii]] = [sec.items[ii], sec.items[ii - 1]]; rerenderSettings(); return; }
  if (act === 'titem-down' && ii < sec.items.length - 1) { [sec.items[ii + 1], sec.items[ii]] = [sec.items[ii], sec.items[ii + 1]]; rerenderSettings(); return; }
}

function rerenderSettings() {
  state.connDraft = readConnForm();
  renderSettings();
  scheduleSettingsSave();
}

async function saveConnection(form) {
  const c = readConnForm();
  if (!connReady(c)) {
    toast(connMissingMessage(c), 'error');
    return;
  }
  state.conn = c;
  state.connDraft = null;
  saveConn(c);
  const btn = form.querySelector('button.primary');
  btn.disabled = true;
  const ok = await connect();
  btn.disabled = false;
  if (ok) { toast('接続しました'); location.hash = '#/'; }
  else renderSettings();
}
