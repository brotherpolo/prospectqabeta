// Firebase sign-in and Firestore sync.
// Same project, document path and data shape as the original app, so both versions
// can read and write the same dataset during the transition.

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signOut as fbSignOut, sendPasswordResetEmail,
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import {
  initializeFirestore, getFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, onSnapshot, runTransaction, setDoc,
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

const dataRef = doc(db, 'artifacts', APP_ID, 'public', DATA_DOC);
let unsubscribe = null;
let currentUser = null;

// Firestore rejects `undefined`; JSON round-trip drops it.
const clean = (v) => JSON.parse(JSON.stringify(v));

export function start({ onUser, onData, onStatus, onError }) {
  onAuthStateChanged(auth, (user) => {
    currentUser = user;
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    onUser(user);
    if (!user) return;

    unsubscribe = onSnapshot(dataRef, { includeMetadataChanges: true }, async (snap) => {
      onStatus(snap.metadata.fromCache && !navigator.onLine ? 'offline' : snap.metadata.hasPendingWrites ? 'saving' : 'synced');
      if (!snap.exists()) {
        if (snap.metadata.fromCache) return; // wait for the server before deciding the dataset is missing
        await seedDataset();
        return;
      }
      const d = snap.data() || {};
      onData({
        items: Array.isArray(d.items) ? d.items : [],
        categories: Array.isArray(d.categories) ? d.categories : [],
        insightConfig: d.insightConfig || null,
        lastUpdated: d.lastUpdated,
        updatedBy: d.updatedBy,
      });
    }, (err) => {
      console.warn('Firestore read error:', err);
      onError(err.code === 'permission-denied'
        ? 'Signed in, but this account can’t read the dataset. Ask an admin to add your UID to the Firestore rules.'
        : `Couldn't load the dataset: ${err.message}`);
    });
  });

  window.addEventListener('online', () => onStatus('synced'));
  window.addEventListener('offline', () => onStatus('offline'));
}

/** First run only: write the starter dataset, as the original app did. */
async function seedDataset() {
  const { SEED_DATA } = await import('./seed.js');
  try {
    await setDoc(dataRef, {
      items: SEED_DATA,
      categories: [...new Set(SEED_DATA.map((d) => d.topic))],
      insightConfig: null,
      lastUpdated: new Date().toISOString(),
      updatedBy: currentUser?.email || currentUser?.uid || 'seed',
    });
  } catch (err) {
    console.warn('Could not create starter dataset:', err);
  }
}

/**
 * Read-modify-write inside a transaction. If someone else saves first, Firestore re-runs `fn`
 * on their version, so neither change is lost.
 */
export async function commit(fn) {
  if (!currentUser) throw new Error('Sign in to save changes.');
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(dataRef);
    const d = snap.exists() ? snap.data() : {};
    const draft = {
      items: structuredClone(Array.isArray(d.items) ? d.items : []),
      categories: [...(Array.isArray(d.categories) ? d.categories : [])],
      insightConfig: structuredClone(d.insightConfig || {}),
    };
    fn(draft);
    tx.set(dataRef, clean({
      items: draft.items,
      categories: draft.categories,
      insightConfig: draft.insightConfig,
      lastUpdated: new Date().toISOString(),
      updatedBy: currentUser.email || currentUser.uid,
    }));
  });
}

export const signIn = (email, pw) => signInWithEmailAndPassword(auth, email, pw);
export const signUp = (email, pw) => createUserWithEmailAndPassword(auth, email, pw);
export const resetPassword = (email) => sendPasswordResetEmail(auth, email);
export const signOut = () => fbSignOut(auth);
