// App state, derived caches and every data change.
// Changes are applied locally right away, then committed to Firestore in a transaction
// (see sync.js), so two people editing at once no longer overwrite each other.

import { createIndex } from './similarity.js';
import { canonicalRep } from './utils.js';

export const DEFAULT_CONFIG = Object.freeze({
  overlapRatio: 70,
  jaccardRatio: 30,
  shortWordThreshold: 15,
  matchThreshold: 35,
  minShared: 2,
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
});

/** Merge saved config over defaults. Unknown keys are kept so nothing written by other versions is lost. */
export function normalizeConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const merged = { ...structuredClone(DEFAULT_CONFIG), ...c };
  merged.review = { resolved: [], ...(c.review || {}) };
  if (!Array.isArray(merged.review.resolved)) merged.review.resolved = [];
  if (!Array.isArray(merged.customRules)) merged.customRules = structuredClone(DEFAULT_CONFIG.customRules);
  if (!Array.isArray(merged.synonyms)) merged.synonyms = structuredClone(DEFAULT_CONFIG.synonyms);
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
let committer = null;
let onError = (msg) => console.error(msg);

export const subscribe = (fn) => (listeners.add(fn), () => listeners.delete(fn));
const emit = () => listeners.forEach((fn) => fn(state));

export function configureStore({ commit, error }) {
  committer = commit;
  if (error) onError = error;
}

export function getIndex() {
  index ||= createIndex(state.items, state.config);
  return index;
}

function apply(data) {
  state.items = (data.items || []).filter((x) => x && typeof x.id === 'number');
  const cats = new Set(data.categories || []);
  state.items.forEach((i) => i.topic && cats.add(i.topic));
  state.categories = [...cats].sort((a, b) => a.localeCompare(b));
  state.config = normalizeConfig(data.insightConfig);
  index = null;
}

let lastCloud = null;
/** Called by sync.js with each Firestore snapshot. */
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

// ---------- Domain actions ----------

const nextId = (items) => items.reduce((m, i) => Math.max(m, i.id), 0) + 1;
const now = () => new Date().toISOString();

export function saveQuestion(fields, id = null) {
  const by = userLabel();
  const clean = {
    askedBy: fields.askedBy.trim() || 'Unknown Prospect',
    question: fields.question.trim(),
    answer: fields.answer.trim() || 'No answer provided',
    answeredBy: fields.answeredBy.trim() || 'Unassigned',
    topic: fields.topic || 'General Operations',
  };
  let newId = id;
  return mutate((d) => {
    if (id != null) {
      const rec = d.items.find((x) => x.id === id);
      if (rec) Object.assign(rec, clean, { updatedAt: now(), updatedBy: by });
    } else {
      // Reuse the same id if the transaction re-runs.
      if (newId == null || d.items.some((x) => x.id === newId)) newId = nextId(d.items);
      d.items.push({ id: newId, ...clean, createdBy: by, createdAt: now() });
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

export function restoreQuestion(item) {
  return mutate((d) => {
    if (!d.items.some((x) => x.id === item.id)) d.items.push(structuredClone(item));
  });
}

export function renameCategory(from, to) {
  return mutate((d) => {
    d.items.forEach((x) => { if (x.topic === from) x.topic = to; });
    d.categories = [...new Set(d.categories.map((c) => (c === from ? to : c)))];
    if (!d.categories.includes(to)) d.categories.push(to);
  });
}

export const addCategory = (name) =>
  mutate((d) => { if (!d.categories.includes(name)) d.categories.push(name); });

export const removeCategory = (name) =>
  mutate((d) => { d.categories = d.categories.filter((c) => c !== name); });

export function updateConfig(patch) {
  return mutate((d) => { d.insightConfig = { ...d.insightConfig, ...structuredClone(patch) }; });
}

export function normalizeRepNames() {
  return mutate((d) => {
    d.items.forEach((x) => { x.answeredBy = canonicalRep(x.answeredBy); });
  });
}

function resolveEntry(d, entry) {
  d.insightConfig.review ||= { resolved: [] };
  d.insightConfig.review.resolved ||= [];
  d.insightConfig.review.resolved = d.insightConfig.review.resolved.filter((r) => r.key !== entry.key);
  d.insightConfig.review.resolved.push({ ...entry, at: now(), by: userLabel() });
}

export function dismissGroup(group) {
  return mutate((d) => resolveEntry(d, { key: group.key, ids: group.ids, action: 'dismissed' }));
}

export function linkQuestions(ids, groupKey) {
  return mutate((d) => {
    d.items.forEach((x) => {
      if (!ids.includes(x.id)) return;
      x.related = [...new Set([...(x.related || []), ...ids.filter((i) => i !== x.id)])];
    });
    if (groupKey) resolveEntry(d, { key: groupKey, ids, action: 'linked' });
  });
}

export function saveStandard(ids, standardId, answer, groupKey) {
  return mutate((d) => {
    d.items.forEach((x) => {
      if (!ids.includes(x.id)) return;
      if (x.id === standardId) {
        x.standard = true;
        delete x.variantOf;
        if (answer && answer.trim() && answer.trim() !== x.answer) {
          x.answer = answer.trim();
          x.updatedAt = now();
          x.updatedBy = userLabel();
        }
      } else {
        delete x.standard;
        x.variantOf = standardId;
      }
    });
    if (groupKey) resolveEntry(d, { key: groupKey, ids, action: 'standard', standardId });
  });
}

export function reopenGroup(key) {
  return mutate((d) => {
    if (d.insightConfig.review?.resolved) {
      d.insightConfig.review.resolved = d.insightConfig.review.resolved.filter((r) => r.key !== key);
    }
  });
}

export function importRecords(rows, batch) {
  const by = userLabel();
  return mutate((d) => {
    if (d.items.some((x) => x.importBatch === batch)) return; // already applied in a retried transaction
    let id = nextId(d.items);
    const idMap = new Map();
    rows.forEach((r, i) => idMap.set(i, id++));
    rows.forEach((r, i) => {
      const rec = {
        id: idMap.get(i), askedBy: r.askedBy, question: r.question, answer: r.answer,
        answeredBy: r.answeredBy, topic: r.topic, createdBy: by, createdAt: now(), importBatch: batch,
      };
      if (r.variantOf) rec.variantOf = r.variantOf;
      d.items.push(rec);
      if (!d.categories.includes(r.topic)) d.categories.push(r.topic);
    });
    d.insightConfig.lastImport = { batch, at: now(), by, count: rows.length };
  });
}

export function undoImport(batch) {
  return mutate((d) => {
    d.items = d.items.filter((x) => x.importBatch !== batch);
    if (d.insightConfig.lastImport?.batch === batch) delete d.insightConfig.lastImport;
  });
}

// ---------- Derived helpers ----------

export const getItem = (id) => state.items.find((x) => x.id === id);

export function openGroups() {
  const resolved = new Set(state.config.review.resolved.map((r) => r.key));
  return getIndex().groups().filter((g) => {
    if (resolved.has(g.key)) return false;
    // Already organized under one standard answer
    const members = g.ids.map(getItem);
    const std = members.find((m) => m.standard);
    return !(std && members.every((m) => m.id === std.id || m.variantOf === std.id));
  });
}
