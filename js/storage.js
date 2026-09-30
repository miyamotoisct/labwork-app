'use strict';

/* ===== 共通ユーティリティ ===== */
function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}
function b64FromString(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}
function stringFromB64(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
function b64FromBlob(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}
function blobFromB64(b64, type) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: type || 'application/octet-stream' });
}
function shortId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

class StorageError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.status = opts.status;
    this.conflict = !!opts.conflict;
  }
}

/* ===== GitHub リポジトリをストレージにするバックエンド ===== */
class GitHubBackend {
  constructor({ owner, repo, branch, token }) {
    this.owner = (owner || '').trim();
    this.repo = (repo || '').trim();
    this.branch = (branch || 'main').trim() || 'main';
    this.token = (token || '').trim();
    this.shas = new Map(); // path -> blob sha（更新時に必要）
  }
  get label() { return `GitHub: ${this.owner}/${this.repo}`; }

  repoUrl() {
    return `https://api.github.com/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}`;
  }
  url(path) { return `${this.repoUrl()}/contents/${encodePath(path)}`; }
  headers(accept) {
    return {
      'Authorization': 'Bearer ' + this.token,
      'Accept': accept || 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }
  async error(r) {
    let msg = `HTTP ${r.status}`;
    try { const j = await r.json(); if (j && j.message) msg += `: ${j.message}`; } catch (_) {}
    if (r.status === 401) msg = 'トークンが無効です（401）';
    if (r.status === 404) msg = 'リポジトリが見つからないか、トークンにアクセス権がありません（404）';
    return new StorageError(msg, { status: r.status, conflict: r.status === 409 || r.status === 422 });
  }

  async testConnection() {
    const r = await fetch(this.repoUrl(), { headers: this.headers(), cache: 'no-store' });
    if (!r.ok) throw await this.error(r);
    const j = await r.json();
    if (!j.permissions || !j.permissions.push) {
      throw new StorageError('このトークンにはリポジトリへの書き込み権限（Contents: Read and write）がありません');
    }
    return j;
  }

  async getJSON(path) {
    const r = await fetch(this.url(path) + '?ref=' + encodeURIComponent(this.branch), {
      headers: this.headers(), cache: 'no-store',
    });
    if (r.status === 404) { this.shas.delete(path); return null; }
    if (!r.ok) throw await this.error(r);
    const j = await r.json();
    this.shas.set(path, j.sha);
    if (!j.content) throw new StorageError('ファイルが大きすぎて読み込めません: ' + path);
    return JSON.parse(stringFromB64(j.content));
  }

  async fetchSha(path) {
    const r = await fetch(this.url(path) + '?ref=' + encodeURIComponent(this.branch), {
      headers: this.headers('application/vnd.github.object+json'), cache: 'no-store',
    });
    if (r.status === 404) { this.shas.delete(path); return undefined; }
    if (!r.ok) throw await this.error(r);
    const j = await r.json();
    this.shas.set(path, j.sha);
    return j.sha;
  }

  async put(path, base64, message, { retryOnConflict = true } = {}) {
    let sha = this.shas.get(path);
    if (sha === undefined) sha = await this.fetchSha(path);
    for (let attempt = 0; ; attempt++) {
      const body = { message, content: base64, branch: this.branch };
      if (sha) body.sha = sha;
      const r = await fetch(this.url(path), { method: 'PUT', headers: this.headers(), body: JSON.stringify(body) });
      if (r.ok) {
        const j = await r.json();
        this.shas.set(path, j.content.sha);
        return j.content.sha;
      }
      const err = await this.error(r);
      if (err.conflict && retryOnConflict && attempt === 0) {
        sha = await this.fetchSha(path);
        continue;
      }
      throw err;
    }
  }
  putJSON(path, obj, message, opts) {
    return this.put(path, b64FromString(JSON.stringify(obj, null, 2)), message, opts);
  }
  async putBlob(path, blob, message) {
    return this.put(path, await b64FromBlob(blob), message);
  }

  async getBlob(path) {
    const r = await fetch(this.url(path) + '?ref=' + encodeURIComponent(this.branch), {
      headers: this.headers('application/vnd.github.raw+json'), cache: 'no-store',
    });
    if (!r.ok) throw await this.error(r);
    return r.blob();
  }

  async delete(path, sha, message) {
    sha = sha || this.shas.get(path) || await this.fetchSha(path);
    if (!sha) return;
    const r = await fetch(this.url(path), {
      method: 'DELETE', headers: this.headers(),
      body: JSON.stringify({ message, sha, branch: this.branch }),
    });
    if (!r.ok && r.status !== 404) throw await this.error(r);
    this.shas.delete(path);
  }
}

/* ===== ブラウザ内保存（お試し用） ===== */
class LocalBackend {
  constructor() { this.prefix = 'gyomu.data:'; }
  get label() { return 'このブラウザのみ（共有されません）'; }
  async testConnection() { return {}; }
  async getJSON(path) {
    const s = localStorage.getItem(this.prefix + path);
    return s === null ? null : JSON.parse(s);
  }
  async putJSON(path, obj) {
    localStorage.setItem(this.prefix + path, JSON.stringify(obj));
    return 'local';
  }
  async putBlob(path, blob) {
    const b64 = await b64FromBlob(blob);
    try {
      localStorage.setItem(this.prefix + path, JSON.stringify({ type: blob.type, b64 }));
    } catch (e) {
      throw new StorageError('ブラウザの保存容量を超えました（お試しモードでは大きなファイルは保存できません）');
    }
    return 'local';
  }
  async getBlob(path) {
    const s = localStorage.getItem(this.prefix + path);
    if (!s) throw new StorageError('ファイルが見つかりません');
    const { type, b64 } = JSON.parse(s);
    return blobFromB64(b64, type);
  }
  async delete(path) { localStorage.removeItem(this.prefix + path); }
}

/* ===== アプリ用の高レベル API ===== */
const PATHS = {
  settings: 'data/settings.json',
  index: 'data/index.json',
  project: id => `data/projects/${id}.json`,
  file: (pid, fid, name) => `data/files/${pid}/${fid}-${name}`,
};

class Store {
  constructor(backend) { this.b = backend; }
  get label() { return this.b.label; }
  get maxFileSize() { return 50 * 1024 * 1024; }
  testConnection() { return this.b.testConnection(); }

