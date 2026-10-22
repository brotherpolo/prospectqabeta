// Themes: rename, choose the approved answer, add/remove/move questions, merge and delete.

import {
  state, getItem, getIndex, renameTheme, addToTheme, removeFromTheme, setApproved, mergeThemes, deleteTheme,
  themeSnapshot, restoreThemes, saveThemes,
} from './store.js';
import { effectiveThemes, accountOf, verdictLabel, isQuestion } from './model.js';
import { toast, toastError, confirmDialog, openDialog } from './ui.js';
import { esc, icon, pluralize, uid } from './utils.js';

const ui = { sel: null, q: '', addQ: '', checked: new Set() };
let root = null;

export function mount(el, params) {
  root = el;
  if (params.id) ui.sel = params.id;
  ui.checked = new Set();
  el.onclick = onClick;
  el.onchange = onChange;
  el.oninput = (e) => {
    if (e.target.id === 'theme-filter') { ui.q = e.target.value; paintList(); }
    if (e.target.id === 'theme-add') { ui.addQ = e.target.value; paintAdd(); }
  };
  el.onkeydown = (e) => {
    if (e.target.id === 'theme-name' && e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
    if (e.target.id === 'theme-name' && e.key === 'Escape') { e.target.value = current()?.name || ''; e.target.blur(); }
  };
  update();
}

const confirmed = () => [...state.config.themes]
  .map((t) => ({ ...t, ids: state.items.filter((i) => i.themeId === t.id && isQuestion(i)).map((i) => i.id) }))
  .sort((a, b) => b.ids.length - a.ids.length || a.name.localeCompare(b.name));
const current = () => confirmed().find((t) => t.id === ui.sel);

export function update() {
  if (!root) return;
  const list = confirmed();
  if (!ui.sel || !list.some((t) => t.id === ui.sel)) ui.sel = list[0]?.id || null;
  root.innerHTML = `
    <div class="page">
      <header class="page-head">
        <div>
          <h1 class="page-title">Themes</h1>
          <p class="page-sub">Name each theme, choose its approved answer, and decide which questions belong. Changes save for everyone.</p>
        </div>
        <button type="button" class="btn btn-primary" data-act="new">${icon('plus', 'icon-sm')}New theme</button>
      </header>
      <div class="themes-layout">
        <aside class="card themes-list" aria-label="Themes">
          <label class="search search-sm">${icon('search', 'icon-sm')}<span class="visually-hidden">Filter themes</span>
            <input type="search" id="theme-filter" value="${esc(ui.q)}" placeholder="Filter themes" autocomplete="off"></label>
          <div data-list></div>
        </aside>
        <section class="theme-editor" data-editor aria-live="polite"></section>
      </div>
    </div>`;
  paintList();
  paintEditor();
}

function paintList() {
  const el = root.querySelector('[data-list]');
  const q = ui.q.trim().toLowerCase();
  const list = confirmed().filter((t) => !q || t.name.toLowerCase().includes(q));
  const suggested = effectiveThemes().filter((t) => !t.confirmed && (!q || t.name.toLowerCase().includes(q)));
  el.innerHTML = `
    ${list.length ? list.map((t) => {
      const approved = t.ids.some((id) => getItem(id)?.standard);
      const accts = new Set(t.ids.map((id) => accountOf(getItem(id)))).size;
      return `<button type="button" class="theme-pick" data-sel="${esc(t.id)}" aria-current="${t.id === ui.sel}">
        <span class="theme-pick-name">${esc(t.name)}</span>
        <span class="theme-pick-meta">${pluralize(t.ids.length, 'question')} · ${pluralize(accts, 'account')}${approved ? ' · <span class="ok-text">approved</span>' : ''}</span>
      </button>`;
    }).join('') : `<p class="muted" style="padding:8px 4px">${q ? 'No themes match.' : 'No themes yet.'}</p>`}
    ${suggested.length ? `<div class="theme-list-head">Suggested, not yet confirmed</div>
      ${suggested.map((t) => `<div class="theme-sugg"><span><span class="theme-pick-name">${esc(t.name)}</span><span class="theme-pick-meta">${pluralize(t.ids.length, 'question')}</span></span>
        <button type="button" class="btn btn-sm" data-confirm="${esc(t.id)}">Confirm</button></div>`).join('')}` : ''}`;
}

function paintEditor() {
  const el = root.querySelector('[data-editor]');
  const t = current();
  if (!t) {
    el.innerHTML = `<div class="card empty"><strong>No theme selected</strong><span>Create a theme, or confirm a suggested one.</span></div>`;
    return;
  }
  const members = t.ids.map(getItem).filter(Boolean);
  const approved = members.find((m) => m.standard);
  const others = confirmed().filter((x) => x.id !== t.id);
  const n = ui.checked.size;
  el.innerHTML = `
    <div class="card stack-12">
      <div class="field">
        <label class="field-label" for="theme-name">Theme name</label>
        <div class="add-row"><input class="input theme-name-input" id="theme-name" value="${esc(t.name)}" autocomplete="off">
          <a class="btn" href="#/library?theme=${esc(t.id)}">Open in Library</a></div>
        <span class="field-hint">Press Enter to save. Short names read best on the Overview, e.g. “QR codes” or “LMS pricing”.</span>
      </div>
      <div class="field">
        <span class="field-label">Approved answer</span>
        ${approved ? `<p class="quote">${esc(approved.answer)} <span class="muted">· #${approved.id}</span></p>`
          : '<p class="muted">None yet. Choose “Approve” on the question whose answer should be the standard.</p>'}
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h2 class="card-title">Questions in this theme (${members.length})</h2>
        <span class="toolbar">${n ? `<span class="field-hint">${n} selected</span>
          <label class="visually-hidden" for="move-to">Move selected to</label>
          <select class="select select-inline" id="move-to"><option value="">Move to…</option>${others.map((o) => `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join('')}<option value="__new">New theme…</option></select>
          <button type="button" class="btn btn-sm" data-act="remove-selected">Remove from theme</button>` : '<span class="field-hint">Tick questions to move or remove several at once</span>'}</span></div>
      <div class="member-list">${members.map((m) => `
        <div class="member">
          <input type="checkbox" class="switch" data-check="${m.id}" ${ui.checked.has(m.id) ? 'checked' : ''} aria-label="Select #${m.id}">
          <div class="member-body">
            <a class="member-q" href="#/library/${m.id}"><span class="mono muted">#${m.id}</span> ${esc(m.question)}</a>
            <span class="member-a">${esc(m.answer)}</span>
            <span class="muted member-meta">${esc(accountOf(m))} · ${esc(m.answeredBy)}${m.verdict ? ` · <span class="vbadge v-${m.verdict}">${verdictLabel(m.verdict)}</span>` : ''}</span>
          </div>
          <div class="member-actions">
            ${m.standard ? '<span class="badge badge-ok">Approved</span>' : `<button type="button" class="btn btn-sm" data-approve="${m.id}">Approve</button>`}
            <button type="button" class="icon-btn" data-remove="${m.id}" aria-label="Remove #${m.id} from this theme">${icon('x', 'icon-sm')}</button>
          </div>
        </div>`).join('') || '<p class="muted">No questions. Add some below.</p>'}</div>
    </div>

    <div class="card">
      <div class="card-head"><h2 class="card-title">Add questions</h2><span class="field-hint">Questions already in another theme move here</span></div>
      <label class="search search-sm">${icon('search', 'icon-sm')}<span class="visually-hidden">Find questions to add</span>
        <input type="search" id="theme-add" value="${esc(ui.addQ)}" placeholder="Search by keyword, account or #number" autocomplete="off"></label>
      <div data-add></div>
    </div>

    <div class="card danger-zone">
      <div><h2 class="card-title">Merge or delete</h2><p class="muted">Merging moves every question into the other theme. Deleting keeps the questions; they just leave the theme. Both can be undone.</p></div>
      <div class="toolbar">
        <label class="visually-hidden" for="merge-into">Merge into</label>
        <select class="select select-inline" id="merge-into"><option value="">Merge into…</option>${others.map((o) => `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join('')}</select>
        <button type="button" class="btn btn-danger-outline" data-act="delete">Delete theme</button>
      </div>
    </div>`;
  paintAdd();
}

/** Search results, or (with no search) the questions that most resemble this theme. */
function paintAdd() {
  const el = root.querySelector('[data-add]');
  const t = current();
  if (!el || !t) return;
  const inTheme = new Set(t.ids);
  const q = ui.addQ.trim().toLowerCase();
  const themeName = (id) => state.config.themes.find((x) => x.id === id)?.name;
  let rows;
  if (q) {
    const idq = /^#?(\d+)$/.exec(q);
    rows = state.items.filter((i) => isQuestion(i) && !inTheme.has(i.id) &&
      (idq ? String(i.id) === idq[1] : `${i.question} ${i.answer} ${accountOf(i)}`.toLowerCase().includes(q)))
      .slice(0, 10).map((i) => ({ i, score: null }));
  } else {
    const idx = getIndex();
    const floor = Math.max(idx.threshold - 8, 20);
    rows = state.items.filter((i) => isQuestion(i) && !inTheme.has(i.id))
      .map((i) => ({ i, score: Math.max(0, ...t.ids.map((m) => idx.compare(m, i.id).score)) }))
      .filter((r) => r.score >= floor).sort((a, b) => b.score - a.score).slice(0, 6);
  }
  el.innerHTML = `${!q ? `<p class="field-hint" style="margin:10px 0 6px">${rows.length ? 'Likely belongs here, by closest match to this theme’s questions:' : 'No other questions look closely related. Search to add any question.'}</p>` : ''}
    <div class="member-list">${rows.map(({ i, score }) => `
      <div class="member">
        <div class="member-body">
          <a class="member-q" href="#/library/${i.id}"><span class="mono muted">#${i.id}</span> ${esc(i.question)}</a>
          <span class="muted member-meta">${esc(accountOf(i))}${i.themeId && themeName(i.themeId) ? ` · now in “${esc(themeName(i.themeId))}”` : ''}${score != null ? ` · ${score}% match` : ''}</span>
        </div>
        <div class="member-actions"><button type="button" class="btn btn-sm" data-add-id="${i.id}">${i.themeId ? 'Move here' : 'Add'}</button></div>
      </div>`).join('')}${q && !rows.length ? '<p class="muted">No questions match.</p>' : ''}</div>`;
}

async function withUndo(label, run) {
  const snap = themeSnapshot();
  if (await run()) toast(label, { action: { label: 'Undo', run: () => restoreThemes(snap).then((ok) => ok && toast('Undone')) } });
}

function askName(title, initial, onOk) {
  openDialog({
    title,
    body: `<div class="field"><label class="field-label" for="nt-name">Theme name</label><input class="input" id="nt-name" value="${esc(initial)}" autocomplete="off"></div>`,
    foot: '<div class="right"><button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn btn-primary" data-ok>Save</button></div>',
    onMount: (d) => {
      const inp = d.querySelector('#nt-name');
      inp.focus(); inp.select();
      const ok = () => { const v = inp.value.trim(); if (!v) { toastError('Give the theme a name.'); return; } d.close(); onOk(v); };
      d.querySelector('[data-ok]').addEventListener('click', ok);
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); ok(); } });
    },
  });
}

async function onClick(e) {
  const t = e.target;
  const sel = t.closest('[data-sel]');
  if (sel) { ui.sel = sel.dataset.sel; ui.checked = new Set(); ui.addQ = ''; history.replaceState(null, '', `#/themes?id=${encodeURIComponent(ui.sel)}`); update(); return; }
  const conf = t.closest('[data-confirm]');
  if (conf) {
    const s = effectiveThemes().find((x) => x.id === conf.dataset.confirm);
    if (!s) return;
    askName('Confirm theme', s.name.replace(/\?$/, ''), async (name) => {
      const id = uid('theme');
      if (await saveThemes([{ id, name, ids: s.ids }])) { ui.sel = id; toast(`Saved “${name}”`); }
    });
    return;
  }
  const th = current();
  const chk = t.closest('[data-check]');
  if (chk) { const id = Number(chk.dataset.check); if (chk.checked) ui.checked.add(id); else ui.checked.delete(id); paintEditor(); return; }
  const ap = t.closest('[data-approve]');
  if (ap && th) { if (await setApproved(th.id, Number(ap.dataset.approve))) toast(`#${ap.dataset.approve} is now the approved answer`); return; }
  const rm = t.closest('[data-remove]');
  if (rm && th) { const id = Number(rm.dataset.remove); ui.checked.delete(id); await withUndo(`Removed #${id} from “${th.name}”`, () => removeFromTheme(id)); return; }
  const add = t.closest('[data-add-id]');
  if (add && th) { const id = Number(add.dataset.addId); await withUndo(`Added #${id} to “${th.name}”`, () => addToTheme([id], th.id)); return; }
  const act = t.closest('[data-act]')?.dataset.act;
  if (act === 'new') {
    askName('New theme', '', async (name) => {
      const id = uid('theme');
      if (await addToTheme([], id, { name })) { ui.sel = id; toast(`Created “${name}”. Add questions below.`); }
    });
  } else if (act === 'remove-selected' && th) {
    const ids = [...ui.checked];
    ui.checked = new Set();
    await withUndo(`Removed ${pluralize(ids.length, 'question')} from “${th.name}”`, () => removeFromTheme(ids));
  } else if (act === 'delete' && th) {
    const ok = await confirmDialog({ title: `Delete “${th.name}”?`, message: `Its ${pluralize(th.ids.length, 'question')} stay in the Library without a theme. You can undo this right after.`, confirmLabel: 'Delete theme', danger: true });
    if (ok) await withUndo(`Deleted “${th.name}”`, () => deleteTheme(th.id));
  }
}

