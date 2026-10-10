// Insights: replaces the Frequency page. Every number links to the matching Library view.

import { state, getIndex, openGroups, normalizeRepNames } from './store.js';
import { toast, confirmDialog } from './ui.js';
import { esc, wordCount, isNoAnswer, repNames, canonicalRep, splitAsker, pluralize } from './utils.js';

let root = null;

export function mount(el) {
  root = el;
  el.onclick = onClick;
  update();
}

const lib = (params) => `#/library?${new URLSearchParams(params).toString()}`;

export function update() {
  if (!root) return;
  const items = state.items;
  const total = items.length;
  const th = state.config.shortWordThreshold;
  const noAnswer = items.filter((i) => isNoAnswer(i.answer)).length;
  const brief = items.filter((i) => !isNoAnswer(i.answer) && wordCount(i.answer) < th).length;
  const groups = openGroups();

  // Counts
  const byCat = count(items, (i) => [i.topic]);
  const byAsker = count(items, (i) => [i.askedBy]);
  const byRep = count(items, (i) => repNames(i.answeredBy).filter((r) => r.toLowerCase() !== 'unassigned'));
  const cats = [...byCat].sort((a, b) => b[1] - a[1]);
  const askers = [...byAsker].sort((a, b) => b[1] - a[1]);
  const reps = [...byRep].sort((a, b) => b[1] - a[1]);
  const topAsker = askers[0];
  const topRep = reps[0];

  // Heatmap
  const heatAskers = askers.slice(0, 12).map(([a]) => a);
  const heatCats = cats.map(([c]) => c);
  const cell = new Map();
  items.forEach((i) => { const k = `${i.askedBy}\u0000${i.topic}`; cell.set(k, (cell.get(k) || 0) + 1); });
  const max = Math.max(1, ...cell.values());
  const level = (v) => (v === 0 ? 0 : Math.min(4, Math.ceil((v / max) * 4)));

  // Themes asked about by more than one conversation come first
  const themes = [...getIndex().groups()]
    .sort((a, b) => b.askers.length - a.askers.length || b.ids.length - a.ids.length || b.score - a.score)
    .slice(0, 10);
  const openKeys = new Set(groups.map((g) => g.key));

  root.innerHTML = `
    <div class="page">
      <header class="page-head">
        <div>
          <h1 class="page-title">Insights</h1>
          <p class="page-sub">What prospects ask about, who answers, and where the library needs work. Select any number to open those questions.</p>
        </div>
      </header>

      ${total ? `
      <div class="kpis">
        <a class="kpi" href="#/library" style="text-decoration:none;color:inherit">
          <span class="kpi-label">Questions</span><span class="kpi-value">${total}</span><span class="kpi-sub">${pluralize(cats.length, 'category', 'categories')}</span></a>
        <div class="kpi"><span class="kpi-label">Prospects</span><span class="kpi-value">${askers.length}</span>
          <span class="kpi-sub">${topAsker ? `${esc(topAsker[0])} asked ${topAsker[1]}` : ''}</span></div>
        <a class="kpi" href="${lib({ attention: '1' })}" style="text-decoration:none;color:inherit">
          <span class="kpi-label">Need attention</span><span class="kpi-value warn">${brief + noAnswer}</span>
          <span class="kpi-sub">${brief} under ${th} words${noAnswer ? `, ${noAnswer} unanswered` : ''}</span></a>
        <a class="kpi" href="#/review" style="text-decoration:none;color:inherit">
          <span class="kpi-label">Likely duplicates</span><span class="kpi-value">${groups.length}</span><span class="kpi-sub">${groups.length ? 'Review now' : 'All reviewed'}</span></a>
      </div>

      <div class="grid-2">
        <section class="card">
          <div class="card-head"><h2 class="card-title">Questions by category</h2></div>
          <div class="bars">${cats.map(([c, n]) => bar(c, n, cats[0][1], lib({ cat: c }))).join('')}</div>
        </section>
        <section class="card">
          <div class="card-head"><h2 class="card-title">Who answers</h2></div>
          <div class="bars">${reps.slice(0, 8).map(([r, n]) => bar(r, n, reps[0][1], lib({ rep: r }), 'ink')).join('')}</div>
          ${topRep ? `<p class="field-hint" style="margin-top:10px">Shared answers count for each rep. ${esc(topRep[0])} answered ${Math.round((topRep[1] / total) * 100)}% of the library.</p>` : ''}
        </section>
      </div>

      <section class="card">
        <div class="card-head"><h2 class="card-title">Interest map: prospect × category</h2><span class="field-hint">Darker means more questions. Useful prep before the next call.</span></div>
        <div class="heat-wrap"><table class="heat">
          <thead><tr><th scope="col" style="text-align:left">Prospect</th>${heatCats.map((c) => `<th scope="col">${esc(c)}</th>`).join('')}</tr></thead>
          <tbody>${heatAskers.map((a) => `<tr><th scope="row">${esc(a)}</th>${heatCats.map((c) => {
            const v = cell.get(`${a}\u0000${c}`) || 0;
            return `<td>${v
              ? `<a class="heat-cell heat-${level(v)}" style="display:grid;place-items:center;text-decoration:none" href="${lib({ cat: c, asker: a })}" aria-label="${v} from ${esc(a)} about ${esc(c)}">${v}</a>`
              : `<span class="heat-cell heat-0" style="display:grid;place-items:center" aria-label="None">–</span>`}</td>`;
          }).join('')}</tr>`).join('')}</tbody>
        </table></div>
        ${askers.length > 12 ? `<p class="field-hint">Showing the 12 most active of ${askers.length} prospects.</p>` : ''}
      </section>

      <section class="card">
        <div class="card-head"><h2 class="card-title">Recurring themes</h2><span class="field-hint">Groups of similar questions, most widely asked first</span></div>
        ${themes.length ? `<div class="table-wrap"><table class="table">
          <thead><tr><th>Questions</th><th>Theme</th><th>Asked by</th><th>Category</th><th><span class="visually-hidden">Action</span></th></tr></thead>
          <tbody>${themes.map((g) => `<tr>
            <td class="mono">${g.ids.length}</td>
            <td>${esc(g.title)}</td>
            <td>${g.askers.map(esc).join(', ')}</td>
            <td>${g.topics.map(esc).join(', ')}</td>
            <td>${openKeys.has(g.key) ? `<a href="#/review?key=${g.key}">Review</a>` : `<a href="#/review?tab=pick&ids=${g.ids.slice(0, 3).join(',')}">Compare</a>`}</td>
          </tr>`).join('')}</tbody></table></div>`
          : `<p class="muted">No recurring themes at the current ${state.config.matchThreshold}% threshold. <a href="#/rules">Adjust matching rules</a></p>`}
      </section>

      <section class="card">
        <div class="card-head"><h2 class="card-title">Data health</h2></div>
        <div class="health-grid">${healthCards()}</div>
      </section>`
      : `<div class="card empty"><strong>No data yet</strong><span>Add or import questions to see insights.</span><a href="#/library">Go to Library</a></div>`}
    </div>`;
}