  async loadSettings() { return normalizeSettings(await this.b.getJSON(PATHS.settings)); }
  async saveSettings(s) { await this.b.putJSON(PATHS.settings, s, '設定を更新'); }

  async loadIndex() {
    const idx = await this.b.getJSON(PATHS.index);
    return (idx && Array.isArray(idx.projects)) ? idx : { projects: [] };
  }
  // 一覧ファイルは競合しやすいので、最新を読み直してから変更を適用する
  async updateIndex(mutate) {
    let lastErr;
    for (let i = 0; i < 4; i++) {
      const idx = await this.loadIndex();
      mutate(idx);
      try {
        await this.b.putJSON(PATHS.index, idx, 'プロジェクト一覧を更新', { retryOnConflict: false });
        return idx;
      } catch (e) {
        if (!e.conflict) throw e;
        lastErr = e;
      }
    }
    throw lastErr;
  }

  loadProject(id) { return this.b.getJSON(PATHS.project(id)); }
  async saveProject(p) {
    await this.b.putJSON(PATHS.project(p.id), p, `更新: ${p.title}`, { retryOnConflict: false });
  }
  async deleteProject(p) {
    for (const f of allFilesOf(p)) {
      try { await this.b.delete(f.path, f.sha, `添付削除: ${f.name}`); } catch (_) {}
    }
    await this.b.delete(PATHS.project(p.id), undefined, `削除: ${p.title}`);
  }

