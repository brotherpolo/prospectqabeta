// Overview: the management home screen. Themes, gaps, follow-ups and accounts for a period.

import { state, getItem, getIndex, setFollowUp, semanticStatus } from './store.js';
import {
  PERIODS, VERDICTS, verdictLabel, inPeriod, accountOf, isQuestion,
  effectiveThemes, themeIndex, verdictMix, conflictPairs, monthlyAccounts, isRepeat,
} from './model.js';
import { openSalesforceImport } from './import.js';
import { toast, toastError } from './ui.js';
import { esc, icon, fmtDate, todayISO, loadXLSX, pluralize } from './utils.js';

const ui = { period: null, open: null, showAll: false };
let root = null;

export function mount(el, params) {
  root = el;
  if (params.period && PERIODS[params.period]) ui.period = params.period;
  // Until most questions have dates, a 90-day view would look empty, so start on All time.
  if (!ui.period) {
    const qs = state.items.filter(isQuestion);
    ui.period = qs.filter((i) => i.askedAt).length >= qs.length / 2 ? 'q' : 'all';
  }
  el.onclick = onClick;
  update();
}

function themeRows(p) {
  return effectiveThemes().map((t) => {
    const all = t.ids.map(getItem).filter((i) => i && isQuestion(i));
    const items = all.filter((i) => inPeriod(i, p));
    if (!items.length) return null;
    const accounts = [...new Set(items.map(accountOf))];
    const mix = verdictMix(items);
    const std = all.find((i) => i.standard);
    const conflicts = conflictPairs(items);
    const status = conflicts.length ? 'differ' : t.confirmed ? (std ? 'approved' : 'needs') : 'suggested';
    const last = items.map((i) => i.askedAt).filter(Boolean).sort().at(-1);
    const prev = p === 'all' ? 0 : new Set(all.filter((i) => inPeriod(i, p, 1)).map(accountOf)).size;
    return { t, all, items, accounts, mix, std, status, conflicts, last, spark: monthlyAccounts(all), prev };
  }).filter(Boolean).sort((a, b) => b.accounts.length - a.accounts.length || b.items.length - a.items.length);
}

const STATUS = {
  approved: ['Approved', 'badge-ok'],
  needs: ['Needs approval', ''],
  differ: ['Answers differ', 'badge-warn'],
  suggested: ['Suggested', 'badge-accent'],
};

function spark(values) {
  if (!values.some(Boolean)) return '<span class="muted" style="font-size:12px">No dates yet</span>';
  const max = Math.max(...values, 1);
  const pts = values.map((v, i) => `${3 + i * (86 / (values.length - 1))},${23 - (v / max) * 19}`).join(' ');
  return `<svg class="spark" viewBox="0 0 92 26" role="img" aria-label="Accounts asking per month: ${values.join(', ')}"><polyline points="${pts}"/></svg>`;
}

function mixBar(mix) {
  const total = Object.values(mix).reduce((a, b) => a + b, 0);
  if (!total || mix.unset === total) return '<span class="muted" style="font-size:12px">Not set yet</span>';
  const parts = [...VERDICTS.filter((v) => mix[v.id]), ...(mix.unset ? [{ id: 'unset', label: 'Not set', color: 'var(--line-strong)' }] : [])];
  const title = parts.map((v) => `${v.label} ${mix[v.id]}`).join(', ');
  return `<span class="mixbar" role="img" aria-label="${title}" title="${title}">${parts
    .map((v) => `<span style="width:${(mix[v.id] / total) * 100}%;background:${v.color}"></span>`).join('')}</span>`;
}

