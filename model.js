// Derived views of the data used by Overview, Reps, Calls and Complete records.

import { state, getIndex, companyOf, contactOf } from './store.js';
import { repNames, wordCount, isNoAnswer } from './utils.js';

export const VERDICTS = [
  { id: 'yes', label: 'Yes', color: '#2F8A45' },
  { id: 'partial', label: 'Partial', color: '#8FA6EA' },
  { id: 'no', label: 'No', color: '#C2650F' },
  { id: 'roadmap', label: 'Roadmap', color: '#16171A' },
  { id: 'followup', label: 'Follow-up', color: '#B8860B' },
  { id: 'na', label: 'Not yes/no', color: '#B9B8B2' },
];
export const verdictLabel = (v) => VERDICTS.find((x) => x.id === v)?.label || '';

const FOLLOW_RE = /\b(will (confirm|follow up|check|get back|send|share)|follow[- ]up (meeting|call|overview|demo)|recommended for a follow[- ]up|to be confirmed|\bTBD\b|get back to)/i;

// "Does it have to…", "Is it difficult…", "Can it only…": a "No" to these is good news.
const NEGATIVE_FRAME = /\b(require[sd]?|have to|has to|need to|needs to|must|difficult|hard to|only|limited to|restricted to|mandatory)\b/i;

/** Suggest a verdict from how the answer reads (and how the question was framed). Returns null when unclear. */
export function suggestVerdict(answer, question = '') {
  const a = String(answer || '').trim();
  if (!a || isNoAnswer(a)) return null;
  if (/\b(roadmap|tentatively planned|planned for|expected (in|by)|coming soon|future release)\b/i.test(a)) return 'roadmap';
  if (FOLLOW_RE.test(a)) return 'followup';
  if (/^yes\b/i.test(a)) return 'yes';
  if (/^no\b/i.test(a)) return NEGATIVE_FRAME.test(question) ? 'yes' : 'no';
  if (/^(potentially|possibly|partially|partly|it depends|depends|in some cases|sometimes|not directly|not natively|not currently|not yet)\b/i.test(a)) return 'partial';
  return null;
}
export const detectFollowUp = (answer) => FOLLOW_RE.test(String(answer || ''));

export const PERIODS = {
  m: { label: 'Last 30 days', short: '30 days', days: 30 },
  q: { label: 'Last 90 days', short: '90 days', days: 90 },
  all: { label: 'All time', short: 'all time', days: null },
};

const DAY = 864e5;
export function inPeriod(item, p, offset = 0) {
  const days = PERIODS[p].days;
  if (!days) return true;
  if (!item.askedAt) return false;
  const t = Date.parse(`${item.askedAt}T12:00:00`);
  const end = Date.now() - offset * days * DAY;
  return t > end - days * DAY && t <= end;
}

/** Accounts are counted by company; questions with no company count under their contact. */
export const accountOf = (i) => companyOf(i) || contactOf(i) || 'Unknown';
export const isQuestion = (i) => i.kind !== 'feedback';
export const isBrief = (i) => !isNoAnswer(i.answer) && wordCount(i.answer) < state.config.shortWordThreshold;
export const repsOf = (i) => repNames(i.answeredBy).filter((r) => r.toLowerCase() !== 'unassigned');

let memo = { key: null, value: null };
/**
 * Themes as management sees them: confirmed themes, plus suggested groups of questions
 * that aren't in a confirmed theme yet (marked confirmed: false).
 */
