// Firebase sign-in and Firestore sync, for both database layouts:
//
//  • "single"      – the original layout: everything in one document (artifacts/{app}/public/{doc}).
//                    Saves re-run the change inside a transaction on the whole document.
//  • "collections" – the new layout, under that same document:
//                    questions/{id}, themes/{id}, calls/{id}, labels/{a-b}, meta/settings, history/{auto}.
//                    Saves write only the fields that changed, and every question change is logged in history.
//
// The app uses "collections" once meta/settings exists with schema 2 (written last by the migration);
// until then it keeps using the single document. Open copies switch over automatically.

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signOut as fbSignOut, sendPasswordResetEmail,
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import {
  initializeFirestore, getFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, collection, onSnapshot, runTransaction, setDoc, deleteDoc, getDocs, query, where, limit,
  writeBatch, deleteField, FieldPath, getCountFromServer, getDoc,
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';
import { firebaseConfig, APP_ID, DATA_DOC } from './config.js';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

// A local cache makes repeat visits open instantly from disk, then refresh from the server.
let db;
try {
  db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
} catch {
  db = getFirestore(app);
}

const ROOT = ['artifacts', APP_ID, 'public', DATA_DOC];
const dataRef = doc(db, ...ROOT);
const metaRef = doc(db, ...ROOT, 'meta', 'settings');
const col = (name) => collection(db, ...ROOT, name);
const safeId = (id) => String(id).replace(/\//g, '_');
const qRef = (id) => doc(db, ...ROOT, 'questions', safeId(id));
const pairKey = (p) => (p.a < p.b ? `${p.a}-${p.b}` : `${p.b}-${p.a}`);
const AUX = { themes: (t) => t.id, calls: (c) => c.id, matchCheck: pairKey };
const AUX_COLL = { themes: 'themes', calls: 'calls', matchCheck: 'labels' };

let unsubs = [];
let currentUser = null;
let mode = null; // 'single' | 'collections'
let hooks = null;
export const getMode = () => mode;
export const getMeta = () => live?.settings || null;

// Firestore rejects `undefined`; JSON round-trip drops it.
const clean = (v) => JSON.parse(JSON.stringify(v ?? null));
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const who = () => currentUser?.email || currentUser?.uid || 'unknown';
const stop = () => { unsubs.forEach((u) => u()); unsubs = []; };

export function start(h) {
  hooks = h;
  onAuthStateChanged(auth, (user) => {
    currentUser = user;
    stop();
    mode = null;
    h.onUser(user);
    if (!user) return;
    // Watch for the new layout; switch (or reload) when it appears.
    unsubs.push(onSnapshot(metaRef, (snap) => {
      const migrated = snap.exists() && snap.data()?.schema === 2;
      if (migrated && mode === 'single') { location.reload(); return; }
      if (migrated && mode !== 'collections') { mode = 'collections'; startCollections(snap); }
      else if (mode === 'collections') settingsSnap(snap);
      else if (!migrated && mode === null) { mode = 'single'; startSingle(); }
    }, () => {
      // Old rules don't allow reading the new layout yet: carry on with the single document.
      if (mode === null) { mode = 'single'; startSingle(); }
    }));
  });
  window.addEventListener('online', () => h.onStatus('synced'));
  window.addEventListener('offline', () => h.onStatus('offline'));
}

const readError = (err) => {
  console.warn('Firestore read error:', err);
  hooks.onError(err.code === 'permission-denied'
    ? 'Signed in, but this account can’t read the dataset. Ask an admin to add your UID to the Firestore rules.'
    : `Couldn't load the dataset: ${err.message}`);
};

// ---------- Single document ----------
function startSingle() {
  unsubs.push(onSnapshot(dataRef, { includeMetadataChanges: true }, async (snap) => {
    hooks.onStatus(snap.metadata.fromCache && !navigator.onLine ? 'offline' : snap.metadata.hasPendingWrites ? 'saving' : 'synced');
    if (!snap.exists()) {
      if (snap.metadata.fromCache) return;
      await seedDataset();
      return;
    }
    const d = snap.data() || {};
    hooks.onData({
      items: Array.isArray(d.items) ? d.items : [],
      categories: Array.isArray(d.categories) ? d.categories : [],
      insightConfig: d.insightConfig || null,
    });
  }, readError));
}

async function seedDataset() {
  const { SEED_DATA } = await import('./seed.js');
  try {
    await setDoc(dataRef, {
      items: SEED_DATA, categories: [...new Set(SEED_DATA.map((d) => d.topic))], insightConfig: null,
      lastUpdated: new Date().toISOString(), updatedBy: who(),
    });
  } catch (err) { console.warn('Could not create starter dataset:', err); }
}

// ---------- Collections ----------
const live = { questions: new Map(), themes: new Map(), calls: new Map(), labels: new Map(), settings: null };
const seen = new Set();
let assembleTimer = null;

function settingsSnap(snap) {
  live.settings = snap.exists() ? snap.data() : null;
  seen.add('settings');
  scheduleAssemble();
}

function startCollections(firstMeta) {
  Object.values(live).forEach((m) => m instanceof Map && m.clear());
  seen.clear();
  settingsSnap(firstMeta);
  for (const name of ['questions', 'themes', 'calls', 'labels']) {
    unsubs.push(onSnapshot(col(name), { includeMetadataChanges: name === 'questions' }, (snap) => {
      if (name === 'questions') hooks.onStatus(snap.metadata.fromCache && !navigator.onLine ? 'offline' : snap.metadata.hasPendingWrites ? 'saving' : 'synced');
      snap.docChanges().forEach((ch) => {
        if (ch.type === 'removed') live[name].delete(ch.doc.id);
        else live[name].set(ch.doc.id, ch.doc.data());
      });
      seen.add(name);
      scheduleAssemble();
    }, readError));
  }
}

function scheduleAssemble() {
  if (!['settings', 'questions', 'themes', 'calls', 'labels'].every((k) => seen.has(k))) return;
  clearTimeout(assembleTimer);
  assembleTimer = setTimeout(() => {
    const s = live.settings || {};
    hooks.onData({
      items: [...live.questions.values()].filter((q) => typeof q.id === 'number').sort((a, b) => a.id - b.id),
      categories: Array.isArray(s.categories) ? s.categories : [],
      insightConfig: {
        ...(s.config || {}),
        themes: [...live.themes.values()],
        calls: [...live.calls.values()],
        matchCheck: [...live.labels.values()],
      },
    });
  }, 30);
}

// ---------- Saving ----------
/**
 * Save a change. Single document: re-run `fn` on the latest server copy in a transaction.
 * Collections: write only what differs between `before` and `after`, and log question changes.
 */
export async function commit(fn, before, after) {
  if (!currentUser) throw new Error('Sign in to save changes.');
  if (mode === 'collections') return commitDiff(before, after);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(dataRef);
    const d = snap.exists() ? snap.data() : {};
    const draft = {
      items: structuredClone(Array.isArray(d.items) ? d.items : []),
      categories: [...(Array.isArray(d.categories) ? d.categories : [])],
      insightConfig: structuredClone(d.insightConfig || {}),
    };
    fn(draft);
    tx.set(dataRef, clean({ ...draft, lastUpdated: new Date().toISOString(), updatedBy: who() }));
  });
}

