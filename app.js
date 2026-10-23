import * as sync from './sync.js';
import {
  state, subscribe, configureStore, receiveCloud, setUser, setSync, openGroups,
} from './store.js';
import { toast, toastError, openDialog } from './ui.js';
import { esc, icon, isTyping } from './utils.js';
import { openQuestionDialog, openCategoriesDialog, openAccountDialog, openMoreDialog } from './dialogs.js';
import { openImportDialog } from './import.js';
import { openLogCall } from './logcall.js';
import * as library from './library.js';
import { semanticStatus } from './store.js';
import { computeInbox } from './model.js';

// Overview and Library load with the page; the other views load the first time they're opened.
const VIEWS = {
  overview: () => import('./overview.js'),
  inbox: () => import('./inbox.js'),
  library: () => Promise.resolve(library),
  review: () => import('./review.js'),
  themes: () => import('./themes.js'),
  reps: () => import('./reps.js'),
  insights: () => import('./insights.js'),
  calls: () => import('./calls.js'),
  complete: () => import('./complete.js'),
  rules: () => import('./rules.js'),
  calibrate: () => import('./calibrate.js'),
  summary: () => import('./summary.js'),
};
const TITLES = { overview: 'Overview', inbox: 'To do', library: 'Library', review: 'Review', themes: 'Themes', reps: 'Reps', insights: 'Insights', calls: 'Calls', complete: 'Complete records', rules: 'Matching rules', calibrate: 'Calibrate matching', summary: 'Meeting summary' };

const $ = (s) => document.querySelector(s);
const viewEl = $('#view');
let current = { name: null, mod: null };
let routeSeq = 0;