async function onChange(e) {
  const t = e.target;
  const th = current();
  if (!th) return;
  if (t.id === 'theme-name') {
    const v = t.value.trim();
    if (!v) { t.value = th.name; toastError('A theme needs a name.'); return; }
    if (v !== th.name && await renameTheme(th.id, v)) toast('Theme renamed');
  } else if (t.id === 'move-to' && t.value) {
    const ids = [...ui.checked];
    if (t.value === '__new') {
      t.value = '';
      askName('New theme', '', async (name) => {
        const id = uid('theme');
        ui.checked = new Set();
        await withUndo(`Moved ${pluralize(ids.length, 'question')} to “${name}”`, () => addToTheme(ids, id, { name }));
      });
      return;
    }
    const to = state.config.themes.find((x) => x.id === t.value);
    ui.checked = new Set();
    await withUndo(`Moved ${pluralize(ids.length, 'question')} to “${to.name}”`, () => addToTheme(ids, to.id));
  } else if (t.id === 'merge-into' && t.value) {
    const to = state.config.themes.find((x) => x.id === t.value);
    const ok = await confirmDialog({ title: `Merge into “${to.name}”?`, message: `All ${pluralize(th.ids.length, 'question')} in “${esc(th.name)}” move to “${esc(to.name)}”, and “${esc(th.name)}” is removed. You can undo this right after.`, confirmLabel: 'Merge' });
    if (!ok) { t.value = ''; return; }
    const from = th.id;
    ui.sel = to.id;
    await withUndo(`Merged into “${to.name}”`, () => mergeThemes(from, to.id));
  }
}