export function update() {
  if (!root) return;
  const p = ui.period;
  const qs = state.items.filter(isQuestion);
  const inP = qs.filter((i) => inPeriod(i, p));
  const prevP = p === 'all' ? [] : qs.filter((i) => inPeriod(i, p, 1));
  const accounts = new Set(inP.map(accountOf));
  const allAccounts = new Set(qs.map(accountOf));
  const firstSeen = new Map();
  [...qs].sort((a, b) => (a.askedAt || '').localeCompare(b.askedAt || '')).forEach((i) => { if (!firstSeen.has(accountOf(i))) firstSeen.set(accountOf(i), i); });
  const newAccounts = p === 'all' ? 0 : [...accounts].filter((a) => inPeriod(firstSeen.get(a), p)).length;
  const tOf = themeIndex();
  const repeats = inP.filter((i) => isRepeat(i, tOf)).length;
  const themes = effectiveThemes();
  const confirmed = themes.filter((t) => t.confirmed);
  const approved = confirmed.filter((t) => t.ids.some((id) => getItem(id)?.standard)).length;
  const follow = state.items.filter((i) => i.followUp && !i.followUp.done);
  const overdue = follow.filter((i) => i.followUp.due && i.followUp.due < todayISO()).length;
  const undated = qs.filter((i) => !i.askedAt).length;
  const rows = themeRows(p);
  const sem = semanticStatus();
  const mode = getIndex().mode;
  const delta = inP.length - prevP.length;

  const kpis = [
    ['Questions asked', inP.length, p === 'all' ? 'Since tracking began' : `${delta >= 0 ? '+' : ''}${delta} vs previous ${PERIODS[p].short}`, p !== 'all' && delta > 0 ? 'up' : ''],
    ['Accounts asking', accounts.size, p === 'all' ? `${pluralize(qs.length, 'question')} in total` : newAccounts ? `${newAccounts} new this period` : 'No new accounts', ''],
    ['Repeat rate', inP.length ? `${Math.round((repeats / inP.length) * 100)}%` : '–', 'Matched an earlier question', ''],
    ['Themes with an approved answer', confirmed.length ? `${approved} of ${confirmed.length}` : '0', confirmed.length - approved ? `${confirmed.length - approved} still need one` : themes.length - confirmed.length ? `${themes.length - confirmed.length} suggested to confirm` : 'All approved', confirmed.length - approved ? 'warn' : ''],
    ['Open follow-ups', follow.length, overdue ? `${overdue} overdue` : 'None overdue', overdue ? 'warn' : ''],
  ];

  const visible = ui.showAll ? rows : rows.slice(0, 10);

  root.innerHTML = `
    <div class="page">
      <header class="page-head">
        <div>
          <h1 class="page-title">Overview</h1>
          <p class="page-sub">What prospects keep asking, what’s changing, and what needs a decision.</p>
        </div>
        <div class="page-actions">
          <div class="tabs" role="tablist" aria-label="Time period">
            ${Object.entries(PERIODS).map(([id, v]) => `<button type="button" class="tab" role="tab" data-period="${id}" aria-selected="${p === id}">${v.label}</button>`).join('')}
          </div>
          <button type="button" class="btn" data-act="export">${icon('download', 'icon-sm')}Export summary</button>
        </div>
      </header>

      ${notices({ p, undated, accounts: allAccounts.size, mode, sem })}

      <div class="kpis kpis-5">
        ${kpis.map(([label, value, sub, tone]) => `
          <div class="kpi"><span class="kpi-label">${label}</span><span class="kpi-value ${tone === 'warn' ? 'warn' : ''}">${value}</span><span class="kpi-sub ${tone}">${esc(sub)}</span></div>`).join('')}
      </div>

      <div class="split">
        <section class="card themes-card" aria-label="Top themes">
          <div class="card-head">
            <h2 class="card-title">Top themes</h2>
            <span class="legend">${VERDICTS.slice(0, 5).map((v) => `<span><i style="background:${v.color}"></i>${v.label}</span>`).join('')}</span>
          </div>
          ${rows.length ? `
          <div class="theme-grid theme-head" aria-hidden="true"><span>Theme</span><span class="num">Asked</span><span class="num">Accounts</span><span>Accounts per month</span><span>Answers given</span><span>Status</span></div>
          ${visible.map(themeRow).join('')}
          ${rows.length > 10 ? `<div class="more"><button type="button" class="btn btn-sm" data-act="all-themes">${ui.showAll ? 'Show top 10' : `Show all ${rows.length}`}</button></div>` : ''}`
          : `<div class="empty"><strong>No questions in this period</strong><span>${undated && p !== 'all' ? 'Your questions don’t have dates yet. ' : ''}Try All time, or log a call.</span></div>`}
        </section>

        <div class="side-col">
          ${gapsCard(p)}
          ${risingCard(p, rows)}
          ${followCard(follow)}
        </div>
      </div>

      ${accountsCard(p, inP, tOf)}
    </div>`;
}

