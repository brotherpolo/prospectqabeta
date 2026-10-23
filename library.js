import {
  state, getIndex, getItem, deleteQuestion, restoreQuestion, setVerdicts, setFollowUp, removeFromTheme, addToTheme,
  deleteQuestions, restoreQuestions, setCategory, fieldSnapshot, restoreFields, themeSnapshot, restoreThemes, searchByMeaning,
} from './store.js';
import { VERDICTS, verdictLabel, suggestVerdict, accountOf, themeIndex, repsOf, themeTagHTML, themeById, themeHex } from './model.js';
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
  checked: new Set(), lastChecked: null,
  density: (() => { try { return localStorage.getItem('qa-density') || 'comfortable'; } catch { return 'comfortable'; } })(),
};

let root = null;
let sheetOpen = false;

const needsAttention = (i) => isNoAnswer(i.answer) || wordCount(i.answer) < state.config.shortWordThreshold;
const terms = () => ui.q.toLowerCase().split(/\s+/).filter((t) => t.length > 1);

function filtered({ ignoreText = false } = {}) {
  const t = ignoreText ? [] : terms();
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
    idDesc: (a, b) => b.id - a.id,
    idAsc: (a, b) => a.id - b.id,
    // Theme A–Z; questions without a theme go last.
    theme: (a, b) => {
      const ta = a.themeId ? themeById(a.themeId)?.name : null;
      const tb = b.themeId ? themeById(b.themeId)?.name : null;
      if (!ta !== !tb) return ta ? -1 : 1;
      return (ta || '').localeCompare(tb || '') || a.id - b.id;
    },
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
          <div class="bulk-bar" data-bulk hidden></div>
          <div class="list" data-list role="list"></div>
        </section>
        <aside class="detail" data-detail aria-label="Question detail"></aside>
      </div>
    </div>`;

  const search = el.querySelector('#lib-search');
  search.addEventListener('input', debounce(() => { ui.q = search.value; ui.limit = PAGE; update(); }, 120));
  search.addEventListener('input', debounce(runMeaning, 350));
  if (ui.q) runMeaning();
  el.onclick = onClick;
  el.onchange = async (e) => {
    if (e.target.matches('[data-theme-pick]')) { await pickTheme(e.target); return; }
    if (e.target.matches('[data-bulk-theme]') && e.target.value) { const v = e.target.value; e.target.value = ''; await bulkTheme(v); return; }
    if (e.target.matches('[data-bulk-cat]') && e.target.value) { const v = e.target.value; e.target.value = ''; await bulkCategory(v); return; }
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
      <label class="sort-label" for="f-sort">Sort</label>
      <select class="select select-inline" id="f-sort" data-filter="sort">
        ${opt('newest', 'Newest first', ui.sort)}${opt('oldest', 'Oldest first', ui.sort)}${opt('idDesc', 'Number, high to low', ui.sort)}${opt('idAsc', 'Number, low to high', ui.sort)}${opt('topic', 'Category A–Z', ui.sort)}${opt('theme', 'Theme A–Z', ui.sort)}${opt('account', 'Account A–Z', ui.sort)}${opt('rep', 'Rep A–Z', ui.sort)}
      </select>
      <span class="sep" aria-hidden="true"></span>
      <button type="button" class="chip chip-warn" data-toggle="attention" aria-pressed="${ui.attention}" title="Answers under ${state.config.shortWordThreshold} words or missing">${icon('flag', 'icon-sm')}Needs attention</button>
      <button type="button" class="chip" data-toggle="mine" aria-pressed="${ui.mine}">Added by me</button>`;
  }

  const filtersOn = ui.q || ui.cat || ui.account || ui.rep || ui.theme || ui.verdict || ui.call || ui.ids || ui.attention || ui.mine;
  const callNote = ui.call ? state.config.calls.find((c) => c.id === ui.call) : null;
  const live = new Set(state.items.map((i) => i.id));
  ui.checked.forEach((id) => { if (!live.has(id)) ui.checked.delete(id); });
  const nChecked = list.filter((i) => ui.checked.has(i.id)).length;
  const nMeaning = meaningMatches(list).length;
  root.querySelector('[data-count]').innerHTML = `<label class="select-all"><input type="checkbox" data-select-all ${list.length && nChecked === list.length ? 'checked' : ''} ${list.length ? '' : 'disabled'} aria-label="Select all ${list.length} results"></label><span class="grow"><strong>${list.length}</strong> ${list.length === 1 ? 'result' : 'results'}${filtersOn ? ` of ${total}` : ''}${callNote ? ` from the ${esc(callNote.company)} call on ${esc(fmtDate(callNote.date))}` : ''}${ui.ids ? ' (selected questions)' : ''}${nMeaning ? ` <span class="muted">+ ${nMeaning} related by meaning</span>` : ''}</span>
    ${filtersOn ? '<button type="button" class="link-btn" data-act="reset">Clear filters</button>' : ''}
    <span class="tabs density" role="tablist" aria-label="Row size">
      <button type="button" class="tab" role="tab" data-density="comfortable" aria-selected="${ui.density === 'comfortable'}">Comfortable</button>
      <button type="button" class="tab" role="tab" data-density="compact" aria-selected="${ui.density === 'compact'}">Compact</button>
    </span>`;
  const all = root.querySelector('[data-select-all]');
  if (all) all.indeterminate = nChecked > 0 && nChecked < list.length;
  paintBulk();

  const listEl = root.querySelector('[data-list]');
  const thr = state.config.shortWordThreshold;
  const renderRow = (i, extra = '') => {
    const th = i.themeId ? themeById(i.themeId) : null;
    const on = ui.checked.has(i.id);
    const verdict = i.verdict ? `<span class="vbadge v-${i.verdict}">${verdictLabel(i.verdict)}</span>` : '';
    const approved = i.standard ? '<span class="badge badge-ok">Approved</span>' : '';
    const body = ui.density === 'compact'
      ? `<span class="row-id">#${i.id}</span>
         <span class="row-q-compact">${highlight(i.question, t)}</span>
         <span class="row-tags">${extra}${themeTagHTML(i, { short: true })}<span class="tag">${esc(i.topic)}</span>${verdict}${approved}</span>`
      : `<span class="row-id">#${i.id}</span>
      <span class="row-body">
        <span class="row-q">${highlight(i.question, t)}</span>
        <span class="row-a">${highlight(i.answer, t)}</span>
        <span class="row-meta">
          ${extra}<span>${highlight(accountOf(i), t)}</span>${i.askedAt ? `<span aria-hidden="true">·</span><span>${esc(fmtDate(i.askedAt))}</span>` : ''}<span aria-hidden="true">·</span><span>${highlight(i.answeredBy, t)}</span>
          ${themeTagHTML(i, { short: true })}
          <span class="tag">${esc(i.topic)}</span>
          ${verdict}
          ${i.kind === 'feedback' ? '<span class="badge badge-accent">Prospect feedback</span>' : ''}
          ${i.standard ? '<span class="badge badge-ok">Approved answer</span>' : ''}
          ${isNoAnswer(i.answer) ? '<span class="badge badge-warn">No answer</span>' : wordCount(i.answer) < thr ? '<span class="badge badge-warn">Brief</span>' : ''}
          ${i.followUp && !i.followUp.done ? '<span class="badge badge-warn">Follow-up open</span>' : ''}
        </span>
      </span>`;
    return `
    <div class="row${th ? ' has-theme' : ''}${on ? ' checked' : ''}" ${th ? `style="--tc:${themeHex(th)}"` : ''} role="listitem" data-row="${i.id}" aria-current="${i.id === ui.sel}">
      <label class="row-check"><input type="checkbox" data-check="${i.id}" ${on ? 'checked' : ''} aria-label="Select #${i.id}"></label>
      <button type="button" class="row-main" data-id="${i.id}">${body}</button>
    </div>`;
  };
  // Related by meaning: only while searching, never repeating a keyword match, same filters applied.
  const meaning = meaningMatches(list);
  listEl.className = `list ${ui.density}`;
  if (!list.length && !meaning.length) {
    listEl.innerHTML = total
      ? `<div class="empty"><strong>No questions match</strong><span>${ui.q && ui.meaning?.pending ? 'Checking for questions with a similar meaning…' : 'Try fewer words or clear a filter.'}</span><button type="button" class="btn btn-sm" data-act="reset">Clear filters</button></div>`
      : `<div class="empty"><strong>The library is empty</strong><span>Log a call or import a spreadsheet to get started.</span>
         <div class="page-actions"><button type="button" class="btn" data-act="import">Import</button><button type="button" class="btn btn-primary" data-act="log">Log a call</button></div></div>`;
  } else {
    listEl.innerHTML = list.slice(0, ui.limit).map((i) => renderRow(i)).join('')
      + (list.length > ui.limit ? `<div class="more"><button type="button" class="btn btn-sm" data-act="more">Show ${Math.min(PAGE, list.length - ui.limit)} more</button></div>` : '')
      + (meaning.length ? `<div class="meaning-head" role="presentation"><strong>Related by meaning</strong><span>${list.length ? 'Different words, similar question' : 'No exact word matches; these are close in meaning'}</span></div>`
        + meaning.map(({ item, score }) => renderRow(item, `<span class="meaning-score" title="Meaning match">${score}%</span>`)).join('') : '');
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
        ${it.themeId && themeById(it.themeId) ? `<span class="theme-dot" style="--tc:${themeHex(themeById(it.themeId))}" aria-hidden="true"></span>` : ''}
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
  root.querySelectorAll('.row').forEach((r) => r.setAttribute('aria-current', String(Number(r.dataset.row) === id)));
  renderDetail();
  if (!sheetOpen) root.querySelector(`.row[data-row="${id}"]`)?.scrollIntoView({ block: 'nearest' });
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

/** Tick or untick one row; Shift+click ticks the whole range from the last one. */
function toggleCheck(id, on, shift) {
  const list = filtered().slice(0, ui.limit).map((i) => i.id);
  if (shift && ui.lastChecked != null && list.includes(ui.lastChecked)) {
    const [a, b] = [list.indexOf(ui.lastChecked), list.indexOf(id)].sort((x, y) => x - y);
    list.slice(a, b + 1).forEach((x) => (on ? ui.checked.add(x) : ui.checked.delete(x)));
  } else if (on) ui.checked.add(id); else ui.checked.delete(id);
  ui.lastChecked = id;
  update();
}

function paintBulk() {
  const el = root.querySelector('[data-bulk]');
  const n = ui.checked.size;
  el.hidden = !n;
  if (!n) { el.innerHTML = ''; return; }
  const themes = [...state.config.themes].sort((a, b) => a.name.localeCompare(b.name));
  el.innerHTML = `
    <strong>${n} selected</strong>
    <label class="visually-hidden" for="bulk-theme">Move selected to theme</label>
    <select class="select select-inline" id="bulk-theme" data-bulk-theme>
      <option value="">Move to theme…</option>
      ${themes.map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('')}
      <option value="__new">New theme…</option>
      <option value="__none">Remove from theme</option>
    </select>
    <label class="visually-hidden" for="bulk-cat">Change category of selected</label>
    <select class="select select-inline" id="bulk-cat" data-bulk-cat>
      <option value="">Change category…</option>
      ${state.categories.map((c) => `<option>${esc(c)}</option>`).join('')}
      <option value="__new">New category…</option>
    </select>
    <button type="button" class="btn btn-sm btn-danger-outline" data-bulk-act="delete">${icon('trash', 'icon-sm')}Delete</button>
    <button type="button" class="link-btn" data-bulk-act="clear">Clear selection</button>`;
}

function askText(title, label, initial, onOk) {
  openDialog({
    title,
    body: `<div class="field"><label class="field-label" for="ask-text">${esc(label)}</label><input class="input" id="ask-text" value="${esc(initial)}" autocomplete="off"></div>`,
    foot: '<div class="right"><button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn btn-primary" data-ok>Save</button></div>',
    onMount: (d) => {
      const inp = d.querySelector('#ask-text');
      inp.focus(); inp.select();
      const go = () => { const v = inp.value.trim(); if (!v) return; d.close(); onOk(v); };
      d.querySelector('[data-ok]').addEventListener('click', go);
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
    },
  });
}

async function bulkTheme(value) {
  const ids = [...ui.checked];
  const done = () => { ui.checked.clear(); ui.lastChecked = null; };
  const snap = themeSnapshot();
  const undo = { label: 'Undo', run: () => restoreThemes(snap).then((ok) => ok && toast('Undone')) };
  if (value === '__none') {
    if (await removeFromTheme(ids)) done(), update(), toast(`Removed ${pluralize(ids.length, 'question')} from their themes`, { action: undo });
  } else if (value === '__new') {
    askText('New theme', 'Theme name', '', async (name) => {
      if (await addToTheme(ids, uid('theme'), { name })) done(), update(), toast(`Moved ${pluralize(ids.length, 'question')} to “${name}”`, { action: undo });
    });
  } else {
    const th = themeById(value);
    if (await addToTheme(ids, value)) done(), update(), toast(`Moved ${pluralize(ids.length, 'question')} to “${th?.name}”`, { action: undo });
  }
}

async function bulkCategory(value) {
  const ids = [...ui.checked];
  const apply = async (cat) => {
    const snap = fieldSnapshot(ids, ['topic']);
    if (await setCategory(ids, cat)) ui.checked.clear(), update(), toast(`Moved ${pluralize(ids.length, 'question')} to ${cat}`, { action: { label: 'Undo', run: () => restoreFields(snap).then((ok) => ok && toast('Undone')) } });
  };
  if (value === '__new') askText('New category', 'Category name', '', apply);
  else await apply(value);
}

async function bulkAction(act) {
  if (act === 'clear') { ui.checked.clear(); update(); return; }
  if (act === 'delete') {
    const ids = [...ui.checked];
    const ok = await confirmDialog({
      title: `Delete ${pluralize(ids.length, 'question')}?`,
      message: `They’ll be removed from the Library, themes and the Overview for everyone. You can undo this right after.`,
      confirmLabel: `Delete ${pluralize(ids.length, 'question')}`,
      danger: true,
    });
    if (!ok) return;
    const copies = await deleteQuestions(ids);
    if (copies) {
      ui.checked.clear();
      if (ids.includes(ui.sel)) ui.sel = null;
      toast(`Deleted ${pluralize(copies.length, 'question')}`, { action: { label: 'Undo', run: () => restoreQuestions(copies).then((r) => r && toast('Restored')) } });
    }
  }
}

async function onClick(e) {
  const t = e.target;
  const ck = t.closest('[data-check]');
  if (ck) { toggleCheck(Number(ck.dataset.check), ck.checked, e.shiftKey); return; }
  if (t.closest('.row-check')) return;
  const sa = t.closest('[data-select-all]');
  if (sa) {
    const list = filtered();
    const allOn = list.length && list.every((i) => ui.checked.has(i.id));
    if (allOn) list.forEach((i) => ui.checked.delete(i.id)); else list.forEach((i) => ui.checked.add(i.id));
    update();
    return;
  }
  const den = t.closest('[data-density]');
  if (den) {
    ui.density = den.dataset.density;
    try { localStorage.setItem('qa-density', ui.density); } catch { /* per-browser preference only */ }
    update();
    return;
  }
  const bulk = t.closest('[data-bulk-act]');
  if (bulk) { await bulkAction(bulk.dataset.bulkAct); return; }
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

/** Ask the model for questions close in meaning to the current search. */
async function runMeaning() {
  const q = ui.q.trim();
  if (q.length < 4) { ui.meaning = null; return; }
  ui.meaning = { q, pending: true, hits: [] };
  try {
    const hits = await searchByMeaning(q);
    if (ui.q.trim() !== q) return; // a newer search started
    ui.meaning = { q, pending: false, hits: hits || [] };
  } catch {
    ui.meaning = { q, pending: false, hits: [] };
  }
  update();
}

function meaningMatches(list) {
  if (!ui.q.trim() || !ui.meaning || ui.meaning.q !== ui.q.trim() || !ui.meaning.hits.length) return [];
  const shown = new Set(list.map((i) => i.id));
  const allowed = new Set(filtered({ ignoreText: true }).map((i) => i.id));
  return ui.meaning.hits.filter((h) => !shown.has(h.id) && allowed.has(h.id)).map((h) => ({ item: getItem(h.id), score: h.score })).filter((x) => x.item);
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
