// Meeting summary: one printable page. Print or "Save as PDF" from the browser.

import { state, getItem } from './store.js';
import { PERIODS, accountOf, effectiveThemes, inPeriod, isQuestion, themeById, themeHex } from './model.js';
import { changesHTML } from './changes.js';
import { esc, fmtDate, todayISO, pluralize } from './utils.js';

const ui = { period: 'q' };
let root = null;

export function mount(el, params) {
  root = el;
  if (params.period && PERIODS[params.period]?.days) ui.period = params.period;
  el.onclick = (e) => {
    const b = e.target.closest('[data-period]');
    if (b) { ui.period = b.dataset.period; history.replaceState(null, '', `#/summary?period=${ui.period}`); update(); }
    if (e.target.closest('[data-act="print"]')) window.print();
  };
  update();
}

export function update() {
  if (!root) return;
  const p = ui.period;
  const qs = state.items.filter((i) => isQuestion(i) && inPeriod(i, p));
  const themes = effectiveThemes().map((t) => {
    const its = t.ids.map(getItem).filter((i) => i && inPeriod(i, p));
    return { t, its, accts: new Set(its.map(accountOf)).size, approved: t.ids.some((id) => getItem(id)?.standard) };
  }).filter((x) => x.its.length).sort((a, b) => b.accts - a.accts || b.its.length - a.its.length)
    .slice(0, 8);
  const today = todayISO();
  const follow = state.items.filter((i) => i.followUp && !i.followUp.done).sort((a, b) => (a.followUp.due || '9').localeCompare(b.followUp.due || '9'));

  root.innerHTML = `
    <div class="page summary-page">
      <div class="no-print summary-tools">
        <a class="btn" href="#/overview">← Overview</a>
        <div class="tabs" role="tablist" aria-label="Period">
          ${Object.entries(PERIODS).filter(([, v]) => v.days).map(([id, v]) => `<button type="button" class="tab" role="tab" data-period="${id}" aria-selected="${p === id}">${v.label}</button>`).join('')}
        </div>
        <button type="button" class="btn btn-primary" data-act="print">Print or save as PDF</button>
      </div>
      <article class="summary-sheet">
        <header class="summary-head">
          <div><h1>Prospect Q&amp;A: what changed</h1><p class="muted">${PERIODS[p].label}, prepared ${esc(fmtDate(today))}</p></div>
          <div class="summary-kpis">
            <span><strong>${qs.length}</strong> questions</span>
            <span><strong>${new Set(qs.map(accountOf)).size}</strong> accounts</span>
            <span><strong>${follow.length}</strong> open follow-ups</span>
          </div>
        </header>
        ${changesHTML(p, { print: true })}
        <section class="wc-sec summary-top">
          <h3>Top themes <span class="muted">this period, by accounts</span></h3>
          ${themes.length ? `<table class="table"><thead><tr><th>Theme</th><th class="num">Accounts</th><th class="num">Questions</th><th>Approved answer</th></tr></thead>
            <tbody>${themes.map((x) => `<tr><td>${x.t.confirmed && themeById(x.t.id) ? `<span class="theme-dot" style="--tc:${themeHex(themeById(x.t.id))}"></span> ` : ''}${esc(x.t.name)}${x.t.confirmed ? '' : ' <span class="muted">(suggested)</span>'}</td><td class="num mono">${x.accts}</td><td class="num mono">${x.its.length}</td><td>${x.approved ? 'Yes' : '<span class="muted">Not yet</span>'}</td></tr>`).join('')}</tbody></table>`
            : '<p class="muted">No themed questions this period.</p>'}
        </section>
        <section class="wc-sec">
          <h3>Open follow-ups</h3>
          ${follow.length ? `<ul class="wc-list">${follow.slice(0, 6).map((i) => `<li><span class="wc-main">${esc(i.question)} <span class="muted">· ${esc(accountOf(i))}</span></span><span class="wc-side ${i.followUp.due && i.followUp.due < today ? 'warn-text' : 'muted'}">${esc(i.followUp.owner || 'No owner')}${i.followUp.due ? ` · ${i.followUp.due < today ? 'overdue since' : 'due'} ${esc(fmtDate(i.followUp.due, { year: false }))}` : ''}</span></li>`).join('')}</ul>${follow.length > 6 ? `<p class="field-hint">${follow.length - 6} more in the app.</p>` : ''}`
            : '<p class="muted">None.</p>'}
        </section>
        <footer class="summary-foot muted">Prospect Q&amp;A Hub · ${esc(PERIODS[p].label)} · page 2 of 2. Counts are by account where noted, so one talkative prospect can’t dominate. Only verdicts confirmed by a person are counted as gaps.</footer>
      </article>
    </div>`;
}
