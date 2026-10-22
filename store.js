// App state, derived caches and every data change.
// Changes apply locally right away, then commit to Firestore in a transaction (sync.js),
// so two people editing at once don't overwrite each other.
//
// Data model (all new fields are optional, so older records keep working):
//   item: id, question, answer, askedBy, answeredBy, topic, createdBy, createdAt,
//         company, contact, askedAt (YYYY-MM-DD), callId, themeId, verdict,
//         followUp { owner, due, done }, kind ('feedback'), standard, variantOf, related, importBatch
//   insightConfig: matching and coaching settings, plus calls, themes, accounts (Salesforce stages),
//         review decisions and the matching answer key. They live inside insightConfig because the
//         original app preserves that object when it saves, and would erase new top-level fields.

import { createIndex } from './similarity.js';
import * as semantic from './semantic.js';
import { canonicalRep, splitAsker } from './utils.js';

export const DEFAULT_CONFIG = Object.freeze({
  overlapRatio: 70,
  jaccardRatio: 30,
  shortWordThreshold: 15,
  matchThreshold: 35,
  minShared: 2,
  semanticMatching: true,
  semanticThreshold: 42,
  sameThreshold: 70,
  sameWordThreshold: 60,
  ignoreWords: ['Novara Flex', 'Novara', 'Flex'],
  customRules: [
    { id: 1, text: 'Flag answers under word threshold for brevity review', enabled: true },
    { id: 2, text: 'Highlight multi-rep coverage for consistency cross-checks', enabled: true },
    { id: 3, text: 'Flag cross-topic comparisons for potential categorization alignment', enabled: true },
  ],
  synonyms: [
    { term: 'PTP', means: 'pre-task plan' },
    { term: 'LMS', means: 'learning management system' },
    { term: 'JHA', means: 'job hazard analysis' },
  ],
  review: { resolved: [] },
  calls: [],
  themes: [],
  accounts: {},
  matchCheck: null,
});

// Pairs from your data used to check the matching model. Review decisions add more over time.
const DEFAULT_CHECK = [
  [53, 55, true], [54, 56, true], [14, 54, true], [12, 13, true], [48, 49, true], [15, 40, true], [39, 45, true], [3, 9, true], [23, 26, true],
  [20, 54, false], [33, 12, false], [29, 39, false], [5, 48, false], [45, 36, false], [9, 52, false], [15, 26, false], [3, 49, false], [23, 14, false], [50, 10, false],
];

/** Merge saved config over defaults. Unknown keys are kept so nothing written by other versions is lost. */
export function normalizeConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const merged = { ...structuredClone(DEFAULT_CONFIG), ...c };
  merged.review = { resolved: [], ...(c.review || {}) };
  if (!Array.isArray(merged.review.resolved)) merged.review.resolved = [];
  for (const k of ['customRules', 'synonyms', 'ignoreWords']) {
    if (!Array.isArray(merged[k])) merged[k] = structuredClone(DEFAULT_CONFIG[k]);
  }
  for (const k of ['calls', 'themes']) if (!Array.isArray(merged[k])) merged[k] = [];
  if (!merged.accounts || typeof merged.accounts !== 'object') merged.accounts = {};
  return merged;
}

export const state = {
  user: null,
  items: [],
  categories: [],
  config: normalizeConfig(null),
  loaded: false,
  sync: 'synced',
};

const listeners = new Set();
let index = null;
let vectors = null;
let committer = null;
let onError = (msg) => console.error(msg);

export const subscribe = (fn) => (listeners.add(fn), () => listeners.delete(fn));
const emit = () => listeners.forEach((fn) => fn(state));

export function configureStore({ commit, error }) {
  committer = commit;
  if (error) onError = error;
}

const semanticOn = () => state.config.semanticMatching !== false;

export function getIndex() {
  index ||= createIndex(state.items.filter((i) => i.kind !== 'feedback'), state.config, semanticOn() ? vectors : null);
  return index;
}

