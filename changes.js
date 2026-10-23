// "What changed" widgets, shared by the Overview and the printable meeting summary.

import { whatChanged, PERIODS, MIN_MOVE, verdictLabel, themeById, themeHex } from './model.js';
import { esc, fmtDate, pluralize } from './utils.js';

const expanded = new Set();
/** Toggle a widget between its top items and the full list. Returns true if handled. */
export function toggleWidget(key) {
  if (expanded.has(key)) expanded.delete(key); else expanded.add(key);
  return true;
}

const ids = (list) => `#/library?ids=${list.join(',')}`;
const dot = (t) => (t?.confirmed && themeById(t.id)
  ? `<span class="theme-dot" style="--tc:${themeHex(themeById(t.id))}" aria-hidden="true"></span>`
  : '<span class="theme-dot suggested" aria-hidden="true"></span>');

export function changesHTML(p, { print = false } = {}) {
  const w = whatChanged(p);
  if (!w) return '';
  const h = w.headline;
  const label = PERIODS[p].short;
  const noEarlier = h.prevQuestions === 0;
  const link = (href, text) => (print ? text : `<a href="${href}">${text}</a>`);

  /** One widget: title, count, rows (top N unless expanded), and an empty message. */
  const widget = (key, title, hint, rows, emptyText, { wide = false } = {}) => {
    const limit = print ? 5 : expanded.has(key) ? Infinity : 5;
    const shown = rows.slice(0, limit);
    const more = rows.length - shown.length;
    return `<section class="card wc-card${wide ? ' wc-wide' : ''}" aria-label="${esc(title)}">
      <header class="wc-head"><h3>${title}</h3>${rows.length ? `<span class="wc-count">${rows.length}</span>` : ''}</header>
      ${hint ? `<p class="wc-hint">${hint}</p>` : ''}
      ${rows.length ? `<ul class="wc-rows">${shown.join('')}</ul>` : `<p class="wc-empty">${emptyText}</p>`}
      ${more > 0 ? (print ? `<p class="wc-more">${more} more</p>` : `<button type="button" class="link-btn wc-more" data-wc-more="${key}">Show all ${rows.length}</button>`)
        : !print && expanded.has(key) && rows.length > 5 ? `<button type="button" class="link-btn wc-more" data-wc-more="${key}">Show top 5</button>` : ''}
    </section>`;
  };

  /** Uniform row: marker, title line, meta line underneath, optional value on the right. */
  const row = (marker, title, meta, value = '') => `<li class="wc-row">${marker}
    <span class="wc-text"><span class="wc-title">${title}</span>${meta ? `<span class="wc-meta">${meta}</span>` : ''}</span>
    ${value ? `<span class="wc-value">${value}</span>` : ''}</li>`;

  const moveRow = (x, up) => row(dot(x.t), link(ids(x.items.map((i) => i.id)), esc(x.t.name)),
    `${x.prevAccts.length} → ${x.curAccts.length} accounts`,
    `<span class="wc-delta ${up ? 'up' : 'down'}">${x.delta > 0 ? '+' : ''}${x.delta}</span>`);

  const noCompare = `Nothing to compare with yet: no questions are dated in the previous ${label}.`;
  const rising = widget('rising', 'Rising', 'Themes asked by more accounts than before', noEarlier ? [] : w.rising.map((x) => moveRow(x, true)),
    noEarlier ? noCompare : `No theme gained ${MIN_MOVE}+ accounts.`);
  const falling = widget('falling', 'Falling', 'Themes asked by fewer accounts than before', noEarlier ? [] : w.falling.map((x) => moveRow(x, false)),
    noEarlier ? noCompare : `No theme lost ${MIN_MOVE}+ accounts.`);
  const fresh = widget('new', 'New themes', 'First asked about this period', w.newThemes.map((x) =>
    row(dot(x.t), link(ids(x.items.map((i) => i.id)), esc(x.t.name)), x.curAccts.map(esc).join(', '),
      `<span class="wc-num">${x.cur.length}</span>`)), 'No new themes this period.');
  const order = ['roadmap', 'no', 'partial'];
  const gaps = widget('gaps', 'New gaps and promises', 'No, Partial and Roadmap verdicts set this period', w.gaps.map((g) => {
    const v = order.find((x) => g.verdicts.has(x));
    return row(`<span class="vbadge v-${v}">${verdictLabel(v)}</span>`, link(ids(g.ids), esc(g.name)),
      `${[...g.accounts].map(esc).join(', ')}${g.firstTime ? ' · <span class="wc-first">first time</span>' : ''}`);
  }), 'No new No, Partial or Roadmap verdicts.');
  const accounts = widget('accounts', 'Accounts with open items', 'Open follow-ups and roadmap promises, right now', w.openAccounts.map((a) =>
    row('<span class="wc-marker" aria-hidden="true"></span>', link(ids(a.ids), `<strong>${esc(a.name)}</strong>`),
      [a.followUps && pluralize(a.followUps, 'open follow-up') + (a.overdue ? ` (${a.overdue} overdue)` : ''), a.promises && pluralize(a.promises, 'roadmap promise')].filter(Boolean).join(' · '),
      `<span class="wc-num ${a.overdue ? 'warn-text' : ''}">${a.followUps + a.promises}</span>`)), 'No account has 2 or more open items.');
  const stages = !w.stages
    ? `<section class="card wc-card" aria-label="Themes by deal stage"><header class="wc-head"><h3>Themes by deal stage</h3></header>
        <p class="wc-empty">${print ? 'No Salesforce stages imported.' : 'Import a Salesforce report (Accounts, below) to see which themes come up at each deal stage.'}</p></section>`
    : `<section class="card wc-card wc-wide" aria-label="Themes by deal stage"><header class="wc-head"><h3>Themes by deal stage</h3></header>
        <p class="wc-hint">Accounts asking about each theme this period, by their current Salesforce stage</p>
        ${w.stages.rows.length ? `<div class="table-wrap"><table class="table wc-stage"><thead><tr><th>Theme</th>${w.stages.cols.map((c) => `<th class="num">${esc(c)}</th>`).join('')}</tr></thead>
          <tbody>${w.stages.rows.slice(0, print ? 6 : 8).map((r) => `<tr><td>${dot(r.t)} ${esc(r.t.name)}</td>${w.stages.cols.map((c) => `<td class="num mono">${r.cells[c] || '<span class="muted">–</span>'}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
          : '<p class="wc-empty">No themed questions this period.</p>'}</section>`;

  const delta = h.questions - h.prevQuestions;
  return `
    <div class="wc">
      <div class="wc-strip">
        <span><strong>${fmtDate(w.range.start, { year: false })} – ${fmtDate(w.range.end)}</strong></span>
        <span><strong class="mono">${h.questions}</strong> questions</span>
        <span><strong class="mono">${h.accounts}</strong> accounts</span>
        <span class="muted">${noEarlier ? `No dated questions in the previous ${label}` : `Previous ${label}: ${h.prevQuestions} from ${h.prevAccounts} (${delta >= 0 ? '+' : ''}${delta})`}</span>
        ${h.undated ? `<span class="muted">${pluralize(h.undated, 'undated question')} not included</span>` : ''}
      </div>
      <div class="wc-grid">${noEarlier
        ? `<section class="card wc-card" aria-label="Rising and falling"><header class="wc-head"><h3>Rising and falling</h3></header><p class="wc-empty">${noCompare} Trends appear once questions are dated in both periods.</p></section>`
        : rising + falling}${fresh}${gaps}${accounts}${stages}</div>
      <p class="wc-rule">A theme counts as rising or falling only when at least ${MIN_MOVE} accounts moved, so one busy prospect can’t make a trend.</p>
    </div>`;
}