export function effectiveThemes() {
  const idx = getIndex();
  if (memo.key && memo.key[0] === state.items && memo.key[1] === state.config && memo.key[2] === idx) return memo.value;
  const byTheme = new Map();
  for (const i of state.items) {
    if (i.themeId && isQuestion(i)) (byTheme.get(i.themeId) || byTheme.set(i.themeId, []).get(i.themeId)).push(i.id);
  }
  const confirmed = state.config.themes
    .map((t) => ({ id: t.id, name: t.name, ids: byTheme.get(t.id) || [], confirmed: true }))
    .filter((t) => t.ids.length);
  const themed = new Set(confirmed.flatMap((t) => t.ids));
  const dismissed = new Set(state.config.review.resolved.filter((r) => r.action === 'dismissed').map((r) => r.key));
  const suggested = idx.groups()
    .filter((g) => !dismissed.has(g.key))
    .map((g) => ({ id: `s:${g.key}`, key: g.key, name: g.title, ids: g.ids.filter((id) => !themed.has(id)), confirmed: false }))
    .filter((g) => g.ids.length >= 2);
  const value = [...confirmed, ...suggested];
  memo = { key: [state.items, state.config, idx], value };
  return value;
}

export function themeIndex() {
  const m = new Map();
  for (const t of effectiveThemes()) for (const id of t.ids) m.set(id, t);
  return m;
}

/**
 * Verdict mix of a set of items: { yes: 2, no: 1, unset: 3 }. Only verdicts a person has set count.
 * Suggestions are never used for analysis: "No. The QR code is optional." answers a
 * "does it have to…" question, so its first word alone would wrongly read as a gap.
 */
export function verdictMix(items) {
  const mix = {};
  for (const i of items) {
    const v = i.verdict || 'unset';
    mix[v] = (mix[v] || 0) + 1;
  }
  return mix;
}

/**
 * Answers that point different ways: two near-identical questions (well above the theme threshold)
 * where one answer is marked No and the other Yes or Partial. Different questions in one theme
 * can legitimately have different answers, so a theme alone isn't enough.
 */
export function conflictPairs(items) {
  const idx = getIndex();
  const near = idx.sameThreshold; // "the same question", not just the same topic
  const out = [];
  for (const a of items) {
    if (a.verdict !== 'no') continue;
    for (const b of items) {
      if (b === a || !['yes', 'partial'].includes(b.verdict)) continue;
      const s = idx.compare(a.id, b.id).score;
      if (s >= near) out.push({ no: a, yes: b, score: s });
    }
  }
  return out.sort((x, y) => y.score - x.score);
}

/** Month buckets (oldest first) of distinct accounts asking, for sparklines. */
export function monthlyAccounts(items, months = 6) {
  const nowD = new Date();
  const buckets = Array.from({ length: months }, (_, n) => {
    const d = new Date(nowD.getFullYear(), nowD.getMonth() - (months - 1 - n), 1);
    return { key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, set: new Set() };
  });
  for (const i of items) {
    if (!i.askedAt) continue;
    const b = buckets.find((x) => x.key === i.askedAt.slice(0, 7));
    if (b) b.set.add(accountOf(i));
  }
  return buckets.map((b) => b.set.size);
}

/** A question counts as a repeat if its theme had an earlier question (by date, else by number). */
export function isRepeat(item, themeOf) {
  const t = themeOf.get(item.id);
  if (!t) return false;
  const when = (i) => (i.askedAt ? Date.parse(i.askedAt) : 0) * 1e5 + i.id;
  return t.ids.some((id) => {
    if (id === item.id) return false;
    const o = state.items.find((x) => x.id === id);
    return o && when(o) < when(item);
  });
}

/**
 * Shade for a theme by question count: 0 = fewest, 1 = most. Returned as inline CSS
 * (`--t`) plus a class for dark chip text; colors are computed in app.css so dark mode works.
 */
export function shadeAttrs(n, min, max) {
  const t = max === min ? 1 : (n - min) / (max - min);
  return { style: `--t:${t.toFixed(3)}`, cls: t > 0.45 ? 'shade-strong' : '' };
}