// Recompute meaning vectors after data changes (cached, so usually instant).
let vecTimer = null;
let vecRun = 0;
function refreshVectors() {
  clearTimeout(vecTimer);
  if (!semanticOn()) { semantic.turnOff(); if (vectors) { vectors = null; index = null; emit(); } return; }
  vecTimer = setTimeout(async () => {
    const run = ++vecRun;
    try {
      const v = await semantic.vectorsFor(state.items, state.config);
      if (run !== vecRun) return;
      const changed = !vectors || v.size !== vectors.size || [...v].some(([id, vec]) => vectors.get(id) !== vec);
      if (changed) { vectors = v; index = null; emit(); }
    } catch (err) {
      console.warn('Smart matching unavailable; using word matching.', err);
      if (vectors) { vectors = null; index = null; emit(); }
    }
  }, 150);
}
semantic.onStatus(() => emit());

/** Score free text against the library, by meaning when available. */
export async function matchText(text, filter) {
  const idx = getIndex();
  if (idx.mode === 'meaning') {
    try {
      const v = await semantic.embedText(text, state.items, state.config);
      return idx.bestMatchByVector(v, filter);
    } catch { /* fall through to words */ }
  }
  const m = idx.bestMatch(text);
  return m && (!filter || filter(m.item)) ? m : null;
}

function apply(data) {
  state.items = (data.items || []).filter((x) => x && typeof x.id === 'number');
  const cats = new Set(data.categories || []);
  state.items.forEach((i) => i.topic && cats.add(i.topic));
  state.categories = [...cats].sort((a, b) => a.localeCompare(b));
  state.config = normalizeConfig(data.insightConfig);
  if (!Array.isArray(state.config.matchCheck)) {
    const ids = new Set(state.items.map((i) => i.id));
    state.config.matchCheck = DEFAULT_CHECK.filter(([a, b]) => ids.has(a) && ids.has(b)).map(([a, b, related]) => ({ a, b, related }));
  }
  // Labels: "same" (same question), "topic" (same topic, different question), "unrelated".
  state.config.matchCheck = state.config.matchCheck.map((p) => ({ ...p, label: p.label || (p.related ? 'topic' : 'unrelated') }));
  index = null;
  refreshVectors();
}

let lastCloud = null;
export function receiveCloud(data) {
  lastCloud = data;
  apply(data);
  state.loaded = true;
  emit();
}

export function setUser(user) {
  state.user = user;
  if (!user) { state.items = []; state.categories = []; state.loaded = false; index = null; }
  emit();
}

export function setSync(s) {
  if (state.sync === s) return;
  state.sync = s;
  document.querySelectorAll('[data-sync]').forEach((el) => {
    el.dataset.state = s;
    el.textContent = { synced: 'Synced', saving: 'Saving…', offline: 'Offline', error: 'Not saved' }[s] || s;
  });
}

export const userLabel = () => state.user?.email || state.user?.uid || 'anonymous';

/**
 * Apply a change. `fn(data)` mutates { items, categories, insightConfig } and must be repeatable:
 * Firestore may re-run it inside a transaction if someone else saved at the same moment.
 */
export async function mutate(fn) {
  const draft = {
    items: structuredClone(state.items),
    categories: [...state.categories],
    insightConfig: structuredClone(state.config),
  };
  fn(draft);
  apply(draft);
  emit();
  if (!committer) return true;
  try {
    setSync('saving');
    await committer(fn);
    setSync('synced');
    return true;
  } catch (err) {
    console.error(err);
    setSync('error');
    onError(navigator.onLine
      ? `Couldn't save: ${err.code === 'permission-denied' ? 'your account is not allowed to edit this dataset.' : err.message}`
      : 'You are offline, so that change was not saved.');
    if (lastCloud) { apply(lastCloud); emit(); }
    return false;
  }
}

