// Reps: who answers what, how thoroughly, and where answers disagree.

import { state, getItem } from './store.js';
import {
  PERIODS, inPeriod, isQuestion, isBrief, repsOf, accountOf, effectiveThemes, conflictPairs, verdictLabel,
} from './model.js';
import { esc, pluralize } from './utils.js';

const ui = { period: 'all' };
let root = null;

export function mount(el, params) {
  root = el;
  if (params.period && PERIODS[params.period]) ui.period = params.period;
  el.onclick = (e) => {
    const b = e.target.closest('[data-period]');
    if (b) { ui.period = b.dataset.period; update(); }
  };
  update();
}

export function update() {
  if (!root) return;
  const p = ui.period;
  const items = state.items.filter((i) => isQuestion(i) && inPeriod(i, p));
  const total = items.length;
  const stats = new Map();
  for (const i of items) {
    for (const r of repsOf(i)) {
      const s = stats.get(r) || { name: r, n: 0, brief: 0, cats: new Set(), followups: 0, conflicts: 0 };
      s.n++; if (isBrief(i)) s.brief++; s.cats.add(i.topic);
      if (i.followUp && !i.followUp.done) s.followups++;
      stats.set(r, s);
    }
  }

  // Near-identical questions with opposite answers
  const conflicts = [];
  const seen = new Set();
  for (const t of effectiveThemes()) {
    const its = t.ids.map(getItem).filter((i) => i && inPeriod(i, p));
    for (const c of conflictPairs(its)) {
      const k = [c.no.id, c.yes.id].sort().join('-');
      if (seen.has(k)) continue;
      seen.add(k);
      conflicts.push({ t, ...c });
      for (const i of [c.no, c.yes]) repsOf(i).forEach((r) => { const s2 = stats.get(r); if (s2) s2.conflicts++; });
    }
  }
  const reps = [...stats.values()].sort((a, b) => b.n - a.n);
  const cards = coaching(reps, items);

  root.innerHTML = `
    <div class="page">
      <header class="page-head">
        <div>
          <h1 class="page-title">Reps</h1>
          <p class="page-sub">Who answers what, how thoroughly, and where answers disagree.</p>
        </div>
        <div class="tabs" role="tablist" aria-label="Time period">
          ${Object.entries(PERIODS).map(([id, v]) => `<button type="button" class="tab" role="tab" data-period="${id}" aria-selected="${p === id}">${v.label}</button>`).join('')}
        </div>
      </header>

      ${reps.length ? `
      <section class="card">
        <div class="card-head"><h2 class="card-title">Answer summary</h2><span class="field-hint">Shared answers count for each rep. Brief means under ${state.config.shortWordThreshold} words.</span></div>
        <div class="table-wrap"><table class="table">
          <thead><tr><th>Rep</th><th class="num">Answers</th><th style="width:22%">Share of answers</th><th class="num">Categories</th><th style="width:22%">Brief answers</th><th>Flags</th></tr></thead>
          <tbody>${reps.map((s) => {
            const share = Math.round((s.n / total) * 100);
            const bp = Math.round((s.brief / s.n) * 100);
            const flags = [s.conflicts && `${pluralize(s.conflicts, 'answer')} that ${s.conflicts === 1 ? 'differs' : 'differ'} from a colleague`, s.followups && `${pluralize(s.followups, 'open follow-up')}`].filter(Boolean);
            return `<tr>
              <td><a href="#/library?rep=${encodeURIComponent(s.name)}"><strong>${esc(s.name)}</strong></a></td>
              <td class="num mono">${s.n}</td>
              <td><span class="inline-bar"><span class="bar-track"><span class="bar-fill ink" style="width:${share}%"></span></span><span class="mono">${share}%</span></span></td>
              <td class="num mono">${s.cats.size}</td>
              <td><span class="inline-bar"><span class="bar-track"><span class="bar-fill warn" style="width:${bp}%"></span></span><span class="mono">${s.brief} · ${bp}%</span></span></td>
              <td class="${flags.length ? 'warn-text' : 'muted'}">${flags.length ? esc(flags.join('; ')) : '–'}</td>
            </tr>`;
          }).join('')}</tbody>
        </table></div>
      </section>` : `<div class="card empty"><strong>No answers in this period</strong><span>Try All time.</span></div>`}

      ${conflicts.length ? `
      <section class="card card-warn">
        <div class="card-head"><h2 class="card-title">Where answers point different ways</h2><span class="field-hint">Nearly the same question, one answer marked No and the other Yes or Partial</span></div>
        ${conflicts.map(({ t, no, yes, score }) => `
          <div class="conflict">
            <p class="muted">${esc(t.name)} · ${[...new Set([no, yes].map(accountOf))].map(esc).join(', ')} · ${score}% match</p>
            <div class="cmp-grid" style="--cols:2">
              ${[no, yes].map((i) => `<div class="quote"><span class="muted">#${i.id} · ${esc(i.answeredBy)} · ${verdictLabel(i.verdict)}</span>
                <p><strong>${esc(i.question)}</strong></p><p>${esc(i.answer)}</p></div>`).join('')}
            </div>
            <div class="actions-bar"><a class="btn btn-primary" href="#/review?tab=pick&ids=${no.id},${yes.id}">Settle in Review</a></div>
          </div>`).join('')}
      </section>` : ''}

      ${cards.length ? `<div class="coach-grid">${cards.join('')}</div>` : ''}
    </div>`;
}