const NO_HISTORY = new Set(['updatedAt', 'updatedBy', 'createdAt', 'createdBy']);
const restOf = (cfg) => { const { themes, calls, matchCheck, ...rest } = cfg || {}; return rest; };

async function commitDiff(before, after) {
  const at = new Date().toISOString(), by = who();
  const ops = []; // [kind, ref, data, ...fieldArgs]
  const creates = [];
  const history = [];

  // Questions: field-level updates
  const bm = new Map(before.items.map((i) => [i.id, i]));
  const am = new Map(after.items.map((i) => [i.id, i]));
  for (const [id, it] of am) {
    const old = bm.get(id);
    if (!old) { creates.push(it); history.push({ qid: id, op: 'create', question: it.question }); continue; }
    const args = [];
    for (const k of new Set([...Object.keys(old), ...Object.keys(it)])) {
      if (same(old[k], it[k])) continue;
      args.push(new FieldPath(k), it[k] === undefined ? deleteField() : clean(it[k]));
      if (!NO_HISTORY.has(k)) history.push({ qid: id, op: 'change', field: k, from: clean(old[k]), to: clean(it[k]) });
    }
    if (args.length) ops.push(['update', qRef(id), null, ...args]);
  }
  for (const [id, old] of bm) {
    if (!am.has(id)) { ops.push(['delete', qRef(id)]); history.push({ qid: id, op: 'delete', question: old.question }); }
  }

  // Themes, calls and labels: one small document each
  for (const [key, keyOf] of Object.entries(AUX)) {
    const b = new Map((before.insightConfig?.[key] || []).map((x) => [String(keyOf(x)), x]));
    const a = new Map((after.insightConfig?.[key] || []).map((x) => [String(keyOf(x)), x]));
    for (const [k, x] of a) if (!same(b.get(k), x)) ops.push(['set', doc(db, ...ROOT, AUX_COLL[key], safeId(k)), clean(x)]);
    for (const k of b.keys()) if (!a.has(k)) ops.push(['delete', doc(db, ...ROOT, AUX_COLL[key], safeId(k))]);
  }

  // Settings: field-level, one entry per top-level setting
  const rb = restOf(before.insightConfig), ra = restOf(after.insightConfig);
  const sargs = [];
  for (const k of new Set([...Object.keys(rb), ...Object.keys(ra)])) {
    if (!same(rb[k], ra[k])) sargs.push(new FieldPath('config', k), ra[k] === undefined ? deleteField() : clean(ra[k]));
  }
  if (!same(before.categories, after.categories)) sargs.push(new FieldPath('categories'), clean(after.categories));
  if (sargs.length) ops.push(['update', metaRef, null, ...sargs]);

  for (const h of history) ops.push(['set', doc(col('history')), clean({ ...h, at, by })]);

  // New questions: refuse to overwrite one someone else created at the same moment.
  for (let i = 0; i < creates.length; i += 200) {
    const chunk = creates.slice(i, i + 200);
    await runTransaction(db, async (tx) => {
      const snaps = await Promise.all(chunk.map((it) => tx.get(qRef(it.id))));
      if (snaps.some((s) => s.exists())) {
        throw new Error('someone else added a question at the same moment. Your copy has been refreshed; please try again.');
      }
      chunk.forEach((it) => tx.set(qRef(it.id), clean(it)));
    });
  }
  for (let i = 0; i < ops.length; i += 400) {
    const batch = writeBatch(db);
    for (const [kind, ref, data, ...args] of ops.slice(i, i + 400)) {
      if (kind === 'set') batch.set(ref, data);
      else if (kind === 'delete') batch.delete(ref);
      else batch.update(ref, ...args);
    }
    await batch.commit();
  }
}