// ---------- Routing: #/library/35, #/review?tab=pick&ids=1,2 ----------
function parseHash() {
  const [path, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const [name, id] = path.split('/');
  const params = Object.fromEntries(new URLSearchParams(query));
  if (id) params.id = id;
  return { name: VIEWS[name] ? name : 'overview', params };
}

async function route() {
  if (!state.user || !state.loaded) return;
  const { name, params } = parseHash();
  const seq = ++routeSeq;
  current = { name, mod: null, pending: true };
  const mod = await VIEWS[name]();
  if (seq !== routeSeq) return; // a newer navigation won
  current = { name, mod };
  mod.mount(viewEl, params);
  document.querySelectorAll('[data-route]').forEach((a) => {
    if (a.dataset.route === name) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  document.title = `${TITLES[name]} · Prospect Q&A Hub`;
}

window.addEventListener('hashchange', () => {
  route();
  viewEl.focus({ preventScroll: true });
  window.scrollTo(0, 0);
});

// ---------- Shell updates ----------
function paintShell() {
  const u = state.user;
  document.querySelectorAll('[data-user-email]').forEach((el) => { el.textContent = u?.email || 'Signed in'; });
  document.querySelectorAll('[data-user-initial]').forEach((el) => { el.textContent = (u?.email || '?')[0]; });
  document.querySelectorAll('[data-count="library"]').forEach((el) => { el.textContent = state.items.length || ''; });
  const n = state.loaded ? openGroups().length : 0;
  document.querySelectorAll('[data-count="review"]').forEach((el) => { el.textContent = n; el.hidden = !n; });
  document.querySelectorAll('[data-count="review-tab"]').forEach((el) => { el.textContent = n ? ` · ${n}` : ''; });
  const incomplete = state.loaded ? state.items.filter((i) => i.kind !== 'feedback' && (!i.askedAt || !(i.company || /\(.+\)/.test(i.askedBy)))).length : 0;
  document.querySelectorAll('[data-count="complete"]').forEach((el) => { el.textContent = incomplete; el.hidden = !incomplete; });
  const todo = state.loaded ? computeInbox().count : 0;
  document.querySelectorAll('[data-count="inbox"]').forEach((el) => { el.textContent = todo > 99 ? '99+' : todo; el.hidden = !todo; });
  document.querySelectorAll('[data-count="inbox-tab"]').forEach((el) => { el.textContent = todo ? ` · ${todo > 99 ? '99+' : todo}` : ''; });
  const sem = semanticStatus();
  const on = state.config.semanticMatching !== false;
  document.querySelectorAll('[data-sem-status]').forEach((el) => {
    el.dataset.state = !on ? 'off' : sem.state;
    el.textContent = !on ? 'Smart matching off' : sem.state === 'ready' ? 'Smart matching on'
      : sem.state === 'error' ? 'Word matching only' : `Loading smart matching${sem.progress ? ` ${sem.progress}%` : '…'}`;
  });
}

let lastUid = undefined;
subscribe(() => {
  const uid = state.user?.uid ?? null;
  if (uid !== lastUid) {
    lastUid = uid;
    $('#boot').hidden = true;
    $('#auth').hidden = !!uid;
    $('#app').hidden = !uid;
    current = { name: null, mod: null };
    viewEl.innerHTML = uid ? '<div class="boot" role="status" style="min-height:60vh">Loading the library…</div>' : '';
  }
  if (uid && state.loaded) {
    if (!current.mod && !current.pending) route();
    else if (current.mod) current.mod.update(); // a screen still loading renders fresh data when it mounts
  }
  paintShell();
});

// ---------- Firebase wiring ----------
configureStore({ commit: sync.commit, error: toastError });
sync.start({
  onUser: setUser,
  onData: receiveCloud,
  onStatus: setSync,
  onError: (msg) => {
    if (!state.loaded && state.user) {
      viewEl.innerHTML = `<div class="card empty" style="margin-top:40px"><strong>Can’t open the dataset</strong><span>${esc(msg)}</span>
        <button type="button" class="btn btn-sm" data-action="account">Show my user ID</button></div>`;
    } else toast(msg, { tone: 'error', duration: 10000 });
  },
});

// ---------- Sign-in form ----------
let signUp = false;
const authForm = $('#auth-form');
const authErr = $('#auth-error');
const authNote = $('#auth-note');
function setAuthMode(up) {
  signUp = up;
  $('#auth-title').textContent = up ? 'Create an account' : 'Sign in';
  $('#auth-desc').textContent = up
    ? 'After signing up, share your user ID with an admin so they can grant access.'
    : 'Use the account your team authorized for the shared dataset.';
  $('#auth-submit').textContent = up ? 'Create account' : 'Sign in';
  $('#auth-toggle').textContent = up ? 'I already have an account' : 'Create an account';
  $('#auth-password').autocomplete = up ? 'new-password' : 'current-password';
  authErr.hidden = true;
}
$('#auth-toggle').addEventListener('click', () => setAuthMode(!signUp));

const friendlyAuth = (err) => ({
  'auth/invalid-credential': 'That email and password don’t match an account.',
  'auth/wrong-password': 'That email and password don’t match an account.',
  'auth/user-not-found': 'That email and password don’t match an account.',
  'auth/invalid-email': 'Enter a valid email address.',
  'auth/email-already-in-use': 'An account with that email already exists. Sign in instead.',
  'auth/weak-password': 'Use a password of at least 6 characters.',
  'auth/too-many-requests': 'Too many attempts. Wait a minute, then try again.',
  'auth/network-request-failed': 'Can’t reach the sign-in service. Check your connection.',
}[err.code] || err.message);

authForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  authErr.hidden = true;
  authNote.hidden = true;
  const email = $('#auth-email').value.trim();
  const pw = $('#auth-password').value;
  if (!email || pw.length < 6) {
    authErr.textContent = 'Enter your email and a password of at least 6 characters.';
    authErr.hidden = false;
    return;
  }
  const btn = $('#auth-submit');
  btn.disabled = true;
  try {
    if (signUp) { await sync.signUp(email, pw); toast('Account created'); }
    else await sync.signIn(email, pw);
    authForm.reset();
  } catch (err) {
    authErr.textContent = friendlyAuth(err);
    authErr.hidden = false;
  } finally {
    btn.disabled = false;
  }
});

$('#auth-reset').addEventListener('click', async () => {
  const email = $('#auth-email').value.trim();
  authErr.hidden = true;
  authNote.hidden = true;
  if (!email) { authErr.textContent = 'Enter your email above, then select “Forgot password?” again.'; authErr.hidden = false; return; }
  try {
    await sync.resetPassword(email);
    authNote.textContent = `If an account exists for ${email}, a reset link is on its way.`;
    authNote.hidden = false;
  } catch (err) {
    authErr.textContent = friendlyAuth(err);
    authErr.hidden = false;
  }
});

// ---------- Global actions ----------
const actions = {
  import: openImportDialog,
  categories: openCategoriesDialog,
  account: openAccountDialog,
  palette: openPalette,
  more: () => openMoreDialog(actions),
  new: () => openQuestionDialog(null, { onSaved: (id) => { location.hash = `#/library/${id}`; } }),
  log: () => openLogCall(),
  install: () => installApp(),
  canInstall: () => canInstall(),
};

// ---------- Install as an app (Android, iPhone, desktop) ----------
let installPrompt = null;
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const canInstall = () => !isStandalone() && (!!installPrompt || isIOS);
function paintInstall() {
  document.querySelectorAll('[data-action="install"]').forEach((el) => { el.hidden = !canInstall(); });
}
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; paintInstall(); });
window.addEventListener('appinstalled', () => { installPrompt = null; paintInstall(); toast('Installed. Open it from your home screen or app list.'); });