function count(items, keysOf) {
  const m = new Map();
  items.forEach((i) => keysOf(i).forEach((k) => k && m.set(k, (m.get(k) || 0) + 1)));
  return m;
}

const bar = (label, n, max, href, tone = '') => `
  <a class="bar-row" href="${href}">
    <span>${esc(label)}</span>
    <span class="bar-track"><span class="bar-fill ${tone}" style="width:${Math.max(3, Math.round((n / max) * 100))}%"></span></span>
    <span class="mono">${n}</span>
  </a>`;

function healthCards() {
  const cards = [];
  const items = state.items;

  const repVariants = items.filter((i) => canonicalRep(i.answeredBy) !== i.answeredBy.trim());
  if (repVariants.length) {
    const examples = [...new Set(repVariants.map((i) => i.answeredBy))].slice(0, 2).map((x) => `“${esc(x)}”`).join(' and ');
    cards.push(`<div class="health-card"><strong>Rep names written different ways</strong>
      <p>${examples} are counted as different reps. Rewriting them in one consistent order fixes filters and counts.</p>
      <button type="button" class="btn btn-sm" data-act="fix-reps">Fix ${pluralize(repVariants.length, 'record')}</button></div>`);
  }

  // Someone who answers more questions than they ask is a rep; if they're listed as the asker, the fields may be swapped.
  const answered = count(items, (i) => repNames(i.answeredBy).map((r) => r.toLowerCase()));
  const asked = count(items, (i) => [splitAsker(i.askedBy).person.toLowerCase()]);
  const repAsked = items.filter((i) => {
    const p = splitAsker(i.askedBy).person.toLowerCase();
    return (answered.get(p) || 0) > (asked.get(p) || 0);
  });
  if (repAsked.length) {
    cards.push(`<div class="health-card"><strong>${repAsked.length === 1 ? 'A question was' : `${repAsked.length} questions were`} asked by a rep</strong>
      <p>${repAsked.slice(0, 4).map((i) => `<a href="#/library/${i.id}">#${i.id}</a>`).join(', ')} list${repAsked.length === 1 ? 's' : ''} a rep as the asker. The fields may be swapped.</p></div>`);
  }

  const noAns = items.filter((i) => isNoAnswer(i.answer));
  if (noAns.length) {
    cards.push(`<div class="health-card"><strong>${pluralize(noAns.length, 'question')} without an answer</strong>
      <p>Add answers so the library can be used on calls.</p><a href="${lib({ attention: '1' })}">Show them</a></div>`);
  }

  const mixed = items.filter((i) => !/\(.+\)/.test(i.askedBy)).length;
  if (mixed && mixed < items.length) {
    cards.push(`<div class="health-card"><strong>${pluralize(mixed, 'question')} without a company</strong>
      <p>These list only a person as the asker. Writing it as “Name (Company)” lets you see questions by account.</p></div>`);
  }

  if (!cards.length) cards.push('<div class="health-card ok"><strong>Looks good</strong><p>No naming or answer problems found.</p></div>');
  return cards.join('');
}

async function onClick(e) {
  const b = e.target.closest('[data-act="fix-reps"]');
  if (!b) return;
  const ok = await confirmDialog({
    title: 'Fix rep names?',
    message: 'Rep lists will be rewritten in alphabetical order, for example “Casey and Caroline” becomes “Caroline and Casey”.',
    confirmLabel: 'Fix names',
  });
  if (ok && await normalizeRepNames()) toast('Rep names fixed');
}
