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

/** "Casey and Caroline" -> ["Casey", "Caroline"] */
export function repNames(r) {
  return String(r || '')
    .split(/\s*(?:,|&|\/|\band\b)\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Order-independent form so "Casey and Caroline" and "Caroline and Casey" match. */
export function canonicalRep(r) {
  const names = [...new Set(repNames(r))].sort((a, b) => a.localeCompare(b));
  if (names.length < 2) return String(r || '').trim();
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