async function installApp() {
  if (installPrompt) {
    installPrompt.prompt();
    const choice = await installPrompt.userChoice.catch(() => null);
    installPrompt = null;
    paintInstall();
    if (choice?.outcome === 'accepted') toast('Installing…');
    return;
  }
  const iosSafari = isIOS && /Safari/.test(navigator.userAgent) && !/CriOS|FxiOS|EdgiOS/.test(navigator.userAgent);
  openDialog({
    title: 'Install Q&A Hub',
    body: isIOS ? `
      ${iosSafari ? '' : '<p class="form-error">On iPhone and iPad, apps can only be installed from <strong>Safari</strong>. Open this page in Safari first.</p>'}
      <ol class="install-steps">
        <li>Tap the <strong>Share</strong> button <span class="muted">(the square with an arrow, at the bottom or top of Safari)</span>.</li>
        <li>Scroll down and tap <strong>Add to Home Screen</strong>, then <strong>Add</strong>.</li>
        <li>Open <strong>Q&amp;A Hub</strong> from your home screen. You’ll sign in once more there; iPhone keeps installed apps separate from Safari.</li>
      </ol>`
      : `<p>Use your browser’s menu: <strong>Install app</strong> or <strong>Add to Home screen</strong> (Chrome and Edge), or <strong>Install</strong> in the address bar on a computer.</p>
         <p class="muted">If you don’t see the option, the app may already be installed, or this browser doesn’t support installing.</p>`,
    foot: '<div class="right"><button type="button" class="btn btn-primary" data-close>Got it</button></div>',
  });
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('Offline support unavailable:', err)); });
}
setTimeout(paintInstall, 0);

$('#app').addEventListener('click', (e) => {
  const b = e.target.closest('[data-action]');
  if (b && actions[b.dataset.action]) actions[b.dataset.action]();
});

document.addEventListener('keydown', (e) => {
  if (!state.user) return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); return; }
  if ($('#dialog').open || isTyping(document.activeElement) || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === '/') {
    e.preventDefault();
    if (current.name !== 'library') { location.hash = '#/library'; setTimeout(library.focusSearch, 50); }
    else library.focusSearch();
  } else if (e.key === 'n') { e.preventDefault(); actions.new(); }
  else if (e.key === 'l') { e.preventDefault(); actions.log(); }
  else if (e.key === 'e' && current.name === 'library') { e.preventDefault(); library.editSelected(); }
  else if (e.key === '?') { e.preventDefault(); openShortcuts(); }
});

