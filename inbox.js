// To do: every decision waiting for a person, in one list, with one-tap answers.

import {
  state, getItem, setFollowUp, setVerdicts, addToTheme, saveThemes, dismissGroup, labelPair,
  dismissInbox, snoozeInbox, undoInbox, themeSnapshot, restoreThemes,
} from './store.js';
import {
  computeInbox, INBOX_TYPES, VERDICTS, verdictLabel, accountOf, themeById, themeHex, themeTagHTML,
} from './model.js';
import { toast } from './ui.js';
import { esc, fmtDate, todayISO, addDaysISO, pluralize, uid } from './utils.js';

const PAGE = 30;
const ui = { filter: 'all', limit: PAGE, names: {} };
let root = null;

export function mount(el, params) {
  root = el;
  if (params.type && INBOX_TYPES[params.type]) ui.filter = params.type;
  el.onclick = onClick;
  el.oninput = (e) => { if (e.target.dataset.name) ui.names[e.target.dataset.name] = e.target.value; };
  update();
}

export function update() {
  if (!root) return;
  const { cards, gaps } = computeInbox();
  const counts = {};
  cards.forEach((c) => { counts[c.type] = (counts[c.type] || 0) + 1; });
  // In "All", a long tail of verdicts would bury everything else: show a few, then one summary card.
  const VERDICT_PREVIEW = 5;
  let list = ui.filter === 'all' ? cards : cards.filter((c) => c.type === ui.filter);
  let moreVerdicts = 0;
  if (ui.filter === 'all' && (counts.verdict || 0) > VERDICT_PREVIEW) {
    let seen = 0;
    list = list.filter((c) => c.type !== 'verdict' || ++seen <= VERDICT_PREVIEW);
    moreVerdicts = counts.verdict - VERDICT_PREVIEW;
  }
  const gapText = [gaps.account && pluralize(gaps.account, 'question') + ' without an account', gaps.date && pluralize(gaps.date, 'question') + ' without a date'].filter(Boolean).join(' and ');

  root.innerHTML = `
    <div class="page inbox">
      <header class="page-head">
        <div>
          <h1 class="page-title">To do</h1>
          <p class="page-sub">${cards.length ? `${pluralize(cards.length, 'decision')} waiting. Most urgent first; each answer takes one tap.` : 'Nothing waiting.'}</p>
        </div>
      </header>

      ${cards.length ? `<div class="toolbar scroll-x" role="tablist" aria-label="Filter">
        <button type="button" class="chip" data-filter="all" aria-pressed="${ui.filter === 'all'}">All<span class="chip-count">${cards.length}</span></button>
        ${Object.entries(INBOX_TYPES).filter(([k]) => counts[k]).map(([k, v]) => `<button type="button" class="chip" data-filter="${k}" aria-pressed="${ui.filter === k}">${v.plural}<span class="chip-count">${counts[k]}</span></button>`).join('')}
      </div>` : ''}

      ${gapText ? `<div class="notice">${gapText}. These can’t be counted in trends yet. <a href="#/complete">Complete records</a></div>` : ''}

      <div class="inbox-list">
        ${list.slice(0, ui.limit).map(card).join('') || `<div class="card empty"><strong>All caught up</strong><span>New items appear here as calls are logged and questions are added.</span></div>`}
        ${moreVerdicts && list.length <= ui.limit ? `<div class="card ib-card ib-more"><span>${pluralize(moreVerdicts, 'more answer')} without a verdict.</span><button type="button" class="btn" data-filter="verdict">Set verdicts</button></div>` : ''}
        ${list.length > ui.limit ? `<div class="more"><button type="button" class="btn" data-act="more">Show ${Math.min(PAGE, list.length - ui.limit)} more</button></div>` : ''}
      </div>
    </div>`;
}

const q = (i, { answer = true } = {}) => `
  <div class="ib-q">
    <a class="ib-q-title" href="#/library/${i.id}"><span class="mono muted">#${i.id}</span> ${esc(i.question)}</a>
    ${answer ? `<p class="ib-a">${esc(i.answer)}</p>` : ''}
    <span class="muted ib-meta">${esc(accountOf(i))} · ${esc(i.answeredBy)}${i.verdict ? ` · <span class="vbadge v-${i.verdict}">${verdictLabel(i.verdict)}</span>` : ''} ${themeTagHTML(i, { short: true })}</span>
  </div>`;