function notices({ p, undated, accounts, mode, sem }) {
  const out = [];
  if (mode === 'words') {
    const msg = sem.state === 'loading'
      ? `Loading the smart matching model${sem.progress ? ` (${sem.progress}%)` : ''}. This happens once per browser; themes use word matching until it’s ready.`
      : sem.state === 'error' ? 'Smart matching couldn’t load in this browser, so themes use word matching, which misses related questions worded differently.'
        : state.config.semanticMatching === false ? 'Smart matching is off, so themes use word matching. Turn it on in Matching rules.' : '';
    if (msg) out.push(`<div class="notice">${esc(msg)}</div>`);
  }
  if (undated && p !== 'all') out.push(`<div class="notice">${pluralize(undated, 'question')} ${undated === 1 ? 'has' : 'have'} no date yet, so ${undated === 1 ? 'it only appears' : 'they only appear'} under All time. <a href="#/complete">Complete records</a></div>`);
  if (accounts < 5) out.push(`<div class="notice">Early days: ${pluralize(accounts, 'account')} so far. Trends become meaningful as more calls are logged. Themes are ranked by how many accounts ask, so one talkative prospect can’t dominate.</div>`);
  return out.join('');
}

function themeRow(r) {
  const open = ui.open === r.t.id;
  const [label, cls] = STATUS[r.status];
  const shown = r.std || [...r.items].sort((a, b) => (b.askedAt || '').localeCompare(a.askedAt || '') || b.id - a.id)[0];
  return `
    <div class="theme-item">
      <button type="button" class="theme-grid theme-btn" data-theme="${esc(r.t.id)}" aria-expanded="${open}">
        <span class="theme-name"><span class="chev" aria-hidden="true">${open ? '▾' : '▸'}</span>
          <span><strong title="${esc(r.t.name)}">${esc(r.t.name)}</strong><span class="muted">${esc(r.items[0].topic)}${r.last ? ` · last asked ${esc(fmtDate(r.last, { year: false }))}` : ''}</span></span></span>
        <span class="num mono">${r.items.length}</span>
        <span class="num mono">${r.accounts.length}</span>
        <span>${spark(r.spark)}</span>
        <span>${mixBar(r.mix)}</span>
        <span><span class="badge ${cls}">${label}</span></span>
      </button>
      ${open ? `
      <div class="theme-detail">
        <div class="theme-answer">
          <span class="field-label">${r.std ? `Approved answer (#${r.std.id})` : `Most recent answer (#${shown.id})`}</span>
          <p class="quote">${esc(shown.answer)}</p>
          ${r.conflicts.length ? `<p class="warn-text">#${r.conflicts[0].no.id} and #${r.conflicts[0].yes.id} ask nearly the same thing (${r.conflicts[0].score}% match), but one answer is marked No and the other ${r.conflicts[0].yes.verdict === 'yes' ? 'Yes' : 'Partial'}. One approved answer would settle it.</p>` : ''}
        </div>
        <div class="theme-meta">
          <span class="field-label">Asked by</span>
          <div class="toolbar">${r.accounts.map((a) => `<span class="tag">${esc(a)}</span>`).join('')}</div>
          <span class="field-label">Questions</span>
          <div class="toolbar">${r.items.map((i) => `<a class="mono" href="#/library/${i.id}">#${i.id}</a>`).join(' ')}</div>
          <div class="toolbar">
            <a class="btn btn-sm" href="#/library?ids=${r.all.map((i) => i.id).join(',')}">Open in Library</a>
            ${r.t.confirmed ? '' : `<a class="btn btn-sm btn-primary" href="#/review?key=${esc(r.t.key)}">Confirm theme</a>`}
            ${r.conflicts.length ? `<a class="btn btn-sm" href="#/review?tab=pick&ids=${r.conflicts[0].no.id},${r.conflicts[0].yes.id}">Settle in Review</a>` : r.t.confirmed && !r.std ? `<a class="btn btn-sm" href="#/review?tab=pick&ids=${r.all.slice(0, 3).map((i) => i.id).join(',')}">Choose approved answer</a>` : ''}
          </div>
        </div>
      </div>` : ''}
    </div>`;
}

