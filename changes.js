// "What changed" panel, shared by the Overview and the printable meeting summary.

import { whatChanged, PERIODS, MIN_MOVE, verdictLabel, themeById, themeHex } from './model.js';
import { esc, fmtDate, pluralize } from './utils.js';

const ids = (list) => `#/library?ids=${list.join(',')}`;
const dot = (t) => (t?.confirmed && themeById(t.id) ? `<span class="theme-dot" style="--tc:${themeHex(themeById(t.id))}" aria-hidden="true"></span>` : '<span class="theme-dot suggested" aria-hidden="true"></span>');
const sign = (n) => (n > 0 ? `+${n}` : `${n}`);

export function changesHTML(p, { print = false } = {}) {
  const w = whatChanged(p);
  const N = print ? 5 : 8; // a printed page has room for the top 5 of each list
  if (!w) return '';
  const h = w.headline;
  const label = PERIODS[p].short;
  const link = (href, text) => (print ? text : `<a href="${href}">${text}</a>`);
  const empty = (text) => `<p class="muted wc-empty">${text}</p>`;
  const section = (title, body, hint = '') => `<section class="wc-sec"><h3>${title}${hint ? ` <span class="muted">${hint}</span>` : ''}</h3>${body}</section>`;

  const themeLine = (x, extra) => `<li>${dot(x.t)}<span class="wc-main">${link(ids(x.items.map((i) => i.id)), esc(x.t.name))}</span><span class="wc-side">${extra}</span></li>`;

  const rising = w.rising.length
    ? `<ul class="wc-list">${w.rising.map((x) => themeLine(x, `<span class="up mono">${sign(x.delta)} accounts</span> <span class="muted">(${x.prevAccts.length} → ${x.curAccts.length})</span>`)).join('')}</ul>`
    : empty(`No theme gained ${MIN_MOVE}+ accounts compared with the previous ${label}.`);
  const falling = w.falling.length
    ? `<ul class="wc-list">${w.falling.map((x) => themeLine(x, `<span class="down mono">${sign(x.delta)} accounts</span> <span class="muted">(${x.prevAccts.length} → ${x.curAccts.length})</span>`)).join('')}</ul>`
    : empty(`No theme lost ${MIN_MOVE}+ accounts.`);
  const fresh = w.newThemes.length
    ? `<ul class="wc-list">${w.newThemes.slice(0, N).map((x) => themeLine(x, `<span class="muted">${pluralize(x.cur.length, 'question')} · ${x.curAccts.map(esc).join(', ')}</span>`)).join('')}</ul>${w.newThemes.length > N ? `<p class="field-hint">${w.newThemes.length - N} more.</p>` : ''}`
    : empty('No new themes this period.');
  const order = ['roadmap', 'no', 'partial'];
  const gaps = w.gaps.length
    ? `<ul class="wc-list">${w.gaps.slice(0, N).map((g) => {
        const v = order.find((x) => g.verdicts.has(x));
        return `<li><span class="vbadge v-${v}">${verdictLabel(v)}</span><span class="wc-main">${link(ids(g.ids), esc(g.name))}${g.firstTime ? ' <span class="badge badge-accent">first time</span>' : ''}</span><span class="wc-side muted">${[...g.accounts].map(esc).join(', ')}</span></li>`;
      }).join('')}</ul>${w.gaps.length > N ? `<p class="field-hint">${w.gaps.length - N} more.</p>` : ''}`
    : empty('No new No, Partial or Roadmap verdicts this period.');
  const accounts = w.openAccounts.length
    ? `<ul class="wc-list">${w.openAccounts.slice(0, print ? 4 : 6).map((a) => `<li><span class="wc-main">${link(ids(a.ids), `<strong>${esc(a.name)}</strong>`)}</span><span class="wc-side ${a.overdue ? 'warn-text' : 'muted'}">${[a.followUps && pluralize(a.followUps, 'open follow-up') + (a.overdue ? ` (${a.overdue} overdue)` : ''), a.promises && pluralize(a.promises, 'roadmap promise')].filter(Boolean).join(', ')}</span></li>`).join('')}</ul>`
    : empty('No account has 2 or more open items.');
  const stages = !w.stages
    ? empty(print ? 'No Salesforce stages imported.' : 'Import a Salesforce report (Overview › Accounts) to see themes by deal stage.')
    : w.stages.rows.length
      ? `<div class="table-wrap"><table class="table wc-stage"><thead><tr><th>Theme</th>${w.stages.cols.map((c) => `<th class="num">${esc(c)}</th>`).join('')}</tr></thead>
         <tbody>${w.stages.rows.slice(0, print ? 6 : 8).map((r) => `<tr><td>${dot(r.t)} ${esc(r.t.name)}</td>${w.stages.cols.map((c) => `<td class="num mono">${r.cells[c] || '<span class="muted">–</span>'}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
         <p class="field-hint">Number of accounts asking about each theme, by their current deal stage.</p>`
      : empty('No themed questions this period.');

  const delta = h.questions - h.prevQuestions;
  return `
    <div class="wc">
      <p class="wc-headline"><strong>${fmtDate(w.range.start, { year: false })} – ${fmtDate(w.range.end)}:</strong>
        ${pluralize(h.questions, 'question')} from ${pluralize(h.accounts, 'account')}
        <span class="muted">(previous ${label}: ${h.prevQuestions} from ${h.prevAccounts}; ${delta >= 0 ? '+' : ''}${delta} questions).</span>
        ${h.undated ? `<span class="muted">${pluralize(h.undated, 'question')} without a date ${h.undated === 1 ? 'isn’t' : 'aren’t'} included.</span>` : ''}</p>
      <div class="wc-grid">
        ${section('Rising', rising, 'by accounts')}
        ${section('Falling', falling, 'by accounts')}
        ${section('New themes', fresh)}
        ${section('New gaps and promises', gaps)}
        ${section('Accounts with open items', accounts, 'right now')}
        ${section('Themes by deal stage', stages, 'this period')}
      </div>
      <p class="field-hint wc-rule">A theme counts as rising or falling only when at least ${MIN_MOVE} accounts moved, so one busy prospect can’t make a trend.</p>
    </div>`;
}