// ---------- Theme colors ----------
// 16 distinct colors. Pure red is left out: red means "needs attention" elsewhere in the app.
export const PALETTE = [
  ['Blue', '#2F6FDE'], ['Sky', '#1C9BD6'], ['Teal', '#0F9488'], ['Green', '#2E9E4F'],
  ['Lime', '#7CA318'], ['Olive', '#857F22'], ['Amber', '#D99A06'], ['Orange', '#E0701B'],
  ['Coral', '#E46A5A'], ['Rose', '#D9466F'], ['Magenta', '#B9459E'], ['Plum', '#8E3E6E'],
  ['Purple', '#7C4DD8'], ['Indigo', '#4A55C9'], ['Brown', '#9A6B3F'], ['Slate', '#5B6B7F'],
];
const hexOf = (name) => PALETTE.find((p) => p[0] === name)?.[1];

function hashIndex(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % PALETTE.length;
}

/** A theme's color name: the one chosen, or a stable default for older themes without one. */
export const themeColorName = (t) => (t && hexOf(t.color) ? t.color : PALETTE[hashIndex(t?.id || '')][0]);
export const themeHex = (t) => hexOf(themeColorName(t));
export const themeById = (id) => state.config.themes.find((t) => t.id === id);

/** The first palette color no theme is using yet (cycles once all 16 are taken). */
export function nextThemeColor(themes = state.config.themes) {
  const used = new Map();
  themes.forEach((t) => { const c = themeColorName(t); used.set(c, (used.get(c) || 0) + 1); });
  const min = Math.min(...PALETTE.map(([n]) => used.get(n) || 0));
  return PALETTE.find(([n]) => (used.get(n) || 0) === min)[0];
}

/** Small colored tag with the theme name, for any question in a confirmed theme. */
export function themeTagHTML(item, { short = false } = {}) {
  const t = item?.themeId ? themeById(item.themeId) : null;
  if (!t) return '';
  const name = short && t.name.length > 32 ? `${t.name.slice(0, 30)}…` : t.name;
  return `<span class="theme-tag" style="--tc:${themeHex(t)}" title="Theme: ${escAttr(t.name)}"><i aria-hidden="true"></i>${escAttr(name)}</span>`;
}
const escAttr = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- Calibration ----------
export const LABELS = {
  same: { label: 'Same question', hint: 'Asking for the same thing. One answer would serve both.' },
  topic: { label: 'Same topic', hint: 'Related area, but a different question.' },
  unrelated: { label: 'Unrelated', hint: 'Different subjects.' },
};

/**
 * Pick the threshold that sorts labeled examples best. Among equally good thresholds it leans
 * strict (60% of the way up the best range): a missed match is cheaper than a wrong one.
 */
export function fitThreshold(pos, neg, lo = 20, hi = 90) {
  if (!pos.length || !neg.length) return null;
  let best = -1, range = [];
  for (let t = lo; t <= hi; t++) {
    const c = pos.filter((s) => s >= t).length + neg.filter((s) => s < t).length;
    if (c > best) { best = c; range = [t]; } else if (c === best) range.push(t);
  }
  const t = range[Math.floor((range.length - 1) * 0.6)];
  return { t, correct: best, total: pos.length + neg.length };
}

export const accuracyAt = (pos, neg, t) =>
  (pos.length + neg.length) ? (pos.filter((s) => s >= t).length + neg.filter((s) => s < t).length) / (pos.length + neg.length) : null;

/** Labeled pairs that still exist, with current scores. */
export function scoredLabels() {
  const idx = getIndex();
  const ids = new Set(state.items.map((i) => i.id));
  return (state.config.matchCheck || []).filter((p) => ids.has(p.a) && ids.has(p.b))
    .map((p) => ({ ...p, score: idx.compare(p.a, p.b).score }));
}

// ---------- To do inbox ----------
import { todayISO as _today, addDaysISO as _addDays } from './utils.js';

export const INBOX_TYPES = {
  followup: { label: 'Follow-up', plural: 'Follow-ups' },
  conflict: { label: 'Answers disagree', plural: 'Disagreements' },
  dup: { label: 'Possible duplicate', plural: 'Duplicates' },
  fit: { label: 'Fits a theme', plural: 'Theme fits' },
  group: { label: 'New theme?', plural: 'New themes' },
  verdict: { label: 'Verdict', plural: 'Verdicts' },
};