// ---------- Helpers ----------
const nextId = (items) => items.reduce((m, i) => Math.max(m, i.id), 0) + 1;
const now = () => new Date().toISOString();
const cfgOf = (d) => {
  d.insightConfig ||= {};
  for (const k of ['calls', 'themes']) if (!Array.isArray(d.insightConfig[k])) d.insightConfig[k] = [];
  if (!d.insightConfig.review) d.insightConfig.review = { resolved: [] };
  if (!Array.isArray(d.insightConfig.review.resolved)) d.insightConfig.review.resolved = [];
  return d.insightConfig;
};
export const composeAsker = (contact, company) =>
  (contact && company ? `${contact} (${company})` : contact || company || '').trim() || 'Unknown Prospect';

// ---------- Questions ----------
const FIELDS = ['askedAt', 'company', 'contact', 'verdict', 'themeId', 'followUp', 'kind'];

export function saveQuestion(fields, id = null) {
  const by = userLabel();
  const clean = {
    question: fields.question.trim(),
    answer: fields.answer.trim() || 'No answer provided',
    answeredBy: fields.answeredBy.trim() || 'Unassigned',
    topic: fields.topic || 'General Operations',
  };
  if ('company' in fields || 'contact' in fields) {
    clean.company = (fields.company || '').trim();
    clean.contact = (fields.contact || '').trim();
    clean.askedBy = composeAsker(clean.contact, clean.company);
  } else {
    clean.askedBy = (fields.askedBy || '').trim() || 'Unknown Prospect';
  }
  for (const f of ['askedAt', 'verdict', 'themeId', 'followUp']) if (f in fields) clean[f] = fields[f] || null;
  let newId = id;
  return mutate((d) => {
    if (id != null) {
      const rec = d.items.find((x) => x.id === id);
      if (rec) {
        Object.assign(rec, clean, { updatedAt: now(), updatedBy: by });
        for (const f of FIELDS) if (rec[f] === null || rec[f] === '') delete rec[f];
      }
    } else {
      if (newId == null || d.items.some((x) => x.id === newId)) newId = nextId(d.items);
      const rec = { id: newId, ...clean, createdBy: by, createdAt: now() };
      for (const f of FIELDS) if (rec[f] === null || rec[f] === '') delete rec[f];
      d.items.push(rec);
    }
    if (!d.categories.includes(clean.topic)) d.categories.push(clean.topic);
  }).then((ok) => (ok ? newId : null));
}

export function deleteQuestion(id) {
  return mutate((d) => {
    d.items = d.items.filter((x) => x.id !== id);
    d.items.forEach((x) => {
      if (x.variantOf === id) delete x.variantOf;
      if (Array.isArray(x.related)) x.related = x.related.filter((r) => r !== id);
    });
  });
}

/** Delete several questions at once. Returns copies for undo. */
export function deleteQuestions(ids) {
  const set = new Set(ids);
  const copies = state.items.filter((x) => set.has(x.id)).map((x) => structuredClone(x));
  return mutate((d) => {
    d.items = d.items.filter((x) => !set.has(x.id));
    d.items.forEach((x) => {
      if (set.has(x.variantOf)) delete x.variantOf;
      if (Array.isArray(x.related)) x.related = x.related.filter((r) => !set.has(r));
    });
  }).then((ok) => ok && copies);
}

export function restoreQuestions(items) {
  return mutate((d) => {
    for (const it of items) if (!d.items.some((x) => x.id === it.id)) d.items.push(structuredClone(it));
  });
}

/** Snapshot of chosen fields on some questions, for undoing bulk edits. */
export function fieldSnapshot(ids, fields) {
  const set = new Set(ids);
  return state.items.filter((x) => set.has(x.id)).map((x) => ({ id: x.id, ...Object.fromEntries(fields.map((f) => [f, x[f] ?? null])) }));
}
export function restoreFields(snap) {
  return mutate((d) => {
    for (const s of snap) {
      const x = d.items.find((i) => i.id === s.id);
      if (!x) continue;
      for (const [k, v] of Object.entries(s)) { if (k === 'id') continue; if (v == null) delete x[k]; else x[k] = v; }
    }
  });
}