function gapsCard(p) {
  const tOf = themeIndex();
  const gaps = new Map();
  for (const i of state.items.filter((x) => isQuestion(x) && inPeriod(x, p))) {
    const v = i.verdict;
    if (!['no', 'roadmap', 'partial'].includes(v)) continue;
    const t = tOf.get(i.id);
    const key = t ? t.id : `q${i.id}`;
    const g = gaps.get(key) || { name: t ? t.name : i.question, verdicts: new Set(), accounts: new Set(), ids: [] };
    g.verdicts.add(v); g.accounts.add(accountOf(i)); g.ids.push(i.id);
    gaps.set(key, g);
  }
  const list = [...gaps.values()].sort((a, b) => b.accounts.size - a.accounts.size || b.ids.length - a.ids.length);
  const order = ['roadmap', 'no', 'partial'];
  return `<section class="card">
    <div class="card-head"><h2 class="card-title">Gaps and promises</h2>${list.length ? '<button type="button" class="link-btn" data-act="export-gaps">Export for product</button>' : ''}</div>
    ${list.length ? `<div class="gap-list">${list.slice(0, 6).map((g) => {
      const v = order.find((x) => g.verdicts.has(x));
      return `<div class="gap"><span class="vbadge v-${v}">${verdictLabel(v)}</span>
        <span>${esc(g.name)} <span class="muted">· ${[...g.accounts].map(esc).join(', ')} · ${g.ids.map((id) => `<a href="#/library/${id}">#${id}</a>`).join(' ')}</span></span></div>`;
    }).join('')}</div>${list.length > 6 ? `<p class="field-hint">${list.length - 6} more in the export.</p>` : ''}`
      : '<p class="muted">No “No”, “Partial” or “Roadmap” verdicts in this period.</p>'}
    ${unsetVerdicts(p) ? `<p class="field-hint">${pluralize(unsetVerdicts(p), 'answer')} in this period ${unsetVerdicts(p) === 1 ? 'has' : 'have'} no verdict yet, so ${unsetVerdicts(p) === 1 ? 'it isn’t' : 'they aren’t'} counted. <a href="#/complete">Set verdicts</a></p>` : ''}
  </section>`;
}

const unsetVerdicts = (p) => state.items.filter((i) => isQuestion(i) && inPeriod(i, p) && !i.verdict).length;

function risingCard(p, rows) {
  if (p === 'all') return `<section class="card"><h2 class="card-title">Rising</h2><p class="muted" style="margin-top:8px">Choose 30 or 90 days to compare with the period before.</p></section>`;
  const rising = rows.map((r) => ({ name: r.t.name, d: r.accounts.length - r.prev, prev: r.prev })).filter((r) => r.d > 0).sort((a, b) => b.d - a.d).slice(0, 4);
  return `<section class="card"><h2 class="card-title">Rising</h2>
    ${rising.length ? `<div class="rise-list">${rising.map((r) => `<div class="rise"><span>${esc(r.name)}</span><span class="mono up">${r.prev ? `+${r.d}` : 'new'} ${r.d === 1 ? 'account' : 'accounts'}</span></div>`).join('')}</div>`
      : `<p class="muted" style="margin-top:8px">Nothing is being asked by more accounts than in the previous ${PERIODS[p].short}.</p>`}
  </section>`;
}

function followCard(follow) {
  const sorted = [...follow].sort((a, b) => (a.followUp.due || '9').localeCompare(b.followUp.due || '9'));
  const today = todayISO();
  return `<section class="card"><h2 class="card-title">Open follow-ups</h2>
    ${sorted.length ? `<div class="follow-list">${sorted.slice(0, 6).map((i) => `
      <div class="follow">
        <div><a href="#/library/${i.id}">${esc(i.question)}</a>
          <span class="muted">${esc(i.followUp.owner || 'No owner')} · #${i.id}${i.followUp.due ? ` · ${i.followUp.due < today ? `<span class="warn-text">overdue since ${esc(fmtDate(i.followUp.due, { year: false }))}</span>` : `due ${esc(fmtDate(i.followUp.due, { year: false }))}`}` : ''}</span></div>
        <button type="button" class="btn btn-sm" data-done="${i.id}">Done</button>
      </div>`).join('')}</div>` : '<p class="muted" style="margin-top:8px">Nothing open.</p>'}
  </section>`;
}