  async uploadFile(projectId, file) {
    const id = shortId();
    const safeName = file.name.replace(/[\\/:*?"<>|]/g, '_');
    const path = PATHS.file(projectId, id, safeName);
    const sha = await this.b.putBlob(path, file, `添付: ${safeName}`);
    return { id, name: file.name, size: file.size, type: file.type, path, sha, uploadedAt: new Date().toISOString() };
  }
  downloadFile(meta) { return this.b.getBlob(meta.path); }
  deleteFile(meta) { return this.b.delete(meta.path, meta.sha, `添付削除: ${meta.name}`); }
}

function allFilesOf(project) {
  const out = [];
  for (const s of project.sections || []) {
    for (const it of s.items || []) {
      for (const f of (it.value && it.value.files) || []) out.push(f);
    }
  }
  return out;
}

/* ===== Google Apps Script（Google Drive 保存）ストア =====
   gas/Code.gs を Web アプリとして公開し、その URL と共通パスワードで接続する。
   ファイル単位の sha 管理は不要で、競合検出はサーバー側の updatedAt 比較で行う。 */
class GasStore {
  constructor({ gasUrl, password }) {
    this.url = (gasUrl || '').trim();
    this.password = password || '';
    this.bases = new Map();   // projectId -> 最後に読み込んだ/保存した updatedAt
    this.lastIndex = null;    // 保存・削除の応答に含まれる最新一覧
    this.allPromise = null;   // getAll の同時呼び出しをまとめる
  }
  get label() { return 'Google Drive（Apps Script）'; }
  get maxFileSize() { return 20 * 1024 * 1024; }

  async call(action, params) {
    let r;
    try {
      // Content-Type を指定しない（text/plain のまま）ことで CORS の事前確認なしに送れる
      r = await fetch(this.url, { method: 'POST', body: JSON.stringify(Object.assign({ action, password: this.password }, params || {})) });
    } catch (e) {
      throw new StorageError('サーバーに接続できません: ' + e.message);
    }
    const text = await r.text();
    let j;
    try { j = JSON.parse(text); } catch (_) {
      throw new StorageError('サーバーから想定外の応答がありました。Web アプリの URL と公開設定（アクセスできるユーザー: 全員）を確認してください');
    }
    if (!j.ok) throw new StorageError(j.error || 'サーバーでエラーが発生しました');
    return j.result;
  }
  getAll() {
    if (!this.allPromise) {
      this.allPromise = this.call('getAll').finally(() => { this.allPromise = null; });
    }
    return this.allPromise;
  }

  async testConnection() { await this.call('ping'); }
  async loadSettings() { return normalizeSettings((await this.getAll()).settings); }
  async saveSettings(s) { await this.call('saveSettings', { settings: s }); }
  async loadIndex() { return { projects: (await this.getAll()).index || [] }; }
  async updateIndex() {
    if (this.lastIndex) { const i = this.lastIndex; this.lastIndex = null; return i; }
    return this.loadIndex();
  }
  async loadProject(id) {
    const r = await this.call('getProject', { id });
    if (r.project) this.bases.set(id, r.project.updatedAt);
    return r.project;
  }
  async saveProject(p, summary) {
    const r = await this.call('saveProject', { project: p, summary, base: this.bases.get(p.id) || null });
    if (r.conflict) {
      this.bases.set(p.id, r.project.updatedAt);
      throw new StorageError('他の利用者が先に更新しました', { conflict: true });
    }
    this.bases.set(p.id, p.updatedAt);
    this.lastIndex = { projects: r.index || [] };
  }
  async deleteProject(p) {
    const r = await this.call('deleteProject', { id: p.id });
    this.bases.delete(p.id);
    this.lastIndex = { projects: r.index || [] };
  }
  async uploadFile(projectId, file) {
    const base64 = await b64FromBlob(file);
    const r = await this.call('uploadFile', { projectId, name: file.name, type: file.type, base64 });
    return { id: r.id, name: file.name, size: file.size, type: file.type, uploadedAt: new Date().toISOString() };
  }
  async downloadFile(meta) {
    const r = await this.call('downloadFile', { id: meta.id });
    return blobFromB64(r.base64, r.type || meta.type);
  }
  async deleteFile(meta) { await this.call('deleteFile', { id: meta.id }); }
}