export function setCategory(ids, topic) {
  const set = new Set(ids);
  return mutate((d) => {
    d.items.forEach((x) => { if (set.has(x.id)) x.topic = topic; });
    if (!d.categories.includes(topic)) d.categories.push(topic);
  });
}

export function restoreQuestion(item) {
  return mutate((d) => {
    if (!d.items.some((x) => x.id === item.id)) d.items.push(structuredClone(item));
  });
}

export function setVerdicts(ids, verdict) {
  const set = new Set(ids);
  return mutate((d) => d.items.forEach((x) => {
    if (!set.has(x.id)) return;
    if (verdict) x.verdict = verdict; else delete x.verdict;
  }));
}

export function setFollowUp(id, followUp) {
  return mutate((d) => {
    const x = d.items.find((i) => i.id === id);
    if (!x) return;
    if (followUp) x.followUp = followUp; else delete x.followUp;
  });
}

// ---------- Calls ----------
/** Save a call and its new questions in one change. */
export function logCall(call, questions) {
  const by = userLabel();
  return mutate((d) => {
    const cfg = cfgOf(d);
    const existing = cfg.calls.find((c) => c.id === call.id);
    if (existing) Object.assign(existing, call, { updatedAt: now(), updatedBy: by });
    else cfg.calls.push({ ...call, createdBy: by, createdAt: now() });
    // Call details flow down to every question on the call.
    d.items.forEach((x) => {
      if (x.callId !== call.id) return;
      Object.assign(x, { askedAt: call.date, company: call.company, contact: call.contact, askedBy: composeAsker(call.contact, call.company) });
    });
    let id = nextId(d.items);
    for (const q of questions) {
      if (q.newTheme && !cfg.themes.some((t) => t.id === q.newTheme.id)) {
        cfg.themes.push({ id: q.newTheme.id, name: q.newTheme.name, color: nextColor(cfg.themes), createdAt: now(), by });
        const peer = d.items.find((x) => x.id === q.newTheme.withId);
        if (peer && !peer.themeId) peer.themeId = q.newTheme.id;
      }
      const rec = {
        id: id++, question: q.question, answer: q.answer || 'No answer provided',
        answeredBy: q.answeredBy || call.rep || 'Unassigned', topic: q.topic || 'General Operations',
        askedBy: composeAsker(call.contact, call.company), company: call.company, contact: call.contact,
        askedAt: call.date, callId: call.id, createdBy: by, createdAt: now(),
      };
      if (q.verdict) rec.verdict = q.verdict;
      if (q.themeId) rec.themeId = q.themeId;
      if (q.newTheme) rec.themeId = q.newTheme.id;
      if (q.followUp) rec.followUp = q.followUp;
      d.items.push(rec);
      if (!d.categories.includes(rec.topic)) d.categories.push(rec.topic);
    }
  });
}

/** mode "all" removes the call's questions; "keep" keeps them, unlinked and undated. */
export function deleteCall(callId, mode) {
  const call = state.config.calls.find((c) => c.id === callId);
  const items = state.items.filter((i) => i.callId === callId).map((i) => structuredClone(i));
  const p = mutate((d) => {
    const cfg = cfgOf(d);
    cfg.calls = cfg.calls.filter((c) => c.id !== callId);
    if (mode === 'all') d.items = d.items.filter((x) => x.callId !== callId);
    else d.items.forEach((x) => { if (x.callId === callId) { delete x.callId; delete x.askedAt; } });
  });
  return p.then((ok) => ok && { call: structuredClone(call), items });
}

export function restoreCall(snapshot) {
  return mutate((d) => {
    const cfg = cfgOf(d);
    if (!cfg.calls.some((c) => c.id === snapshot.call.id)) cfg.calls.push(structuredClone(snapshot.call));
    for (const it of snapshot.items) {
      const ex = d.items.find((x) => x.id === it.id);
      if (ex) Object.assign(ex, structuredClone(it));
      else d.items.push(structuredClone(it));
    }
  });
}