function openShortcuts() {
  const k = navigator.platform.includes('Mac') ? '⌘' : 'Ctrl';
  openDialog({
    title: 'Keyboard shortcuts',
    body: `<table class="table"><tbody>
      ${[[`${k} K`, 'Quick find'], ['/', 'Search the library'], ['l', 'Log a call'], ['n', 'New single question'], ['e', 'Edit selected question'], [`${k} Enter`, 'Save in the question editor'], ['Esc', 'Close a dialog'], ['?', 'Show this list']]
        .map(([a, b]) => `<tr><td><span class="kbd">${a}</span></td><td>${b}</td></tr>`).join('')}
    </tbody></table>`,
  });
}

// ---------- Quick find (⌘K) ----------
function openPalette() {
  const commands = [
    { label: 'Log a call', icon: 'plus', run: actions.log },
    { label: 'New single question', icon: 'plus', run: actions.new },
    { label: 'Import questions', icon: 'upload', run: actions.import },
    ...Object.entries(TITLES).map(([k, t]) => ({ label: `Go to ${t}`, icon: { overview: 'chart', inbox: 'check', library: 'library', review: 'review', themes: 'tag', reps: 'user', insights: 'chart', calls: 'calendar', complete: 'flag', rules: 'sliders', calibrate: 'sliders', summary: 'chart' }[k], run: () => { location.hash = `#/${k}`; } })),
    { label: 'Manage categories', icon: 'tag', run: actions.categories },
    { label: 'Keyboard shortcuts', icon: 'more', run: openShortcuts },
  ];
  let results = [];
  let active = 0;

  openDialog({
    label: 'Quick find',
    raw: `<input class="palette-input" id="pal-input" role="combobox" aria-expanded="true" aria-controls="pal-list"
            aria-label="Find a question or action" placeholder="Find a question, or type a command" autocomplete="off">
          <ul class="palette-list" id="pal-list" role="listbox"></ul>`,
    onMount: (d) => {
      const input = d.querySelector('#pal-input');
      const list = d.querySelector('#pal-list');
      const render = () => {
        const q = input.value.trim().toLowerCase();
        const words = q.split(/\s+/).filter(Boolean);
        const qs = words.length
          ? state.items.filter((i) => {
              const h = `${i.question} ${i.answer} ${i.askedBy} #${i.id}`.toLowerCase();
              return words.every((w) => h.includes(w));
            }).sort((a, b) => (b.standard ? 1 : 0) - (a.standard ? 1 : 0)).slice(0, 8)
          : [];
        const cmds = commands.filter((c) => !q || c.label.toLowerCase().includes(q));
        results = [
          ...qs.map((i) => ({ type: 'q', item: i, run: () => { location.hash = `#/library/${i.id}`; } })),
          ...cmds.map((c) => ({ type: 'c', ...c })),
        ];
        active = Math.min(active, Math.max(0, results.length - 1));
        let html = '';
        if (qs.length) html += '<li class="palette-group" role="presentation">Questions</li>';
        results.forEach((r, n) => {
          if (r.type === 'c' && (n === 0 || results[n - 1].type === 'q')) html += '<li class="palette-group" role="presentation">Actions</li>';
          html += r.type === 'q'
            ? `<li class="palette-item" role="option" id="pal-${n}" data-n="${n}" aria-selected="${n === active}"><span class="mono">#${r.item.id}</span><span class="grow">${esc(r.item.question)}</span></li>`
            : `<li class="palette-item" role="option" id="pal-${n}" data-n="${n}" aria-selected="${n === active}">${icon(r.icon, 'icon-sm')}<span class="grow">${esc(r.label)}</span></li>`;
        });
        list.innerHTML = html || '<li class="palette-group">No matches</li>';
        input.setAttribute('aria-activedescendant', results.length ? `pal-${active}` : '');
        list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
      };
      const run = (n) => { const r = results[n]; if (!r) return; d.close(); r.run(); };
      input.addEventListener('input', () => { active = 0; render(); });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, results.length - 1); render(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); render(); }
        else if (e.key === 'Enter') { e.preventDefault(); run(active); }
      });
      list.addEventListener('click', (e) => { const li = e.target.closest('[data-n]'); if (li) run(Number(li.dataset.n)); });
      render();
      input.focus();
    },
  });
}
