import { XLSX_URL } from './config.js';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Escape any user-provided text before it goes into HTML. */
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export const icon = (name, cls = '') =>
  `<svg class="icon ${cls}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;

export const wordCount = (s) => (String(s || '').trim().match(/\S+/g) || []).length;

export const isNoAnswer = (a) => !a || /^no answer provided\.?$/i.test(String(a).trim());

export function debounce(fn, ms = 200) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/** "Mark (North Shore Metal)" -> { person: "Mark", company: "North Shore Metal" } */
export function splitAsker(a) {
  const m = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(String(a || ''));
  return m ? { person: m[1].trim(), company: m[2].trim() } : { person: String(a || '').trim(), company: '' };
}

/**
 * "Casey and Caroline" -> ["Casey", "Caroline"]
 * "Rosanna Camporeale; Adam Pollack" -> ["Rosanna Camporeale", "Adam Pollack"]
 * "Mattheu Allen (partial response)" -> ["Mattheu Allen"]: bracketed notes describe the answer, not the rep.
 * The original text is kept on the record; this only decides who the reps are.
 */
export function repNames(r) {
  return String(r || '')
    .replace(/\([^)]*\)/g, ' ')
    .split(/\s*(?:[,;&/]|\band\b)\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Order-independent form so "Casey and Caroline" and "Caroline and Casey" match. Text with notes is left alone. */
export function canonicalRep(r) {
  const text = String(r || '').trim();
  if (/\(/.test(text)) return text;
  const names = [...new Set(repNames(text))].sort((a, b) => a.localeCompare(b));
  if (names.length < 2) return text;
  if (names.length === 2) return names.join(' and ');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** Highlight search terms inside already-escaped text. */
export function highlight(text, terms) {
  let out = esc(text);
  if (!terms.length) return out;
  const re = new RegExp(`(${terms.map((t) => esc(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return out.replace(re, '<mark>$1</mark>');
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

export function relTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return d.toLocaleDateString();
}

export const pluralize = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

let xlsxPromise = null;
/** The spreadsheet library is ~900 KB, so it only loads when someone imports or exports. */
export function loadXLSX() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  xlsxPromise ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = XLSX_URL;
    s.onload = () => resolve(window.XLSX);
    s.onerror = () => {
      xlsxPromise = null;
      reject(new Error('Could not load the spreadsheet reader. Check your connection and try again.'));
    };
    document.head.appendChild(s);
  });
  return xlsxPromise;
}

export const isTyping = (el) =>
  el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

export const todayISO = () => new Date().toISOString().slice(0, 10);

export function addDaysISO(iso, days) {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/** "2026-10-14" -> "Oct 14, 2026" */
export function fmtDate(iso, { year = true } = {}) {
  if (!iso) return '';
  const d = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(year ? { year: 'numeric' } : {}) });
}

export function downloadText(filename, text, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const uid = (prefix) => `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
