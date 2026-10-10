import { state, getIndex, getItem, deleteQuestion, restoreQuestion } from '../store.js';
import { openQuestionDialog } from '../dialogs.js';
import { openImportDialog } from '../import.js';
import { toast, toastError, confirmDialog } from '../ui.js';
import {
  esc, icon, wordCount, isNoAnswer, debounce, repNames, splitAsker, highlight, copyText, loadXLSX, pluralize,
} from '../utils.js';

const PAGE = 100;

// Filters persist while you move between sections.
export const ui = {
  q: '', cat: '', asker: '', rep: '', sort: 'newest', attention: false, mine: false, sel: null, limit: PAGE,
};

let root = null;
let sheetOpen = false;

const needsAttention = (i) => isNoAnswer(i.answer) || wordCount(i.answer) < state.config.shortWordThreshold;
const terms = () => ui.q.toLowerCase().split(/\s+/).filter((t) => t.length > 1);

function filtered() {
  const t = terms();
  const me = [state.user?.email, state.user?.uid].filter(Boolean);
  let list = state.items.filter((i) => {
    if (ui.cat && i.topic !== ui.cat) return false;
    if (ui.asker && i.askedBy !== ui.asker) return false;
    if (ui.rep && !repNames(i.answeredBy).includes(ui.rep)) return false;
    if (ui.attention && !needsAttention(i)) return false;
    if (ui.mine && !me.includes(i.createdBy)) return false;
    if (t.length) {
      const hay = `${i.question} ${i.answer} ${i.askedBy} ${i.answeredBy} ${i.topic} #${i.id}`.toLowerCase();
      if (!t.every((w) => hay.includes(w))) return false;
    }
    return true;
  });
  const cmp = {
    newest: (a, b) => b.id - a.id,
    oldest: (a, b) => a.id - b.id,
    asker: (a, b) => a.askedBy.localeCompare(b.askedBy) || a.id - b.id,
    rep: (a, b) => a.answeredBy.localeCompare(b.answeredBy) || a.id - b.id,
    topic: (a, b) => a.topic.localeCompare(b.topic) || a.id - b.id,
  }[ui.sort];
  list = list.sort(cmp);
  // When searching, standard answers and question-text hits come first.
  if (t.length) {
    const rank = (i) => (i.standard ? 0 : 2) + (t.every((w) => i.question.toLowerCase().includes(w)) ? 0 : 1);
    list = list.map((x, n) => [x, n]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map((x) => x[0]);
  }
  return list;
}

export function mount(el, params) {
  root = el;
  if (params.id) ui.sel = Number(params.id);
  // Links from Insights arrive with filters, e.g. #/library?cat=Pricing%20%26%20Licensing&asker=Chuck
  if (['cat', 'asker', 'rep', 'attention'].some((k) => params[k] != null)) {
    Object.assign(ui, {
      q: '', mine: false, limit: PAGE,
      cat: params.cat || '', asker: params.asker || '', rep: params.rep || '', attention: params.attention === '1',
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
          <button type="button" class="btn btn-primary" data-act="new">${icon('plus', 'icon-sm')}New question</button>
        </div>
      </header>

      <label class="search">
        ${icon('search')}
        <span class="visually-hidden">Search the library</span>
        <input type="search" id="lib-search" value="${esc(ui.q)}" placeholder="Search questions, answers, prospects or reps" autocomplete="off">
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
  const onSearch = debounce(() => { ui.q = search.value; ui.limit = PAGE; update(); }, 120);
  search.addEventListener('input', onSearch);

  el.onclick = onClick;
  el.onchange = (e) => {
    const f = e.target.dataset.filter;
    if (!f) return;
    ui[f] = e.target.value;
    ui.limit = PAGE;
    update();
  };
  update();
}

export function focusSearch() {
  root?.querySelector('#lib-search')?.focus();
}

export function update() {
  if (!root) return;
  const list = filtered();
  const t = terms();
  const total = state.items.length;
  const askers = new Set(state.items.map((i) => i.askedBy));
  const reps = new Set(state.items.flatMap((i) => repNames(i.answeredBy)));

  root.querySelector('[data-sub]').textContent =
    `${pluralize(total, 'answered question')} from ${pluralize(askers.size, 'prospect')}, answered by ${pluralize(reps.size, 'rep')}`;

  // Category chips
  const counts = new Map();
  state.items.forEach((i) => counts.set(i.topic, (counts.get(i.topic) || 0) + 1));
  const cats = state.categories.filter((c) => counts.get(c));
  root.querySelector('[data-chips]').innerHTML = [
    `<button type="button" class="chip" data-cat="" aria-pressed="${!ui.cat}">All<span class="chip-count">${total}</span></button>`,
    ...cats.map((c) => `<button type="button" class="chip" data-cat="${esc(c)}" aria-pressed="${ui.cat === c}">${esc(c)}<span class="chip-count">${counts.get(c)}</span></button>`),
  ].join('');

  // Secondary filters (rebuilt only when options change, so open selects aren't disrupted)
  const filters = root.querySelector('[data-filters]');
  const askerOpts = [...askers].sort();
  const repOpts = [...reps].sort();
  const sig = JSON.stringify([askerOpts, repOpts, ui.asker, ui.rep, ui.sort, ui.attention, ui.mine, state.config.shortWordThreshold]);
  if (filters.dataset.sig !== sig) {
    filters.dataset.sig = sig;
    const opt = (v, l, cur) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(l)}</option>`;
    filters.innerHTML = `
      <label class="visually-hidden" for="f-asker">Prospect</label>
      <select class="select select-inline" id="f-asker" data-filter="asker">${opt('', 'All prospects', ui.asker)}${askerOpts.map((a) => opt(a, a, ui.asker)).join('')}</select>
      <label class="visually-hidden" for="f-rep">Rep</label>
      <select class="select select-inline" id="f-rep" data-filter="rep">${opt('', 'All reps', ui.rep)}${repOpts.map((a) => opt(a, a, ui.rep)).join('')}</select>
      <label class="visually-hidden" for="f-sort">Sort</label>
      <select class="select select-inline" id="f-sort" data-filter="sort">
        ${opt('newest', 'Newest first', ui.sort)}${opt('oldest', 'Oldest first', ui.sort)}${opt('asker', 'Prospect A–Z', ui.sort)}${opt('rep', 'Rep A–Z', ui.sort)}${opt('topic', 'Category', ui.sort)}
      </select>
      <span class="sep" aria-hidden="true"></span>
      <button type="button" class="chip chip-warn" data-toggle="attention" aria-pressed="${ui.attention}" title="Answers under ${state.config.shortWordThreshold} words or missing">${icon('flag', 'icon-sm')}Needs attention</button>
      <button type="button" class="chip" data-toggle="mine" aria-pressed="${ui.mine}">Added by me</button>`;
  }

  const filtersOn = ui.q || ui.cat || ui.asker || ui.rep || ui.attention || ui.mine;
  root.querySelector('[data-count]').innerHTML = `<span><strong>${list.length}</strong> ${list.length === 1 ? 'result' : 'results'}${filtersOn ? ` of ${total}` : ''}</span>
    ${filtersOn ? '<button type="button" class="link-btn" data-act="reset">Clear filters</button>' : ''}`;

  // Results
  const listEl = root.querySelector('[data-list]');
  if (!list.length) {
    listEl.innerHTML = total
      ? `<div class="empty"><strong>No questions match</strong><span>Try fewer words or clear a filter.</span><button type="button" class="btn btn-sm" data-act="reset">Clear filters</button></div>`
      : `<div class="empty"><strong>The library is empty</strong><span>Add a question or import a spreadsheet to get started.</span>
         <div class="page-actions"><button type="button" class="btn" data-act="import">Import</button><button type="button" class="btn btn-primary" data-act="new">New question</button></div></div>`;
  } else {
    const thr = state.config.shortWordThreshold;
    listEl.innerHTML = list.slice(0, ui.limit).map((i) => `
      <button type="button" class="row" role="listitem" data-id="${i.id}" aria-current="${i.id === ui.sel}">
        <span class="row-id">#${i.id}</span>
        <span class="row-body">
          <span class="row-q">${highlight(i.question, t)}</span>
          <span class="row-a">${highlight(i.answer, t)}</span>
          <span class="row-meta">
            <span>${highlight(i.askedBy, t)}</span><span aria-hidden="true">·</span><span>${highlight(i.answeredBy, t)}</span>
            <span class="tag">${esc(i.topic)}</span>
            ${i.standard ? '<span class="badge badge-accent">Standard answer</span>' : ''}
            ${i.variantOf ? `<span class="badge badge-accent">Variant of #${i.variantOf}</span>` : ''}
            ${isNoAnswer(i.answer) ? '<span class="badge badge-warn">No answer</span>' : wordCount(i.answer) < thr ? '<span class="badge badge-warn">Brief answer</span>' : ''}
          </span>
        </span>
      </button>`).join('') + (list.length > ui.limit
        ? `<div class="more"><button type="button" class="btn btn-sm" data-act="more">Show ${Math.min(PAGE, list.length - ui.limit)} more</button></div>` : '');
  }

  // Keep a selection on wide screens
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
  const { company } = splitAsker(it.askedBy);
  const sim = getIndex().similarTo(it.id, 3, 15);
  const std = it.variantOf ? getItem(it.variantOf) : null;
  const variants = state.items.filter((x) => x.variantOf === it.id);
  const related = (it.related || []).map(getItem).filter(Boolean);
  const compareIds = [it.id, ...sim.slice(0, 2).map((s) => s.item.id)].join(',');

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
    ${it.standard || std || brief || isNoAnswer(it.answer) ? `<div class="detail-badges">
      ${it.standard ? '<span class="badge badge-accent">Standard answer</span>' : ''}
      ${std ? `<a class="badge badge-accent" href="#/library/${std.id}">Variant of #${std.id}</a>` : ''}
      ${isNoAnswer(it.answer) ? '<span class="badge badge-warn">No answer yet</span>' : brief ? '<span class="badge badge-warn">Brief answer, consider expanding</span>' : ''}
    </div>` : ''}
    <div class="answer-box">
      <div class="answer-head"><span>Answer</span>
        <button type="button" class="btn btn-sm" data-act="copy">${icon('copy', 'icon-sm')}Copy</button></div>
      <p class="answer-text">${esc(it.answer)}</p>
      ${std && std.answer !== it.answer ? `<div class="answer-head"><span>Standard answer (#${std.id})</span></div><p class="answer-text">${esc(std.answer)}</p>` : ''}
    </div>
    <dl class="meta-grid">
      <div><dt>Asked by</dt><dd><button type="button" class="link-btn" data-filter-asker="${esc(it.askedBy)}">${esc(it.askedBy)}</button></dd></div>
      <div><dt>Answered by</dt><dd>${esc(it.answeredBy)}</dd></div>
      ${company ? `<div><dt>Company</dt><dd>${esc(company)}</dd></div>` : ''}
      <div><dt>Answer length</dt><dd>${pluralize(words, 'word')}</dd></div>
      <div><dt>Added by</dt><dd>${esc(it.createdBy || 'Unknown')}</dd></div>
      ${it.updatedBy ? `<div><dt>Last edited by</dt><dd>${esc(it.updatedBy)}</dd></div>` : ''}
    </dl>
    ${variants.length ? `<div class="sim-list"><h3 class="section-title">Variants of this question</h3>
      ${variants.map((v) => simRow(v, null)).join('')}</div>` : ''}
    ${related.length ? `<div class="sim-list"><h3 class="section-title">Linked questions</h3>
      ${related.map((v) => simRow(v, null)).join('')}</div>` : ''}
    <div class="sim-list">
      <div class="section-head"><h3 class="section-title">Similar questions</h3>
        ${sim.length ? `<a href="#/review?tab=pick&ids=${compareIds}" style="font-size:13px;font-weight:500">Compare side by side</a>` : ''}</div>
      ${sim.length ? sim.map((s) => simRow(s.item, s.score)).join('') : '<p class="muted" style="font-size:13px">No similar questions yet.</p>'}
    </div>`;
}

const simRow = (item, score) => `
  <button type="button" class="sim-item" data-id="${item.id}">
    <span class="sim-score">${score == null ? `#${item.id}` : `${score}%`}</span>
    <span class="sim-text"><span>${esc(item.question)}</span><span>${esc(item.askedBy)} · ${esc(item.answeredBy)}</span></span>
  </button>`;

function select(id) {
  ui.sel = id;
  sheetOpen = matchMedia('(max-width: 860px)').matches;
  history.replaceState(null, '', `#/library/${id}`);
  root.querySelectorAll('.row').forEach((r) => r.setAttribute('aria-current', String(Number(r.dataset.id) === id)));
  renderDetail();
  if (!sheetOpen) root.querySelector(`.row[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest' });
}

function closeSheet() {
  sheetOpen = false;
  renderDetail();
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

  const fa = t.closest('[data-filter-asker]');
  if (fa) { Object.assign(ui, { asker: fa.dataset.filterAsker, cat: '', rep: '', q: '' }); root.querySelector('#lib-search').value = ''; update(); return; }

  const act = t.closest('[data-act]')?.dataset.act;
  if (!act) return;
  const it = ui.sel != null ? getItem(ui.sel) : null;

  switch (act) {
    case 'new': openQuestionDialog(null, { defaults: { topic: ui.cat }, onSaved: (id) => select(id) }); break;
    case 'import': openImportDialog(); break;
    case 'export': exportView(); break;
    case 'more': ui.limit += PAGE; update(); break;
    case 'reset':
      Object.assign(ui, { q: '', cat: '', asker: '', rep: '', attention: false, mine: false, limit: PAGE });
      root.querySelector('#lib-search').value = '';
      update();
      break;
    case 'edit': if (it) openQuestionDialog(it.id); break;
    case 'close-sheet': closeSheet(); break;
    case 'copy':
      if (it && await copyText(it.answer)) toast('Answer copied');
      break;
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
    const rows = list.map((i) => ({
      ID: i.id, Question: i.question, Answer: i.answer, 'Asked By': i.askedBy, 'Answered By': i.answeredBy,
      Category: i.topic, 'Added By': i.createdBy || '', Standard: i.standard ? 'Yes' : '', 'Variant Of': i.variantOf || '',
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Prospect Q&A');
    XLSX.writeFile(wb, `Prospect_QA_${new Date().toISOString().slice(0, 10)}.xlsx`);
    toast(`Exported ${pluralize(list.length, 'question')}`);
  } catch (err) {
    toastError(err.message);
  }
}