// ---------- Completing older records ----------
/** rows: [{ askedBy, contact, company, feedback }] applied to every item with that askedBy. */
export function completeAccounts(rows) {
  return mutate((d) => {
    for (const r of rows) {
      d.items.forEach((x) => {
        if (x.askedBy !== r.askedBy || x.company) return;
        if (r.feedback) { x.kind = 'feedback'; return; }
        if (!r.company && !r.contact) return;
        x.company = r.company.trim();
        x.contact = r.contact.trim();
        x.askedBy = composeAsker(x.contact, x.company);
      });
    }
  });
}

/** groups: [{ callId, ids, date, company, contact, type, rep }] -> one call per group. */
export function createCalls(groups) {
  const by = userLabel();
  return mutate((d) => {
    const cfg = cfgOf(d);
    for (const g of groups) {
      if (!cfg.calls.some((c) => c.id === g.callId)) {
        cfg.calls.push({ id: g.callId, date: g.date, company: g.company, contact: g.contact, type: g.type, rep: g.rep, createdBy: by, createdAt: now() });
      }
      d.items.forEach((x) => {
        if (g.ids.includes(x.id) && !x.callId) { x.callId = g.callId; x.askedAt = g.date; }
      });
    }
  });
}

// ---------- Themes ----------
/** themes: [{ id, name, ids }] */
export function saveThemes(themes) {
  const by = userLabel();
  return mutate((d) => {
    const cfg = cfgOf(d);
    for (const t of themes) {
      const ex = cfg.themes.find((x) => x.id === t.id);
      if (ex) ex.name = t.name;
      else cfg.themes.push({ id: t.id, name: t.name, color: t.color || nextColor(cfg.themes), createdAt: now(), by });
      d.items.forEach((x) => { if (t.ids.includes(x.id)) assignTheme(x, t.id); });
    }
  });
}

export function renameTheme(id, name) {
  return mutate((d) => { const t = cfgOf(d).themes.find((x) => x.id === id); if (t) t.name = name; });
}

/** Next unused palette color, given the themes in a draft (kept in sync with model.js PALETTE). */
const PALETTE_NAMES = ['Blue', 'Sky', 'Teal', 'Green', 'Lime', 'Olive', 'Amber', 'Orange', 'Coral', 'Rose', 'Magenta', 'Plum', 'Purple', 'Indigo', 'Brown', 'Slate'];
const fallbackColor = (id) => { let h = 0; for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0; return PALETTE_NAMES[Math.abs(h) % PALETTE_NAMES.length]; };
function nextColor(themes) {
  const used = new Map();
  themes.forEach((t) => { const c = PALETTE_NAMES.includes(t.color) ? t.color : fallbackColor(t.id || ''); used.set(c, (used.get(c) || 0) + 1); });
  const min = Math.min(...PALETTE_NAMES.map((n) => used.get(n) || 0));
  return ASSIGN_ORDER.find((n) => (used.get(n) || 0) === min);
}
// Order new themes take colors in: each next color is far from the previous ones, so early themes are easy to tell apart.
const ASSIGN_ORDER = ['Blue', 'Orange', 'Teal', 'Magenta', 'Lime', 'Purple', 'Amber', 'Sky', 'Rose', 'Green', 'Brown', 'Indigo', 'Coral', 'Olive', 'Plum', 'Slate'];

export function setThemeColor(id, color) {
  return mutate((d) => { const t = cfgOf(d).themes.find((x) => x.id === id); if (t) t.color = color; });
}

/** Put a question in a theme (or none). Leaving a theme clears its approved/variant flags there. */
function assignTheme(x, themeId) {
  if (x.themeId === themeId) return;
  delete x.standard;
  delete x.variantOf;
  if (themeId) x.themeId = themeId; else delete x.themeId;
}

