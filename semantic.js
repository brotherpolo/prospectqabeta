// Meaning-based matching: manages the model worker and a per-browser cache of results.
// Nothing leaves the browser: questions are processed locally.

import { splitAsker, repNames } from './utils.js';

/** Open models that run in the browser. Sizes are the compressed downloads. */
export const MODELS = [
  { id: 'Xenova/all-MiniLM-L6-v2', name: 'all-MiniLM-L6-v2', size: '23 MB', pooling: 'mean', note: 'Default. Fast and small.' },
  { id: 'Xenova/bge-small-en-v1.5', name: 'bge-small-en-v1.5', size: '34 MB', pooling: 'cls', note: 'Strong at matching questions to answers.' },
  { id: 'Xenova/gte-small', name: 'gte-small', size: '34 MB', pooling: 'mean', note: 'General-purpose alternative.' },
  { id: 'Xenova/all-MiniLM-L12-v2', name: 'all-MiniLM-L12-v2', size: '34 MB', pooling: 'mean', note: 'Larger sibling of the default.' },
];
export const DEFAULT_MODEL = MODELS[0].id;
export const modelInfo = (id) => MODELS.find((m) => m.id === id) || MODELS[0];
export const activeModel = (cfg) => modelInfo(cfg?.semanticModel).id;
// The default keeps its original cache key, so vectors already cached in browsers stay valid.
const keyPrefix = (model) => (model === DEFAULT_MODEL ? 'all-MiniLM-L6-v2-q8' : `${model}-q8`);
export const MODEL_ID = keyPrefix(DEFAULT_MODEL);
const listeners = new Set();
export const status = { state: 'idle', progress: 0, message: '' }; // idle | loading | ready | error | off
export const onStatus = (fn) => (listeners.add(fn), () => listeners.delete(fn));
function setStatus(patch) {
  Object.assign(status, patch);
  listeners.forEach((fn) => fn(status));
}

let worker = null;
let currentModel = DEFAULT_MODEL;
const progressListeners = new Set();
export const onModelProgress = (fn) => (progressListeners.add(fn), () => progressListeners.delete(fn));
let seq = 0;
const pending = new Map();
const progress = new Map();

function getWorker() {
  if (worker) return worker;
  if (typeof Worker === 'undefined') throw new Error('This browser can’t run background tasks.');
  worker = new Worker(new URL('./semantic-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'progress') {
      progressListeners.forEach((fn) => fn(m));
      if (m.model !== currentModel) return;
      progress.set(m.file, [m.loaded, m.total]);
      let l = 0, t = 0;
      progress.forEach(([a, b]) => { l += a; t += b; });
      if (status.state === 'loading') setStatus({ progress: t ? Math.round((l / t) * 100) : 0 });
      return;
    }
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.type === 'error') p.reject(new Error(m.message));
    else p.resolve(m.vectors || true);
  };
  worker.onerror = (e) => {
    const err = new Error(e.message || 'The matching model failed to start.');
    pending.forEach((p) => p.reject(err));
    pending.clear();
    worker = null;
    setStatus({ state: 'error', message: err.message });
  };
  return worker;
}

function call(type, texts, model = currentModel) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    try { getWorker().postMessage({ id, type, texts, model, pooling: modelInfo(model).pooling }); } catch (err) { pending.delete(id); reject(err); }
  });
}

/** Free a model's memory after a comparison (never the one in use). */
export function unloadModel(model) {
  if (model === currentModel || !worker) return Promise.resolve();
  return call('unload', [], model).catch(() => {});
}