let inboxMemo = { key: null, value: null };
/** Every decision waiting for a person, most urgent first. */
export function computeInbox() {
  const idx = getIndex();
  if (inboxMemo.key && inboxMemo.key[0] === state.items && inboxMemo.key[1] === state.config && inboxMemo.key[2] === idx) return inboxMemo.value;
  const today = _today();
  const cfg = state.config;
  const hidden = (k) => !!cfg.inbox?.dismissed?.[k] || (cfg.inbox?.snoozed?.[k] && cfg.inbox.snoozed[k] > today);
  const byId = new Map(state.items.map((i) => [i.id, i]));
  const qs = state.items.filter(isQuestion);
  const cards = [];
  const push = (c) => { if (!hidden(c.key)) cards.push(c); };

  // Follow-ups overdue or due within 3 days
  const soon = _addDays(today, 3);
  for (const i of qs) {
    const f = i.followUp;
    if (!f || f.done || (f.due && f.due > soon)) continue;
    push({ type: 'followup', key: `fu:${i.id}`, prio: f.due && f.due < today ? 1 : 2, item: i, overdue: !!(f.due && f.due < today) });
  }

  // Near-identical pairs: opposite verdicts, or possible duplicates nobody has judged yet
  const labeled = new Set((cfg.matchCheck || []).map((p) => (p.a < p.b ? `${p.a}-${p.b}` : `${p.b}-${p.a}`)));
  for (const p of idx.allPairs()) {
    if (p.score < idx.sameThreshold) continue;
    const a = byId.get(p.a), b = byId.get(p.b);
    if (!a || !b) continue;
    const k = p.a < p.b ? `${p.a}-${p.b}` : `${p.b}-${p.a}`;
    const opp = (x, y) => x.verdict === 'no' && ['yes', 'partial'].includes(y.verdict);
    if (opp(a, b) || opp(b, a)) push({ type: 'conflict', key: `conflict:${k}`, prio: 3, a, b, score: p.score });
    else if (!labeled.has(k) && !(a.themeId && a.themeId === b.themeId)) push({ type: 'dup', key: `dup:${k}`, prio: 4, a, b, score: p.score });
  }

  // Unthemed questions that fit an existing theme
  const themeIds = cfg.themes.map((t) => t.id).filter((id) => qs.some((i) => i.themeId === id));
  const fitted = new Set();
  if (themeIds.length) {
    for (const i of qs) {
      if (i.themeId) continue;
      const best = idx.bestTheme(i.id, themeIds);
      if (best && best.score >= idx.themeThreshold) {
        const k = `fit:${i.id}:${best.themeId}`;
        if (!hidden(k)) fitted.add(i.id);
        push({ type: 'fit', key: k, prio: 5, item: i, themeId: best.themeId, score: best.score });
      }
    }
  }

  // Suggested groups not yet confirmed (minus questions already offered to a theme)
  for (const t of effectiveThemes()) {
    if (t.confirmed) continue;
    const ids = t.ids.filter((id) => !fitted.has(id));
    if (ids.length < 2) continue;
    push({ type: 'group', key: `group:${t.key}`, prio: 6, group: { key: t.key, ids: t.ids, title: t.name }, ids });
  }

  // Answers without a verdict
  for (const i of qs) {
    if (i.verdict) continue;
    push({ type: 'verdict', key: `verdict:${i.id}`, prio: 7, item: i, suggested: suggestVerdict(i.answer, i.question) });
  }

  cards.sort((x, y) => x.prio - y.prio || (y.score || 0) - (x.score || 0));
  const gaps = {
    account: qs.filter((i) => !i.company && !/\(.+\)/.test(i.askedBy)).length,
    date: qs.filter((i) => !i.askedAt).length,
  };
  const value = { cards, count: cards.length, gaps };
  inboxMemo = { key: [state.items, state.config, idx], value };
  return value;
}