// ---------- History ----------
/** Change history for one question, newest first. Null in the single-document layout. */
export async function historyFor(qid) {
  if (mode !== 'collections') return null;
  const snap = await getDocs(query(col('history'), where('qid', '==', qid), limit(200)));
  return snap.docs.map((d) => d.data()).sort((a, b) => (b.at || '').localeCompare(a.at || ''));
}

// ---------- Migration ----------
/** True if the current rules allow writing the new layout. */
export async function canWriteNewLayout() {
  const probe = doc(db, ...ROOT, 'meta', 'probe');
  try { await setDoc(probe, { at: new Date().toISOString(), by: who() }); await deleteDoc(probe); return true; }
  catch (err) { if (err.code === 'permission-denied') return false; throw err; }
}

/**
 * Copy the single document into the new layout, verify the counts, then switch everyone over
 * by writing meta/settings last. The original document is left in place as a fallback.
 */
export async function migrate(data, onProgress = () => {}) {
  if (mode !== 'single') throw new Error('Already on the new layout.');
  const existing = await getDoc(metaRef);
  if (existing.exists() && existing.data()?.schema === 2) throw new Error('Already moved.');
  const cfg = data.insightConfig || {};
  const sets = {
    questions: (data.items || []).map((it) => [String(it.id), it]),
    themes: (cfg.themes || []).map((t) => [t.id, t]),
    calls: (cfg.calls || []).map((c) => [c.id, c]),
    labels: (cfg.matchCheck || []).map((p) => [pairKey(p), p]),
  };
  // Clear anything left over from an earlier, interrupted attempt.
  onProgress('Preparing');
  for (const name of Object.keys(sets)) {
    const old = await getDocs(col(name));
    for (let i = 0; i < old.docs.length; i += 400) {
      const b = writeBatch(db);
      old.docs.slice(i, i + 400).forEach((d) => b.delete(d.ref));
      await b.commit();
    }
  }
  for (const [name, rows] of Object.entries(sets)) {
    onProgress(`Copying ${rows.length} ${name === 'labels' ? 'matching examples' : name}`);
    for (let i = 0; i < rows.length; i += 400) {
      const b = writeBatch(db);
      rows.slice(i, i + 400).forEach(([id, x]) => b.set(doc(db, ...ROOT, name, safeId(id)), clean(x)));
      await b.commit();
    }
  }
  onProgress('Checking the copy');
  for (const [name, rows] of Object.entries(sets)) {
    const n = (await getCountFromServer(col(name))).data().count;
    if (n !== rows.length) throw new Error(`The copy of ${name} has ${n} of ${rows.length}. Nothing was switched; try again.`);
  }
  onProgress('Switching over');
  const at = new Date().toISOString();
  await setDoc(doc(col('history')), { op: 'migrate', at, by: who(), counts: Object.fromEntries(Object.entries(sets).map(([k, v]) => [k, v.length])) });
  await setDoc(metaRef, clean({ schema: 2, migratedAt: at, migratedBy: who(), fromDoc: DATA_DOC, categories: data.categories || [], config: restOf(cfg) }));
  await setDoc(dataRef, { movedTo: 'collections', movedAt: at }, { merge: true });
  return Object.fromEntries(Object.entries(sets).map(([k, v]) => [k, v.length]));
}

export const signIn = (email, pw) => signInWithEmailAndPassword(auth, email, pw);
export const signUp = (email, pw) => createUserWithEmailAndPassword(auth, email, pw);
export const resetPassword = (email) => sendPasswordResetEmail(auth, email);
export const signOut = () => fbSignOut(auth);