/** Move questions into a theme, creating it if `create` is given ({ name }). Feeds the matching check. */
export function addToTheme(ids, themeId, create = null) {
  const by = userLabel();
  return mutate((d) => {
    const cfg = cfgOf(d);
    if (create && !cfg.themes.some((t) => t.id === themeId)) cfg.themes.push({ id: themeId, name: create.name, color: create.color || nextColor(cfg.themes), createdAt: now(), by });
    const anchor = d.items.find((x) => x.themeId === themeId && !ids.includes(x.id));
    d.items.forEach((x) => { if (ids.includes(x.id)) assignTheme(x, themeId); });
    if (anchor) for (const id of ids) addCheckPairs(d, [anchor.id, id], true);
  });
}

export function removeFromTheme(itemIds) {
  const ids = [].concat(itemIds);
  return mutate((d) => {
    for (const id of ids) {
      const x = d.items.find((i) => i.id === id);
      if (!x || !x.themeId) continue;
      const anchor = d.items.find((i) => i.themeId === x.themeId && i.id !== id && !ids.includes(i.id));
      assignTheme(x, null);
      if (anchor) addCheckPairs(d, [anchor.id, id], false);
    }
  });
}

/** Mark one question's answer as the approved answer for its theme. */
export function setApproved(themeId, itemId) {
  return mutate((d) => {
    d.items.forEach((x) => {
      if (x.themeId !== themeId) return;
      if (x.id === itemId) { x.standard = true; delete x.variantOf; }
      else { delete x.standard; if (itemId) x.variantOf = itemId; else delete x.variantOf; }
    });
  });
}

/** Move every question from one theme into another, then remove the empty theme. */
export function mergeThemes(fromId, toId) {
  return mutate((d) => {
    const cfg = cfgOf(d);
    const target = d.items.find((x) => x.themeId === toId && x.standard);
    d.items.forEach((x) => {
      if (x.themeId !== fromId) return;
      x.themeId = toId;
      if (target) { delete x.standard; x.variantOf = target.id; }
      else delete x.variantOf;
    });
    cfg.themes = cfg.themes.filter((t) => t.id !== fromId);
  });
}

export function deleteTheme(id) {
  return mutate((d) => {
    const cfg = cfgOf(d);
    cfg.themes = cfg.themes.filter((t) => t.id !== id);
    d.items.forEach((x) => { if (x.themeId === id) assignTheme(x, null); });
  });
}

/** Snapshot of all theme assignments, for undo. */
export function themeSnapshot() {
  return {
    themes: structuredClone(state.config.themes),
    members: state.items.map((x) => ({ id: x.id, themeId: x.themeId, standard: x.standard, variantOf: x.variantOf })),
  };
}

export function restoreThemes(snap) {
  const byId = new Map(snap.members.map((m) => [m.id, m]));
  return mutate((d) => {
    cfgOf(d).themes = structuredClone(snap.themes);
    d.items.forEach((x) => {
      const m = byId.get(x.id);
      if (!m) return;
      for (const k of ['themeId', 'standard', 'variantOf']) { if (m[k] == null) delete x[k]; else x[k] = m[k]; }
    });
  });
}

// ---------- Review decisions ----------
function resolveEntry(d, entry) {
  const cfg = cfgOf(d);
  cfg.review.resolved = cfg.review.resolved.filter((r) => r.key !== entry.key);
  cfg.review.resolved.push({ ...entry, at: now(), by: userLabel() });
}

function addCheckPairs(d, ids, related) {
  const cfg = cfgOf(d);
  if (!Array.isArray(cfg.matchCheck)) cfg.matchCheck = structuredClone(state.config.matchCheck || []);
  for (let i = 1; i < ids.length; i++) {
    const a = ids[0], b = ids[i];
    cfg.matchCheck = cfg.matchCheck.filter((p) => !((p.a === a && p.b === b) || (p.a === b && p.b === a)));
    cfg.matchCheck.push({ a, b, related, label: related ? 'topic' : 'unrelated', from: 'review' });
  }
}

