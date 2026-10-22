import { state, getIndex, getItem, deleteQuestion, restoreQuestion, setVerdicts, setFollowUp, removeFromTheme, addToTheme } from './store.js';
import { VERDICTS, verdictLabel, suggestVerdict, accountOf, themeIndex, repsOf } from './model.js';
import { openQuestionDialog } from './dialogs.js';
import { openImportDialog } from './import.js';
import { openLogCall } from './logcall.js';
import { toast, toastError, confirmDialog, openDialog } from './ui.js';
import {
  esc, icon, wordCount, isNoAnswer, debounce, highlight, copyText, loadXLSX, pluralize, fmtDate, todayISO, uid,
} from './utils.js';

const PAGE = 100;

// Filters persist while you move between sections.
export const ui = {
  q: '', cat: '', account: '', rep: '', theme: '', verdict: '', call: '', ids: null,
  sort: 'newest', attention: false, mine: false, sel: null, limit: PAGE,
};

let root = null;
let sheetOpen = false;

const needsAttention = (i) => isNoAnswer(i.answer) || wordCount(i.answer) < state.config.shortWordThreshold;
const terms = () => ui.q.toLowerCase().split(/\s+/).filter((t) => t.length > 1);

function filtered() {
  const t = terms();
  const me = [state.user?.email, state.user?.uid].filter(Boolean);
  const tOf = themeIndex();
  let list = state.items.filter((i) => {
    if (ui.ids && !ui.ids.includes(i.id)) return false;
    if (ui.cat && i.topic !== ui.cat) return false;
    if (ui.account && accountOf(i) !== ui.account) return false;
    if (ui.rep && !repsOf(i).includes(ui.rep)) return false;
    if (ui.call && i.callId !== ui.call) return false;
    if (ui.theme && tOf.get(i.id)?.id !== ui.theme) return false;
    if (ui.verdict) {
      const v = i.verdict || '';
      if (ui.verdict === '__none' ? v : v !== ui.verdict) return false;
    }
    if (ui.attention && !needsAttention(i)) return false;
    if (ui.mine && !me.includes(i.createdBy)) return false;
    if (t.length) {
      const hay = `${i.question} ${i.answer} ${i.askedBy} ${i.company || ''} ${i.answeredBy} ${i.topic} #${i.id}`.toLowerCase();
      if (!t.every((w) => hay.includes(w))) return false;
    }
    return true;
  });
  const cmp = {
    newest: (a, b) => (b.askedAt || '').localeCompare(a.askedAt || '') || b.id - a.id,
    oldest: (a, b) => (a.askedAt || '9').localeCompare(b.askedAt || '9') || a.id - b.id,
    account: (a, b) => accountOf(a).localeCompare(accountOf(b)) || a.id - b.id,
    rep: (a, b) => a.answeredBy.localeCompare(b.answeredBy) || a.id - b.id,
    topic: (a, b) => a.topic.localeCompare(b.topic) || a.id - b.id,
  }[ui.sort] || ((a, b) => b.id - a.id);
  list = list.sort(cmp);
  if (t.length) {
    const rank = (i) => (i.standard ? 0 : 2) + (t.every((w) => i.question.toLowerCase().includes(w)) ? 0 : 1);
    list = list.map((x, n) => [x, n]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map((x) => x[0]);
  }
  return list;
}

const FILTER_KEYS = ['cat', 'account', 'rep', 'theme', 'verdict', 'call', 'ids', 'attention'];

export function mount(el, params) {
  root = el;
  if (params.id) ui.sel = Number(params.id);
  // Links from other screens arrive with filters, e.g. #/library?account=COR3&rep=Dita
  if (FILTER_KEYS.some((k) => params[k] != null)) {
    Object.assign(ui, {
      q: '', mine: false, limit: PAGE, cat: params.cat || '', account: params.account || '', rep: params.rep || '',
      theme: params.theme || '', verdict: params.verdict || '', call: params.call || '', attention: params.attention === '1',
      ids: params.ids ? params.ids.split(',').map(Number) : null,
    });
  }
  sheetOpen = !!params.id && matchMedia('(max-width: 860px)').matches;

  el.innerHTML = `
    <div class="page">
      <header class="page-head">
        <div>
          <h1 class="page-title">Library</h1>
          <p class="page-sub" data-sub></p>
        </div>
        <div class="page-actions">
          <button type="button" class="btn hide-mobile" data-act="import">${icon('upload', 'icon-sm')}Import</button>
          <button type="button" class="btn" data-act="export">${icon('download', 'icon-sm')}Export view</button>
          <button type="button" class="btn" data-act="new">${icon('plus', 'icon-sm')}Single question</button>
          <button type="button" class="btn btn-primary" data-act="log">${icon('plus', 'icon-sm')}Log a call</button>
        </div>
      </header>

      <label class="search">
        ${icon('search')}
        <span class="visually-hidden">Search the library</span>
        <input type="search" id="lib-search" value="${esc(ui.q)}" placeholder="Search questions, answers, accounts or reps" autocomplete="off">
        <span class="kbd" title="Press / to search">/</span>
      </label>

      <div class="toolbar scroll-x" data-chips></div>
      <div class="toolbar scroll-x" data-filters></div>

      <div class="split">
        <section class="results" aria-label="Results">
          <div class="results-head" data-count></div>
          <div class="list" data-list role="list"></div>
        </section>
        <aside class="detail" data-detail aria-label="Question detail"></aside>
      </div>
    </div>`;

  const search = el.querySelector('#lib-search');
  search.addEventListener('input', debounce(() => { ui.q = search.value; ui.limit = PAGE; update(); }, 120));
  el.onclick = onClick;
  el.onchange = async (e) => {
    if (e.target.matches('[data-theme-pick]')) { await pickTheme(e.target); return; }
    const f = e.target.dataset.filter;
    if (!f) return;
    ui[f] = e.target.value;
    ui.limit = PAGE;
    update();
  };
  update();
}

export function focusSearch() { root?.querySelector('#lib-search')?.focus(); }

export function update() {
  if (!root) return;
  const list = filtered();
  const t = terms();
  const total = state.items.length;
  const accounts = new Set(state.items.map(accountOf));
  const reps = new Set(state.items.flatMap(repsOf));

  root.querySelector('[data-sub]').textContent =
    `${pluralize(total, 'question')} from ${pluralize(accounts.size, 'account')}, answered by ${pluralize(reps.size, 'rep')}`;

  const counts = new Map();
  state.items.forEach((i) => counts.set(i.topic, (counts.get(i.topic) || 0) + 1));
  const cats = state.categories.filter((c) => counts.get(c));
  root.querySelector('[data-chips]').innerHTML = [
    `<button type="button" class="chip" data-cat="" aria-pressed="${!ui.cat}">All<span class="chip-count">${total}</span></button>`,
    ...cats.map((c) => `<button type="button" class="chip" data-cat="${esc(c)}" aria-pressed="${ui.cat === c}">${esc(c)}<span class="chip-count">${counts.get(c)}</span></button>`),
  ].join('');

  // A filter left over from before the data changed would silently hide everything.
  if (ui.rep && !reps.has(ui.rep)) ui.rep = '';
  if (ui.account && !accounts.has(ui.account)) ui.account = '';
  const filters = root.querySelector('[data-filters]');
  const acctOpts = [...accounts].sort();
  const repOpts = [...reps].sort();
  const themes = [...themeIndex().values()].filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => a.name.localeCompare(b.name));
  const sig = JSON.stringify([acctOpts, repOpts, themes.map((x) => x.id + x.name), ui.account, ui.rep, ui.theme, ui.verdict, ui.sort, ui.attention, ui.mine, state.config.shortWordThreshold]);
  if (filters.dataset.sig !== sig) {
    filters.dataset.sig = sig;
    const opt = (v, l, cur) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(l)}</option>`;
    filters.innerHTML = `
      <label class="visually-hidden" for="f-account">Account</label>
      <select class="select select-inline" id="f-account" data-filter="account">${opt('', 'All accounts', ui.account)}${acctOpts.map((a) => opt(a, a, ui.account)).join('')}</select>
      <label class="visually-hidden" for="f-rep">Rep</label>
      <select class="select select-inline" id="f-rep" data-filter="rep">${opt('', 'All reps', ui.rep)}${repOpts.map((a) => opt(a, a, ui.rep)).join('')}</select>
      <label class="visually-hidden" for="f-theme">Theme</label>
      <select class="select select-inline" id="f-theme" data-filter="theme">${opt('', 'All themes', ui.theme)}${themes.map((x) => opt(x.id, `${x.confirmed ? '' : 'Suggested: '}${x.name.slice(0, 50)}`, ui.theme)).join('')}</select>
      <label class="visually-hidden" for="f-verdict">Verdict</label>
      <select class="select select-inline" id="f-verdict" data-filter="verdict">${opt('', 'Any verdict', ui.verdict)}${VERDICTS.map((v) => opt(v.id, v.label, ui.verdict)).join('')}${opt('__none', 'No verdict yet', ui.verdict)}</select>
      <label class="visually-hidden" for="f-sort">Sort</label>
      <select class="select select-inline" id="f-sort" data-filter="sort">
        ${opt('newest', 'Newest first', ui.sort)}${opt('oldest', 'Oldest first', ui.sort)}${opt('account', 'Account A–Z', ui.sort)}${opt('rep', 'Rep A–Z', ui.sort)}${opt('topic', 'Category', ui.sort)}
      </select>
      <span class="sep" aria-hidden="true"></span>
      <button type="button" class="chip chip-warn" data-toggle="attention" aria-pressed="${ui.attention}" title="Answers under ${state.config.shortWordThreshold} words or missing">${icon('flag', 'icon-sm')}Needs attention</button>
      <button type="button" class="chip" data-toggle="mine" aria-pressed="${ui.mine}">Added by me</button>`;
  }

  const filtersOn = ui.q || ui.cat || ui.account || ui.rep || ui.theme || ui.verdict || ui.call || ui.ids || ui.attention || ui.mine;
  const callNote = ui.call ? state.config.calls.find((c) => c.id === ui.call) : null;
  root.querySelector('[data-count]').innerHTML = `<span><strong>${list.length}</strong> ${list.length === 1 ? 'result' : 'results'}${filtersOn ? ` of ${total}` : ''}${callNote ? ` from the ${esc(callNote.company)} call on ${esc(fmtDate(callNote.date))}` : ''}${ui.ids ? ' (selected questions)' : ''}</span>
    ${filtersOn ? '<button type="button" class="link-btn" data-act="reset">Clear filters</button>' : ''}`;

  const listEl = root.querySelector('[data-list]');
  if (!list.length) {
    listEl.innerHTML = total
      ? `<div class="empty"><strong>No questions match</strong><span>Try fewer words or clear a filter.</span><button type="button" class="btn btn-sm" data-act="reset">Clear filters</button></div>`
      : `<div class="empty"><strong>The library is empty</strong><span>Log a call or import a spreadsheet to get started.</span>
         <div class="page-actions"><button type="button" class="btn" data-act="import">Import</button><button type="button" class="btn btn-primary" data-act="log">Log a call</button></div></div>`;
  } else {
    const thr = state.config.shortWordThreshold;
    listEl.innerHTML = list.slice(0, ui.limit).map((i) => `
      <button type="button" class="row" role="listitem" data-id="${i.id}" aria-current="${i.id === ui.sel}">
        <span class="row-id">#${i.id}</span>
        <span class="row-body">
          <span class="row-q">${highlight(i.question, t)}</span>
          <span class="row-a">${highlight(i.answer, t)}</span>
          <span class="row-meta">
            <span>${highlight(accountOf(i), t)}</span>${i.askedAt ? `<span aria-hidden="true">·</span><span>${esc(fmtDate(i.askedAt))}</span>` : ''}<span aria-hidden="true">·</span><span>${highlight(i.answeredBy, t)}</span>
            <span class="tag">${esc(i.topic)}</span>
            ${i.verdict ? `<span class="vbadge v-${i.verdict}">${verdictLabel(i.verdict)}</span>` : ''}
            ${i.kind === 'feedback' ? '<span class="badge badge-accent">Prospect feedback</span>' : ''}
            ${i.standard ? '<span class="badge badge-ok">Approved answer</span>' : ''}
            ${isNoAnswer(i.answer) ? '<span class="badge badge-warn">No answer</span>' : wordCount(i.answer) < thr ? '<span class="badge badge-warn">Brief</span>' : ''}
            ${i.followUp && !i.followUp.done ? '<span class="badge badge-warn">Follow-up open</span>' : ''}
          </span>
        </span>
      </button>`).join('') + (list.length > ui.limit
        ? `<div class="more"><button type="button" class="btn btn-sm" data-act="more">Show ${Math.min(PAGE, list.length - ui.limit)} more</button></div>` : '');
  }

  if ((ui.sel == null || !getItem(ui.sel)) && list.length && !matchMedia('(max-width: 860px)').matches) ui.sel = list[0].id;
  renderDetail();
}

function renderDetail() {
  const el = root.querySelector('[data-detail]');
  const it = ui.sel != null ? getItem(ui.sel) : null;
  root.querySelector('.sheet-backdrop')?.remove();
  el.classList.toggle('open', sheetOpen && !!it);
  if (sheetOpen && it) {
    const b = document.createElement('div');
    b.className = 'sheet-backdrop';
    b.addEventListener('click', closeSheet);
    root.appendChild(b);
  }
  if (!it) {
    el.innerHTML = `<div class="empty"><strong>Select a question</strong><span>Its full answer and similar questions show here.</span></div>`;
    return;
  }
  const words = wordCount(it.answer);
  const brief = !isNoAnswer(it.answer) && words < state.config.shortWordThreshold;
  const idx = getIndex();
  const sim = idx.similarTo(it.id, 3, idx.mode === 'meaning' ? 30 : 15);
  const theme = themeIndex().get(it.id);
  const std = theme ? theme.ids.map(getItem).find((x) => x?.standard && x.id !== it.id) : null;
  const call = it.callId ? state.config.calls.find((c) => c.id === it.callId) : null;
  const related = (it.related || []).map(getItem).filter(Boolean);
  const compareIds = [it.id, ...sim.slice(0, 2).map((s) => s.item.id)].join(',');
  const suggested = !it.verdict ? suggestVerdict(it.answer, it.question) : null;
  const today = todayISO();

  el.innerHTML = `
    <div class="detail-head">
      <span class="mono">#${it.id} · ${esc(it.topic)}</span>
      <div class="detail-tools">
        <button type="button" class="icon-btn" data-act="edit" aria-label="Edit question" title="Edit (e)">${icon('edit', 'icon-sm')}</button>
        <button type="button" class="icon-btn" data-act="delete" aria-label="Delete question">${icon('trash', 'icon-sm')}</button>
        <button type="button" class="icon-btn detail-close" data-act="close-sheet" aria-label="Close">${icon('x', 'icon-sm')}</button>
      </div>
    </div>
    <h2 class="detail-q">${esc(it.question)}</h2>
    ${it.standard || std || brief || isNoAnswer(it.answer) || it.kind === 'feedback' ? `<div class="detail-badges">
      ${it.kind === 'feedback' ? '<span class="badge badge-accent">Prospect feedback, not counted as a question</span>' : ''}
      ${it.standard ? '<span class="badge badge-ok">Approved answer for this theme</span>' : ''}
      ${isNoAnswer(it.answer) ? '<span class="badge badge-warn">No answer yet</span>' : brief ? '<span class="badge badge-warn">Brief answer, consider expanding</span>' : ''}
    </div>` : ''}
    <div class="answer-box">
      <div class="answer-head"><span>Answer</span>
        <button type="button" class="btn btn-sm" data-act="copy">${icon('copy', 'icon-sm')}Copy</button></div>
      <p class="answer-text">${esc(it.answer)}</p>
      ${std && std.answer !== it.answer ? `<div class="answer-head"><span>Approved answer (#${std.id})</span></div><p class="answer-text">${esc(std.answer)}</p>` : ''}
    </div>
    <div class="field">
      <span class="field-label">Verdict: can we do what was asked?${suggested ? ` <span class="muted">· suggested: ${verdictLabel(suggested)}</span>` : ''}</span>
      <div class="pills" role="group" aria-label="Verdict">${VERDICTS.map((v) => `<button type="button" class="pill" data-verdict="${v.id}" aria-pressed="${it.verdict === v.id}">${v.label}</button>`).join('')}</div>
    </div>
    ${it.followUp ? `<div class="fu-box ${it.followUp.done ? 'done' : ''}">
      <strong>Follow-up</strong><span>${esc(it.followUp.owner || 'No owner')}${it.followUp.due ? ` · ${it.followUp.done ? 'was due' : it.followUp.due < today ? 'overdue since' : 'due'} ${esc(fmtDate(it.followUp.due))}` : ''}${it.followUp.done ? ' · done' : ''}</span>
      <button type="button" class="link-btn" data-act="fu-toggle">${it.followUp.done ? 'Reopen' : 'Mark done'}</button></div>` : ''}
    <dl class="meta-grid">
      <div><dt>Account</dt><dd>${accountOf(it) !== 'Unknown' ? `<button type="button" class="link-btn" data-filter-account="${esc(accountOf(it))}">${esc(accountOf(it))}</button>` : '<span class="muted">Not set</span>'}</dd></div>
      <div><dt>Contact</dt><dd>${esc(it.contact || it.askedBy)}</dd></div>
      <div><dt>Asked</dt><dd>${it.askedAt ? esc(fmtDate(it.askedAt)) : '<a href="#/complete">Add date</a>'}${call ? ` · <a href="#/library?call=${esc(call.id)}">${esc(call.type || 'call')}</a>` : ''}</dd></div>
      <div><dt>Answered by</dt><dd>${esc(it.answeredBy)}</dd></div>
      <div class="span-2"><dt><label for="d-theme">Theme</label></dt><dd class="theme-dd">
        <select class="select select-inline" id="d-theme" data-theme-pick>
          <option value="">No theme</option>
          ${[...state.config.themes].sort((a, b) => a.name.localeCompare(b.name)).map((t) => `<option value="${esc(t.id)}" ${t.id === it.themeId ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}
          <option value="__new">New theme…</option>
        </select>
        ${it.themeId ? `<a href="#/themes?id=${encodeURIComponent(it.themeId)}" class="small-link">Edit theme</a>` : theme ? `<span class="muted small-link">Suggested: ${esc(theme.name.slice(0, 40))}</span>` : ''}
      </dd></div>
      <div><dt>Answer length</dt><dd>${pluralize(words, 'word')}</dd></div>
    </dl>
    ${related.length ? `<div class="sim-list"><h3 class="section-title">Linked questions</h3>${related.map((v) => simRow(v, null)).join('')}</div>` : ''}
    <div class="sim-list">
      <div class="section-head"><h3 class="section-title">Similar questions</h3>
        ${sim.length ? `<a href="#/review?tab=pick&ids=${compareIds}" style="font-size:13px;font-weight:500">Compare side by side</a>` : ''}</div>
      ${sim.length ? sim.map((s) => simRow(s.item, s.score)).join('') : '<p class="muted" style="font-size:13px">No similar questions yet.</p>'}
    </div>`;
}

const simRow = (item, score) => `
  <button type="button" class="sim-item" data-id="${item.id}">
    <span class="sim-score">${score == null ? `#${item.id}` : `${score}%`}</span>
    <span class="sim-text"><span>${esc(item.question)}</span><span>${esc(accountOf(item))} · ${esc(item.answeredBy)}</span></span>
  </button>`;

function select(id) {
  ui.sel = id;
  sheetOpen = matchMedia('(max-width: 860px)').matches;
  history.replaceState(null, '', `#/library/${id}`);
  root.querySelectorAll('.row').forEach((r) => r.setAttribute('aria-current', String(Number(r.dataset.id) === id)));
  renderDetail();
  if (!sheetOpen) root.querySelector(`.row[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest' });
}

function closeSheet() { sheetOpen = false; renderDetail(); }

async function pickTheme(sel) {
  const it = ui.sel != null ? getItem(ui.sel) : null;
  if (!it) return;
  const v = sel.value;
  if (v === '') { if (await removeFromTheme(it.id)) toast('Removed from the theme'); return; }
  if (v === '__new') {
    sel.value = it.themeId || '';
    openDialog({
      title: 'New theme',
      body: `<div class="field"><label class="field-label" for="nt">Theme name</label><input class="input" id="nt" value="${esc(it.question.replace(/\?$/, '').slice(0, 60))}"></div>`,
      foot: '<div class="right"><button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn btn-primary" data-ok>Create</button></div>',
      onMount: (d) => {
        const inp = d.querySelector('#nt');
        inp.focus(); inp.select();
        const go = async () => {
          const name = inp.value.trim();
          if (!name) return;
          d.close();
          if (await addToTheme([it.id], uid('theme'), { name })) toast(`Created “${name}” with #${it.id}`);
        };
        d.querySelector('[data-ok]').addEventListener('click', go);
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
      },
    });
    return;
  }
  const t = state.config.themes.find((x) => x.id === v);
  if (await addToTheme([it.id], v)) toast(`Moved #${it.id} to “${t?.name}”`);
}