/** Coaching observations generated from the data. */
function coaching(reps, items) {
  const out = [];
  const busiest = reps[0];
  if (busiest && busiest.n >= 5 && busiest.brief / busiest.n >= 0.3) {
    const ex = items.filter((i) => repsOf(i).includes(busiest.name) && isBrief(i)).sort((a, b) => a.answer.length - b.answer.length)[0];
    out.push(card(`${Math.round((busiest.brief / busiest.n) * 100)}% of ${busiest.name}’s answers are brief`,
      `${busiest.name} answers the most questions (${busiest.n}), and ${busiest.brief} are under ${state.config.shortWordThreshold} words${ex ? `, such as #${ex.id}: “${ex.answer}”` : ''}. Approved answers for ${busiest.name}’s most common themes would raise quality without adding work.`,
      `#/library?rep=${encodeURIComponent(busiest.name)}&attention=1`, `See ${busiest.name}’s brief answers`));
  }
  const byCat = new Map();
  for (const i of items) for (const r of repsOf(i)) {
    const m = byCat.get(i.topic) || byCat.set(i.topic, new Map()).get(i.topic);
    m.set(r, (m.get(r) || 0) + 1);
  }
  const conc = [...byCat].map(([cat, m]) => {
    const totalCat = items.filter((i) => i.topic === cat).length;
    const [top, n] = [...m.entries()].sort((a, b) => b[1] - a[1])[0];
    return { cat, top, n, totalCat, share: n / totalCat };
  }).filter((x) => x.totalCat >= 4 && x.share >= 0.6 && x.n >= 3 && x.top !== busiest?.name).sort((a, b) => b.share - a.share || b.n - a.n);
  for (const { cat, top, n, totalCat } of conc) {
    {
      out.push(card(`${cat} rests mostly on ${top}`,
        `${top} answered ${n} of the ${totalCat} ${cat} questions. Approved answers in this area would let others respond consistently.`,
        `#/library?cat=${encodeURIComponent(cat)}`, `See ${cat} questions`));
      break;
    }
  }
  const model = reps.filter((r) => r.n >= 5).sort((a, b) => a.brief / a.n - b.brief / b.n)[0];
  if (model && model !== busiest && model.brief / model.n <= 0.1) {
    out.push(card(`${model.name}’s answers make good templates`,
      `${model.brief ? `Only ${model.brief}` : 'None'} of ${model.name}’s ${model.n} answers ${model.brief === 1 ? 'is' : 'are'} brief, across ${pluralize(model.cats.size, 'category', 'categories')}. They’re strong candidates when choosing approved answers.`,
      `#/library?rep=${encodeURIComponent(model.name)}`, `See ${model.name}’s answers`));
  }
  return out;
}

const card = (title, text, href, link) => `<section class="card coach"><h2 class="card-title">${esc(title)}</h2><p>${esc(text)}</p><a href="${href}">${esc(link)}</a></section>`;