const head = (c, extra = '') => `<div class="ib-head"><span class="ib-type ib-${c.type}">${INBOX_TYPES[c.type].label}</span>${extra}</div>`;

function card(c) {
  const k = esc(c.key);
  switch (c.type) {
    case 'followup': {
      const f = c.item.followUp;
      return `<article class="card ib-card">
        ${head(c, `<span class="${c.overdue ? 'warn-text' : 'muted'}">${f.due ? `${c.overdue ? 'Overdue since' : 'Due'} ${esc(fmtDate(f.due, { year: false }))}` : 'No due date'} · ${esc(f.owner || 'No owner')}</span>`)}
        ${q(c.item)}
        <div class="ib-actions"><button type="button" class="btn btn-primary" data-do="fu-done" data-k="${k}" data-id="${c.item.id}">Done</button>
          <button type="button" class="btn" data-do="snooze" data-k="${k}" data-days="7">Snooze a week</button></div>
      </article>`;
    }
    case 'conflict':
      return `<article class="card ib-card ib-warn">
        ${head(c, `<span class="muted">${c.score}% alike</span>`)}
        <p class="ib-why">These ask nearly the same thing, but one answer is marked ${verdictLabel(c.a.verdict)} and the other ${verdictLabel(c.b.verdict)}.</p>
        <div class="ib-pair">${q(c.a)}${q(c.b)}</div>
        <div class="ib-actions"><a class="btn btn-primary" href="#/review?tab=pick&ids=${c.a.id},${c.b.id}">Settle in Review</a>
          <button type="button" class="btn" data-do="dismiss" data-k="${k}">They don’t conflict</button></div>
      </article>`;
    case 'dup':
      return `<article class="card ib-card">
        ${head(c, `<span class="muted">${c.score}% alike</span>`)}
        <p class="ib-why">Is this the same question asked twice?</p>
        <div class="ib-pair">${q(c.a)}${q(c.b)}</div>
        <div class="ib-actions"><button type="button" class="btn btn-primary" data-do="dup-same" data-k="${k}" data-a="${c.a.id}" data-b="${c.b.id}">Same question</button>
          <button type="button" class="btn" data-do="dup-diff" data-k="${k}" data-a="${c.a.id}" data-b="${c.b.id}">Different questions</button></div>
      </article>`;
    case 'fit': {
      const t = themeById(c.themeId);
      return `<article class="card ib-card">
        ${head(c, `<span class="muted">${c.score}% fit</span>`)}
        <p class="ib-why">Looks like it belongs in <span class="theme-tag" style="--tc:${themeHex(t)}"><i aria-hidden="true"></i>${esc(t.name)}</span></p>
        ${q(c.item)}
        <div class="ib-actions"><button type="button" class="btn btn-primary" data-do="fit-add" data-k="${k}" data-id="${c.item.id}" data-theme="${esc(c.themeId)}">Add to theme</button>
          <button type="button" class="btn" data-do="dismiss" data-k="${k}">Not this theme</button></div>
      </article>`;
    }
    case 'group': {
      const name = ui.names[c.key] ?? c.group.title.replace(/\?$/, '');
      return `<article class="card ib-card">
        ${head(c, `<span class="muted">${pluralize(c.ids.length, 'question')}</span>`)}
        <p class="ib-why">These look like one theme. Give it a short name to confirm it.</p>
        <ul class="ib-list">${c.ids.map((id) => { const i = getItem(id); return `<li><a href="#/library/${id}"><span class="mono muted">#${id}</span> ${esc(i.question)}</a> <span class="muted">· ${esc(accountOf(i))}</span></li>`; }).join('')}</ul>
        <div class="ib-actions"><label class="visually-hidden" for="gn-${k}">Theme name</label>
          <input class="input ib-name" id="gn-${k}" data-name="${k}" value="${esc(name)}">
          <button type="button" class="btn btn-primary" data-do="group-ok" data-k="${k}">Confirm theme</button>
          <button type="button" class="btn" data-do="group-no" data-k="${k}">Not related</button></div>
      </article>`;
    }
    case 'verdict':
      return `<article class="card ib-card">
        ${head(c, c.suggested ? `<span class="muted">Suggested: ${verdictLabel(c.suggested)}</span>` : '')}
        ${q(c.item)}
        <p class="ib-why">Can we do what was asked?</p>
        <div class="ib-actions pills">${VERDICTS.map((v) => `<button type="button" class="pill ${v.id === c.suggested ? 'pill-suggested' : ''}" data-do="verdict" data-k="${k}" data-id="${c.item.id}" data-v="${v.id}">${v.label}</button>`).join('')}
          <button type="button" class="link-btn" data-do="snooze" data-k="${k}" data-days="14">Later</button></div>
      </article>`;
    default: return '';
  }
}

const findCard = (key) => computeInbox().cards.find((c) => c.key === key);
const undoKey = (key) => ({ label: 'Undo', run: () => undoInbox(key).then((ok) => ok && toast('Undone')) });

async function onClick(e) {
  const t = e.target;
  const f = t.closest('[data-filter]');
  if (f) { ui.filter = f.dataset.filter; ui.limit = PAGE; update(); return; }
  if (t.closest('[data-act="more"]')) { ui.limit += PAGE; update(); return; }
  const b = t.closest('[data-do]');
  if (!b) return;
  const key = b.dataset.k;
  const c = findCard(key);
  switch (b.dataset.do) {
    case 'fu-done': {
      const it = getItem(Number(b.dataset.id));
      const prev = structuredClone(it.followUp);
      if (await setFollowUp(it.id, { ...it.followUp, done: true, doneAt: todayISO() })) toast('Follow-up done', { action: { label: 'Undo', run: () => setFollowUp(it.id, prev) } });
      break;
    }
    case 'snooze': {
      const days = Number(b.dataset.days);
      if (await snoozeInbox(key, addDaysISO(todayISO(), days))) toast(`Hidden for ${days} days`, { action: undoKey(key) });
      break;
    }
    case 'dismiss':
      if (await dismissInbox(key)) toast('Dismissed', { action: undoKey(key) });
      break;
    case 'dup-same': {
      const a = getItem(Number(b.dataset.a)), bb = getItem(Number(b.dataset.b));
      await labelPair(a.id, bb.id, 'same', 'inbox');
      // If only one is in a theme, bring the other one in too.
      const lone = a.themeId && !bb.themeId ? [bb, a.themeId] : bb.themeId && !a.themeId ? [a, bb.themeId] : null;
      if (lone) { await addToTheme([lone[0].id], lone[1]); toast(`Marked as the same question; #${lone[0].id} joined “${themeById(lone[1])?.name}”`); }
      else toast('Marked as the same question');
      break;
    }
    case 'dup-diff':
      if (await labelPair(Number(b.dataset.a), Number(b.dataset.b), 'topic', 'inbox')) toast('Noted as different questions');
      break;
    case 'fit-add': {
      const snap = themeSnapshot();
      const th = themeById(b.dataset.theme);
      if (await addToTheme([Number(b.dataset.id)], b.dataset.theme)) toast(`Added to “${th?.name}”`, { action: { label: 'Undo', run: () => restoreThemes(snap) } });
      break;
    }
    case 'group-ok': {
      if (!c) return;
      const name = (root.querySelector(`[data-name="${CSS.escape(key)}"]`)?.value || '').trim() || c.group.title;
      if (await saveThemes([{ id: uid('theme'), name: name.replace(/\?$/, ''), ids: c.ids }])) { delete ui.names[key]; toast(`Saved “${name}”`); }
      break;
    }
    case 'group-no':
      if (c && await dismissGroup(c.group)) toast('Marked as not related. Find it under Review › Resolved.');
      break;
    case 'verdict': {
      const id = Number(b.dataset.id);
      if (await setVerdicts([id], b.dataset.v)) toast(`#${id}: ${verdictLabel(b.dataset.v)}`, { action: { label: 'Undo', run: () => setVerdicts([id], null) } });
      break;
    }
  }
}