export function editSelected() {
  if (ui.sel != null && getItem(ui.sel)) openQuestionDialog(ui.sel);
}

async function onClick(e) {
  const t = e.target;
  const row = t.closest('[data-id]');
  if (row && root.contains(row)) { select(Number(row.dataset.id)); return; }
  const chip = t.closest('[data-cat]');
  if (chip) { ui.cat = chip.dataset.cat; ui.limit = PAGE; update(); return; }
  const tog = t.closest('[data-toggle]');
  if (tog) { ui[tog.dataset.toggle] = !ui[tog.dataset.toggle]; ui.limit = PAGE; update(); return; }
  const fa = t.closest('[data-filter-account]');
  if (fa) { Object.assign(ui, { account: fa.dataset.filterAccount, cat: '', rep: '', q: '', theme: '', ids: null, call: '' }); root.querySelector('#lib-search').value = ''; update(); return; }
  const it = ui.sel != null ? getItem(ui.sel) : null;
  const v = t.closest('[data-verdict]');
  if (v && it) { await setVerdicts([it.id], it.verdict === v.dataset.verdict ? null : v.dataset.verdict); return; }

  const act = t.closest('[data-act]')?.dataset.act;
  if (!act) return;
  switch (act) {
    case 'new': openQuestionDialog(null, { defaults: { topic: ui.cat }, onSaved: (id) => select(id) }); break;
    case 'log': openLogCall(); break;
    case 'import': openImportDialog(); break;
    case 'export': exportView(); break;
    case 'more': ui.limit += PAGE; update(); break;
    case 'reset':
      Object.assign(ui, { q: '', cat: '', account: '', rep: '', theme: '', verdict: '', call: '', ids: null, attention: false, mine: false, limit: PAGE });
      root.querySelector('#lib-search').value = '';
      history.replaceState(null, '', '#/library');
      update();
      break;
    case 'edit': if (it) openQuestionDialog(it.id); break;
    case 'close-sheet': closeSheet(); break;
    case 'copy': if (it && await copyText(it.answer)) toast('Answer copied'); break;
    case 'fu-toggle': if (it?.followUp) await setFollowUp(it.id, { ...it.followUp, done: !it.followUp.done }); break;
    case 'delete': {
      if (!it) return;
      const ok = await confirmDialog({
        title: `Delete #${it.id}?`,
        message: `“${esc(it.question)}”<br><br>You can undo this right after.`,
        confirmLabel: 'Delete question',
        danger: true,
      });
      if (!ok) return;
      const copy = structuredClone(it);
      ui.sel = null;
      sheetOpen = false;
      if (await deleteQuestion(copy.id)) {
        toast(`Deleted #${copy.id}`, { action: { label: 'Undo', run: () => restoreQuestion(copy).then((r) => r && select(copy.id)) } });
      }
      break;
    }
  }
}

async function exportView() {
  const list = filtered();
  if (!list.length) { toastError('Nothing to export. Clear the filters first.'); return; }
  try {
    const XLSX = await loadXLSX();
    const tOf = themeIndex();
    const rows = list.map((i) => ({
      ID: i.id, Date: i.askedAt || '', Account: accountOf(i), Contact: i.contact || i.askedBy, Question: i.question, Answer: i.answer,
      'Answered By': i.answeredBy, Category: i.topic, Theme: tOf.get(i.id)?.name || '', Verdict: verdictLabel(i.verdict),
      'Approved answer': i.standard ? 'Yes' : '', 'Added By': i.createdBy || '',
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Prospect Q&A');
    XLSX.writeFile(wb, `Prospect_QA_${todayISO()}.xlsx`);
    toast(`Exported ${pluralize(list.length, 'question')}`);
  } catch (err) {
    toastError(err.message);
  }
}