/** Record a matching example: "same", "topic" or "unrelated". */
export function labelPair(a, b, label, from = 'calibration') {
  const by = userLabel();
  return mutate((d) => {
    const cfg = cfgOf(d);
    if (!Array.isArray(cfg.matchCheck)) cfg.matchCheck = structuredClone(state.config.matchCheck || []);
    cfg.matchCheck = cfg.matchCheck.filter((p) => !((p.a === a && p.b === b) || (p.a === b && p.b === a)));
    cfg.matchCheck.push({ a, b, label, related: label !== 'unrelated', from, at: now(), by });
  });
}

export function unlabelPair(a, b) {
  return mutate((d) => {
    const cfg = cfgOf(d);
    if (!Array.isArray(cfg.matchCheck)) cfg.matchCheck = structuredClone(state.config.matchCheck || []);
    cfg.matchCheck = cfg.matchCheck.filter((p) => !((p.a === a && p.b === b) || (p.a === b && p.b === a)));
  });
}

/** Best existing theme for free text (by meaning when available). */
export async function matchTheme(text) {
  const idx = getIndex();
  const ids = state.config.themes.map((t) => t.id).filter((id) => state.items.some((i) => i.themeId === id));
  if (!ids.length) return null;
  if (idx.mode === 'meaning') {
    try {
      const v = await semantic.embedText(text, state.items, state.config);
      return idx.bestTheme(v, ids);
    } catch { /* fall back to words */ }
  }
  const m = idx.bestMatch(text);
  return m && m.item.themeId ? { themeId: m.item.themeId, score: m.score } : null;
}

export function dismissGroup(group) {
  return mutate((d) => {
    resolveEntry(d, { key: group.key, ids: group.ids, action: 'dismissed' });
    addCheckPairs(d, group.ids, false);
  });
}

export function linkQuestions(ids, groupKey) {
  return mutate((d) => {
    d.items.forEach((x) => {
      if (!ids.includes(x.id)) return;
      x.related = [...new Set([...(x.related || []), ...ids.filter((i) => i !== x.id)])];
    });
    if (groupKey) resolveEntry(d, { key: groupKey, ids, action: 'linked' });
    addCheckPairs(d, ids, true);
  });
}

/** Approve one answer for a set of questions, and file them under one theme. */
export function saveStandard(ids, standardId, answer, groupKey, themeName, themeId) {
  const by = userLabel();
  return mutate((d) => {
    const cfg = cfgOf(d);
    if (!cfg.themes.some((t) => t.id === themeId)) cfg.themes.push({ id: themeId, name: themeName, color: nextColor(cfg.themes), createdAt: now(), by });
    else cfg.themes.find((t) => t.id === themeId).name = themeName;
    d.items.forEach((x) => {
      if (!ids.includes(x.id)) return;
      x.themeId = themeId;
      if (x.id === standardId) {
        x.standard = true;
        delete x.variantOf;
        if (answer && answer.trim() && answer.trim() !== x.answer) {
          x.answer = answer.trim();
          x.updatedAt = now();
          x.updatedBy = by;
        }
      } else {
        delete x.standard;
        x.variantOf = standardId;
      }
    });
    if (groupKey) resolveEntry(d, { key: groupKey, ids, action: 'standard', standardId });
    addCheckPairs(d, ids, true);
  });
}

export function reopenGroup(key) {
  return mutate((d) => {
    const cfg = cfgOf(d);
    cfg.review.resolved = cfg.review.resolved.filter((r) => r.key !== key);
  });
}

// ---------- Settings ----------
export function updateConfig(patch) {
  return mutate((d) => { d.insightConfig = { ...d.insightConfig, ...structuredClone(patch) }; });
}

