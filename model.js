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
  const near = Math.max(idx.threshold + 25, 70); // "the same question", not just the same topic
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