function accountsCard(p, inP, tOf) {
  const by = new Map();
  for (const i of inP) (by.get(accountOf(i)) || by.set(accountOf(i), []).get(accountOf(i))).push(i);
  const today = todayISO();
  const rows = [...by.entries()].sort((a, b) => b[1].length - a[1].length).map(([acct, items]) => {
    const calls = state.config.calls.filter((c) => c.company === acct).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const counts = new Map();
    items.forEach((i) => { const t = tOf.get(i.id); if (t) counts.set(t.name, (counts.get(t.name) || 0) + 1); });
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n]) => n);
    const fu = items.filter((i) => i.followUp && !i.followUp.done);
    const promises = items.filter((i) => i.verdict === 'roadmap');
    const open = [fu.length && `${pluralize(fu.length, 'follow-up')}${fu.some((i) => i.followUp.due && i.followUp.due < today) ? ' (overdue)' : ''}`, promises.length && pluralize(promises.length, 'roadmap promise')].filter(Boolean);
    const sf = state.config.accounts[acct];
    return `<tr>
      <td><a href="#/library?account=${encodeURIComponent(acct)}"><strong>${esc(acct)}</strong></a></td>
      <td>${sf?.stage ? esc(sf.stage) : '<span class="muted">–</span>'}</td>
      <td class="num mono">${items.length}</td>
      <td>${calls[0] ? `${esc(fmtDate(calls[0].date, { year: false }))} · ${esc(calls[0].type || 'call')}` : '<span class="muted">–</span>'}</td>
      <td>${top.length ? `<span class="clamp-2" title="${esc(top.join(' · '))}">${top.map(esc).join(' · ')}</span>` : '<span class="muted">–</span>'}</td>
      <td class="${open.length ? 'warn-text' : 'muted'}">${open.length ? open.join(', ') : 'None'}</td>
    </tr>`;
  });
  const meta = state.config.accountsImport;
  return `<section class="card">
    <div class="card-head"><h2 class="card-title">Accounts</h2>
      <span class="toolbar"><span class="field-hint">${meta ? `Stages from ${esc(meta.file || 'Salesforce report')}, imported ${esc(fmtDate(meta.at?.slice(0, 10)))}` : 'Import a Salesforce report to add deal stages'}</span>
      <button type="button" class="btn btn-sm" data-act="sf">${icon('upload', 'icon-sm')}Import Salesforce report</button></span></div>
    ${rows.length ? `<div class="table-wrap"><table class="table">
      <thead><tr><th>Account</th><th>Stage</th><th class="num">Questions</th><th>Last call</th><th>Top themes</th><th>Open items</th></tr></thead>
      <tbody>${rows.join('')}</tbody></table></div>` : '<p class="muted">No questions in this period.</p>'}
  </section>`;
}

async function onClick(e) {
  const t = e.target;
  const per = t.closest('[data-period]');
  if (per) { ui.period = per.dataset.period; ui.open = null; history.replaceState(null, '', `#/overview?period=${ui.period}`); update(); return; }
  const th = t.closest('[data-theme]');
  if (th) { ui.open = ui.open === th.dataset.theme ? null : th.dataset.theme; update(); return; }
  const done = t.closest('[data-done]');
  if (done) {
    const it = getItem(Number(done.dataset.done));
    if (it && await setFollowUp(it.id, { ...it.followUp, done: true, doneAt: todayISO() })) toast('Follow-up marked done');
    return;
  }
  const act = t.closest('[data-act]')?.dataset.act;
  if (act === 'all-themes') { ui.showAll = !ui.showAll; update(); }
  else if (act === 'sf') openSalesforceImport();
  else if (act === 'export') exportSummary(false);
  else if (act === 'export-gaps') exportSummary(true);
}

async function exportSummary(gapsOnly) {
  try {
    const XLSX = await loadXLSX();
    const p = ui.period;
    const wb = XLSX.utils.book_new();
    const rows = themeRows(p);
    const gapRows = [];
    for (const i of state.items.filter((x) => isQuestion(x) && inPeriod(x, p))) {
      const v = i.verdict;
      if (['no', 'roadmap', 'partial'].includes(v)) {
        gapRows.push({ Verdict: verdictLabel(v), Theme: themeIndex().get(i.id)?.name || '', Question: i.question, Answer: i.answer, Account: accountOf(i), Date: i.askedAt || '', ID: i.id });
      }
    }
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(gapRows.length ? gapRows : [{ Note: 'No gaps in this period' }]), 'Gaps and promises');
    if (!gapsOnly) {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows.map((r) => ({
        Theme: r.t.name, Status: STATUS[r.status][0], Questions: r.items.length, Accounts: r.accounts.length,
        'Asked by': r.accounts.join(', '), 'Last asked': r.last || '', 'Approved answer': r.std?.answer || '',
        ...Object.fromEntries(VERDICTS.map((v) => [v.label, r.mix[v.id] || 0])),
      }))), 'Themes');
      const fu = state.items.filter((i) => i.followUp && !i.followUp.done);
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(fu.length ? fu.map((i) => ({ Question: i.question, Owner: i.followUp.owner || '', Due: i.followUp.due || '', Account: accountOf(i), ID: i.id })) : [{ Note: 'No open follow-ups' }]), 'Follow-ups');
    }
    XLSX.writeFile(wb, `QA_${gapsOnly ? 'Gaps' : 'Summary'}_${PERIODS[p].short.replace(/\s/g, '')}_${todayISO()}.xlsx`);
    toast('Downloaded');
  } catch (err) { toastError(err.message); }
}