export function renameCategory(from, to) {
  return mutate((d) => {
    d.items.forEach((x) => { if (x.topic === from) x.topic = to; });
    d.categories = [...new Set(d.categories.map((c) => (c === from ? to : c)))];
    if (!d.categories.includes(to)) d.categories.push(to);
  });
}
export const addCategory = (name) => mutate((d) => { if (!d.categories.includes(name)) d.categories.push(name); });
export const removeCategory = (name) => mutate((d) => { d.categories = d.categories.filter((c) => c !== name); });

export function normalizeRepNames() {
  return mutate((d) => { d.items.forEach((x) => { x.answeredBy = canonicalRep(x.answeredBy); }); });
}

export function setAccounts(accounts, meta) {
  return mutate((d) => {
    const cfg = cfgOf(d);
    cfg.accounts = { ...(cfg.accounts || {}), ...structuredClone(accounts) };
    cfg.accountsImport = meta;
  });
}

// ---------- Import, backup, start fresh ----------
export function importRecords(rows, batch) {
  const by = userLabel();
  return mutate((d) => {
    if (d.items.some((x) => x.importBatch === batch)) return;
    let id = nextId(d.items);
    rows.forEach((r) => {
      const rec = { id: id++, ...r, createdBy: by, createdAt: now(), importBatch: batch };
      Object.keys(rec).forEach((k) => (rec[k] === '' || rec[k] == null) && delete rec[k]);
      d.items.push(rec);
      if (!d.categories.includes(r.topic)) d.categories.push(r.topic);
    });
    cfgOf(d).lastImport = { batch, at: now(), by, count: rows.length };
  });
}

export function undoImport(batch) {
  return mutate((d) => {
    d.items = d.items.filter((x) => x.importBatch !== batch);
    if (d.insightConfig.lastImport?.batch === batch) delete d.insightConfig.lastImport;
  });
}

export function backupData() {
  return {
    app: 'prospect-qa-hub', version: 2, exportedAt: now(), exportedBy: userLabel(),
    items: structuredClone(state.items), categories: [...state.categories], insightConfig: structuredClone(state.config),
  };
}

export function restoreBackup(b) {
  return mutate((d) => {
    d.items = structuredClone(b.items);
    d.categories = [...(b.categories || [])];
    d.insightConfig = structuredClone(b.insightConfig || {});
  });
}

/** keep: { categories, rules, approved } */
export function startFresh(keep) {
  return mutate((d) => {
    const cfg = cfgOf(d);
    const keptItems = keep.approved ? d.items.filter((x) => x.standard && x.themeId) : [];
    keptItems.forEach((x) => { delete x.callId; delete x.variantOf; delete x.related; });
    const keptThemes = new Set(keptItems.map((x) => x.themeId));
    const next = keep.rules
      ? { ...cfg }
      : { ...structuredClone(DEFAULT_CONFIG) };
    next.calls = [];
    next.themes = cfg.themes.filter((t) => keptThemes.has(t.id));
    next.review = { resolved: [] };
    next.matchCheck = [];
    next.accounts = cfg.accounts || {};
    delete next.lastImport;
    d.items = keptItems;
    d.categories = keep.categories ? d.categories : [...new Set(keptItems.map((x) => x.topic))];
    d.insightConfig = next;
  });
}

// ---------- Derived ----------
export const getItem = (id) => state.items.find((x) => x.id === id);
export const semanticStatus = () => semantic.status;
export const currentVectors = () => (semanticOn() ? vectors : null);

export function openGroups() {
  const resolved = new Set(state.config.review.resolved.map((r) => r.key));
  return getIndex().groups().filter((g) => {
    if (resolved.has(g.key)) return false;
    const members = g.ids.map(getItem);
    const t = members[0]?.themeId;
    return !(t && members.every((m) => m.themeId === t));
  });
}

export const companyOf = (i) => i.company || splitAsker(i.askedBy).company || '';
export const contactOf = (i) => i.contact || splitAsker(i.askedBy).person || '';