// ---------- What changed ----------
/** A theme or account only counts as moving if at least this many accounts moved. */
export const MIN_MOVE = 2;
const STAGE_ORDER = ['prospecting', 'qualification', 'discovery', 'needs analysis', 'demo', 'evaluation', 'value proposition', 'proposal', 'proposal/price quote', 'negotiation', 'negotiation/review', 'closed won', 'closed lost'];

/** Start and end dates (YYYY-MM-DD) of a period, or of the one before it (offset 1). */
export function periodRange(p, offset = 0) {
  const days = PERIODS[p].days;
  if (!days) return null;
  const end = new Date(Date.now() - offset * days * DAY);
  const start = new Date(end.getTime() - days * DAY + DAY);
  const iso = (d) => d.toISOString().slice(0, 10);
  return { start: iso(start), end: iso(end) };
}

/** Everything that changed in period p compared with the period before. Null for All time. */
export function whatChanged(p) {
  if (!PERIODS[p].days) return null;
  const qs = state.items.filter(isQuestion);
  const cur = qs.filter((i) => inPeriod(i, p));
  const prev = qs.filter((i) => inPeriod(i, p, 1));
  const range = periodRange(p);
  const accts = (list) => new Set(list.map(accountOf));
  const headline = {
    questions: cur.length, accounts: accts(cur).size,
    prevQuestions: prev.length, prevAccounts: accts(prev).size,
    undated: qs.filter((i) => !i.askedAt).length,
  };

  const themes = effectiveThemes().map((t) => {
    const items = t.ids.map((id) => state.items.find((x) => x.id === id)).filter(Boolean);
    const c = items.filter((i) => inPeriod(i, p)), pr = items.filter((i) => inPeriod(i, p, 1));
    const dated = items.filter((i) => i.askedAt).map((i) => i.askedAt).sort();
    return { t, items, cur: c, prev: pr, curAccts: [...accts(c)], prevAccts: [...accts(pr)], first: dated[0] || null };
  });

  const moved = themes.map((x) => ({ ...x, delta: x.curAccts.length - x.prevAccts.length }));
  const rising = moved.filter((x) => x.delta >= MIN_MOVE).sort((a, b) => b.delta - a.delta || b.cur.length - a.cur.length);
  const falling = moved.filter((x) => x.delta <= -MIN_MOVE).sort((a, b) => a.delta - b.delta);
  const newThemes = themes.filter((x) => x.cur.length && x.first && x.first >= range.start && !x.prev.length)
    .sort((a, b) => b.curAccts.length - a.curAccts.length || b.cur.length - a.cur.length);

  // Gaps and promises raised this period (confirmed verdicts only), grouped by theme
  const tOf = themeIndex();
  const gapMap = new Map();
  for (const i of cur) {
    if (!['no', 'roadmap', 'partial'].includes(i.verdict)) continue;
    const t = tOf.get(i.id);
    const key = t ? t.id : `q${i.id}`;
    const g = gapMap.get(key) || { name: t ? t.name : i.question, theme: t || null, verdicts: new Set(), accounts: new Set(), ids: [] };
    g.verdicts.add(i.verdict); g.accounts.add(accountOf(i)); g.ids.push(i.id);
    gapMap.set(key, g);
  }
  const earlierGap = (g) => g.theme && g.theme.ids.some((id) => {
    const x = state.items.find((y) => y.id === id);
    return x && ['no', 'roadmap', 'partial'].includes(x.verdict) && x.askedAt && x.askedAt < range.start;
  });
  const gaps = [...gapMap.values()].map((g) => ({ ...g, firstTime: !earlierGap(g) }))
    .sort((a, b) => b.accounts.size - a.accounts.size || b.ids.length - a.ids.length);

  // Accounts with several open items right now
  const today = new Date().toISOString().slice(0, 10);
  const byAcct = new Map();
  for (const i of qs) {
    const open = i.followUp && !i.followUp.done;
    const promise = i.verdict === 'roadmap';
    if (!open && !promise) continue;
    const a = byAcct.get(accountOf(i)) || { name: accountOf(i), followUps: 0, overdue: 0, promises: 0, ids: [] };
    if (open) { a.followUps++; if (i.followUp.due && i.followUp.due < today) a.overdue++; }
    if (promise) a.promises++;
    a.ids.push(i.id);
    byAcct.set(a.name, a);
  }
  const openAccounts = [...byAcct.values()].filter((a) => a.followUps + a.promises >= 2)
    .sort((a, b) => b.overdue - a.overdue || (b.followUps + b.promises) - (a.followUps + a.promises));

  // Themes by deal stage (from the imported Salesforce report)
  const stageOf = (acct) => state.config.accounts?.[acct]?.stage || null;
  let stages = null;
  if (Object.keys(state.config.accounts || {}).length) {
    const seen = new Set();
    const rows = themes.filter((x) => x.cur.length).sort((a, b) => b.curAccts.length - a.curAccts.length).slice(0, 8).map((x) => {
      const cells = {};
      x.curAccts.forEach((a) => { const s = stageOf(a) || 'No stage'; seen.add(s); cells[s] = (cells[s] || 0) + 1; });
      return { t: x.t, cells };
    });
    const rank = (s) => { const i = STAGE_ORDER.indexOf(s.toLowerCase()); return i < 0 ? (s === 'No stage' ? 999 : 500) : i; };
    stages = { cols: [...seen].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)), rows };
  }

  return { range, prevRange: periodRange(p, 1), headline, rising, falling, newThemes, gaps, openAccounts, stages };
}