// ---------- Cache (IndexedDB) ----------
let dbp = null;
function db() {
  dbp ||= new Promise((resolve) => {
    try {
      const req = indexedDB.open('qa-hub-matching', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('vectors');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
  return dbp;
}
async function cacheGet(keys) {
  const d = await db();
  if (!d) return new Map();
  return new Promise((resolve) => {
    const out = new Map();
    const tx = d.transaction('vectors', 'readonly');
    const store = tx.objectStore('vectors');
    keys.forEach((k) => { const r = store.get(k); r.onsuccess = () => { if (r.result) out.set(k, r.result); }; });
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => resolve(out);
  });
}
async function cachePut(entries) {
  const d = await db();
  if (!d) return;
  const tx = d.transaction('vectors', 'readwrite');
  entries.forEach(([k, v]) => tx.objectStore('vectors').put(v, k));
}

function hash(s) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

// ---------- Text preparation ----------
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Account, contact and rep names are removed before matching, so two questions aren't
 * "related" just because they mention the same prospect. Configured words (your own
 * product and company names) are removed too.
 */
export function buildCleaner(items, cfg) {
  const names = new Set((cfg.ignoreWords || []).map((w) => w.trim()).filter(Boolean));
  for (const i of items) {
    const { person, company } = splitAsker(i.askedBy);
    [i.company, i.contact, person, company, ...repNames(i.answeredBy)].forEach((n) => n && n.length > 1 && names.add(n.trim()));
  }
  const list = [...names].sort((a, b) => b.length - a.length).map((n) => escapeRe(n).replace(/\s+/g, '\\s+'));
  const re = list.length ? new RegExp(`(^|[^\\w])(${list.join('|')})(’s|'s)?(?=$|[^\\w])`, 'gi') : null;
  return (text) => (re ? String(text).replace(re, '$1') : String(text)).replace(/\s+/g, ' ').trim();
}

export const textFor = (item, clean) =>
  clean(/^no answer provided\.?$/i.test(String(item.answer || '').trim()) ? item.question : `${item.question} ${item.answer}`);

const memo = new Map(); // cache key -> Float32Array, so unchanged questions keep the same vector object

/** Vectors for every item, computing only what isn't cached. Resolves to Map(id -> Float32Array). */
export async function vectorsFor(items, cfg) {
  const model = activeModel(cfg);
  if (model !== currentModel) { currentModel = model; progress.clear(); setStatus({ state: 'loading', progress: 0, message: '' }); }
  if (status.state === 'idle' || status.state === 'error') setStatus({ state: 'loading', progress: 0, message: '' });
  const clean = buildCleaner(items, cfg);
  const prefix = keyPrefix(model);
  const keyed = items.map((it) => [it.id, `${prefix}|${hash(textFor(it, clean))}`, textFor(it, clean)]);
  const missing = keyed.filter(([, k]) => !memo.has(k));
  if (missing.length) {
    const fromDb = await cacheGet(missing.map(([, k]) => k));
    fromDb.forEach((v, k) => memo.set(k, v instanceof Float32Array ? v : Float32Array.from(v)));
    const todo = missing.filter(([, k]) => !memo.has(k));
    if (todo.length) {
      try {
        const vecs = await call('embed', todo.map(([, , t]) => t), model);
        const entries = todo.map(([, k], n) => [k, Float32Array.from(vecs[n])]);
        entries.forEach(([k, v]) => memo.set(k, v));
        cachePut(entries);
      } catch (err) {
        setStatus({ state: 'error', message: err.message });
        throw err;
      }
    }
  }
  if (status.state !== 'ready') setStatus({ state: 'ready', progress: 100, message: '' });
  return new Map(keyed.map(([id, k]) => [id, memo.get(k)]));
}

/** Vector for free text (a question being typed or imported). */
export async function embedText(text, items, cfg) {
  const model = activeModel(cfg);
  const clean = buildCleaner(items, cfg);
  const t = clean(text);
  const k = `${keyPrefix(model)}|${hash(t)}`;
  if (memo.has(k)) return memo.get(k);
  const [v] = await call('embed', [t], model);
  const f = Float32Array.from(v);
  memo.set(k, f);
  return f;
}

export function turnOff() { setStatus({ state: 'off', progress: 0, message: '' }); }

/** Vectors for some items with a specific model (used by the model comparison). Cached like the rest. */
export async function vectorsWith(model, items, cfg) {
  const clean = buildCleaner(cfg.allItems || items, cfg);
  const prefix = keyPrefix(model);
  const keyed = items.map((it) => [it.id, `${prefix}|${hash(textFor(it, clean))}`, textFor(it, clean)]);
  const missing = keyed.filter(([, k]) => !memo.has(k));
  if (missing.length) {
    const fromDb = await cacheGet(missing.map(([, k]) => k));
    fromDb.forEach((v, k) => memo.set(k, v instanceof Float32Array ? v : Float32Array.from(v)));
    const todo = missing.filter(([, k]) => !memo.has(k));
    if (todo.length) {
      const vecs = await call('embed', todo.map(([, , t]) => t), model);
      const entries = todo.map(([, k], n) => [k, Float32Array.from(vecs[n])]);
      entries.forEach(([k, v]) => memo.set(k, v));
      cachePut(entries);
    }
  }
  return new Map(keyed.map(([id, k]) => [id, memo.get(k)]));
}