// ---------- Spot check: accuracy on typical pairs ----------
/** Score levels the spot check samples from (scores of the model in use). */
export const SPOT_BANDS = [0, 20, 35, 50, 65, 80, 101];
export const bandOf = (score) => Math.max(0, SPOT_BANDS.findIndex((e, i) => score >= e && score < SPOT_BANDS[i + 1]));

let bandMemo = { idx: null, counts: null };
/** How many question pairs fall in each score level: the real mix the spot check is weighted by. */
export function bandCounts() {
  const idx = getIndex();
  if (bandMemo.idx === idx) return bandMemo.counts;
  const qs = state.items.filter(isQuestion).map((i) => i.id);
  const counts = new Array(SPOT_BANDS.length - 1).fill(0);
  for (let x = 0; x < qs.length; x++) for (let y = x + 1; y < qs.length; y++) counts[bandOf(idx.compare(qs[x], qs[y]).score)]++;
  bandMemo = { idx, counts };
  return counts;
}

/**
 * Typical accuracy: how often the current thresholds sort a question pair the way you would,
 * estimated from spot-check labels and weighted by how common each score level really is.
 * Three-way: unrelated / same topic / same question.
 */
export function spotSummary() {
  const idx = getIndex();
  const L = scoredLabels().filter((p) => p.from === 'spot');
  if (!L.length) return { n: 0 };
  const verdict = (s) => (s >= idx.sameThreshold ? 'same' : s >= idx.threshold ? 'topic' : 'unrelated');
  const counts = bandCounts();
  const per = counts.map(() => ({ n: 0, ok: 0, okTopic: 0 }));
  for (const p of L) {
    const b = per[bandOf(p.score)];
    b.n++;
    if (verdict(p.score) === p.label) b.ok++;
    if ((p.score >= idx.threshold) === (p.label !== 'unrelated')) b.okTopic++;
  }
  let w = 0, acc = 0, accTopic = 0;
  per.forEach((b, i) => { if (b.n) { w += counts[i]; acc += counts[i] * (b.ok / b.n); accTopic += counts[i] * (b.okTopic / b.n); } });
  const covered = counts.reduce((a, c, i) => a + (per[i].n ? c : 0), 0) / Math.max(1, counts.reduce((a, c) => a + c, 0));
  return { n: L.length, acc: w ? acc / w : null, accTopic: w ? accTopic / w : null, covered, per, counts };
}
