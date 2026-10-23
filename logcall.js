// Log a call: enter call details once, then add questions quickly.
// Theme, verdict and follow-ups are suggested as you type; you can change any of them.

import { state, logCall, matchText, matchTheme, getIndex, companyOf, contactOf } from './store.js';
import { VERDICTS, suggestVerdict, detectFollowUp } from './model.js';
import { openDialog, toast, toastError } from './ui.js';
import { parseNotes } from './notes.js';
import { esc, icon, debounce, todayISO, addDaysISO, uid, repNames } from './utils.js';

export const CALL_TYPES = ['Discovery', 'Demo', 'Pricing call', 'Technical deep dive', 'Email', 'RFP', 'Onsite', 'Other', 'Not recorded'];

export function openLogCall(callId = null, { onSaved } = {}) {
  const existing = callId ? state.config.calls.find((c) => c.id === callId) : null;
  const call = existing ? { ...existing } : { id: uid('call'), date: todayISO(), company: '', contact: '', type: 'Demo', rep: '' };
  const existingCount = existing ? state.items.filter((i) => i.callId === existing.id).length : 0;
  const rows = [];
  const newRow = () => ({ question: '', answer: '', verdict: null, verdictTouched: false, theme: '', themeTouched: false, suggestion: null, topic: '', topicTouched: false, followUp: null, fuTouched: false });
  rows.push(newRow());

  const companies = [...new Set([...state.items.map(companyOf), ...state.config.calls.map((c) => c.company), ...Object.keys(state.config.accounts)].filter(Boolean))].sort();
  const contacts = [...new Set(state.items.map(contactOf).filter(Boolean))].sort();
  const reps = [...new Set(state.items.flatMap((i) => repNames(i.answeredBy)))].filter((r) => r !== 'Unassigned').sort();
  const sfNames = Object.keys(state.config.accounts);

  const d = openDialog({
    title: existing ? 'Edit call' : 'Log a call',
    sub: existing ? `${existingCount} questions on this call. Changes to the details apply to all of them.` : 'Enter the call details once. Every question you add inherits them.',
    wide: true,
    between: `
      <form id="call-details" class="call-details">
        <div class="field span-2">
          <label for="c-company">Account</label>
          <input class="input" id="c-company" list="dl-companies" value="${esc(call.company)}" placeholder="Company name" autocomplete="off">
          <span class="field-hint" id="c-sf"></span>
        </div>
        <div class="field"><label for="c-contact">Contact</label><input class="input" id="c-contact" list="dl-contacts" value="${esc(call.contact)}" autocomplete="off"></div>
        <div class="field"><label for="c-date">Date</label><input class="input" type="date" id="c-date" value="${esc(call.date)}"></div>
        <div class="field"><label for="c-type">Call type</label><select class="select" id="c-type">${CALL_TYPES.map((t) => `<option ${t === call.type ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
        <div class="field"><label for="c-rep">Answered by</label><input class="input" id="c-rep" list="dl-reps" value="${esc(call.rep)}" autocomplete="off"></div>
        <datalist id="dl-companies">${companies.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
        <datalist id="dl-contacts">${contacts.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
        <datalist id="dl-reps">${reps.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
      </form>`,
    body: `<details class="paste-notes" id="paste-notes">
        <summary>Paste call notes</summary>
        <p class="field-hint">Paste notes and they’re split into questions: any line with a question mark, or starting with “Q:”, begins a question, and the lines after it become its answer. Bullets and speaker names (“Kash:”) are tidied up. Check the rows before saving.</p>
        <label class="visually-hidden" for="notes-in">Call notes</label>
        <textarea class="textarea" id="notes-in" rows="7" placeholder="Q: Can the PTP be completed on a phone?&#10;A: Yes, through the mobile app, including offline.&#10;&#10;- Is SSO supported? Yes, SAML with Azure AD."></textarea>
        <div class="toolbar"><button type="button" class="btn btn-primary" data-parse>Split into questions</button><span class="field-hint" id="parse-result" aria-live="polite"></span></div>
      </details>
      <div id="q-rows" class="q-rows"></div>
      <button type="button" class="btn" data-add-row>${icon('plus', 'icon-sm')}Add another question</button>
      <p class="field-hint">Press Enter in an answer to start the next question. Shift+Enter adds a line break.</p>`,
    foot: `<span class="field-hint" id="call-count"></span>
      <div class="right"><button type="button" class="btn" data-close>Cancel</button>
      <button type="button" class="btn btn-primary" data-save>${existing ? 'Save call' : 'Save call'}</button></div>`,
  });

  const $ = (s) => d.querySelector(s);
  const rowsEl = $('#q-rows');
  const themeOptions = () => [...state.config.themes].sort((a, b) => a.name.localeCompare(b.name));

  function sfHint() {
    const v = $('#c-company').value.trim();
    const el = $('#c-sf');
    if (!sfNames.length || !v) { el.textContent = ''; return; }
    const hit = sfNames.find((n) => n.toLowerCase() === v.toLowerCase());
    el.innerHTML = hit ? '<span class="ok-text">✓ Matches a Salesforce account</span>' : 'Not in your Salesforce report. Check the spelling so stages can match later.';
  }
  $('#c-company').addEventListener('input', sfHint);
  sfHint();

  function rowHTML(r, n) {
    return `<div class="q-row" data-row="${n}">
      <div class="q-row-main">
        <div class="field"><label for="q${n}">Question ${n + 1}</label><textarea class="textarea" id="q${n}" data-f="question" rows="2">${esc(r.question)}</textarea></div>
        <div class="field"><label for="a${n}">Answer</label><textarea class="textarea" id="a${n}" data-f="answer" rows="2">${esc(r.answer)}</textarea></div>
      </div>
      <div class="q-row-sugg" data-sugg>${suggHTML(r, n)}</div>
      ${rows.length > 1 ? `<button type="button" class="icon-btn q-remove" data-remove="${n}" aria-label="Remove question ${n + 1}">${icon('x', 'icon-sm')}</button>` : ''}
    </div>`;
  }

  function suggHTML(r, n) {
    const s = r.suggestion;
    const themeVal = r.theme;
    const opts = [
      '<option value="">No theme</option>',
      ...(s && s.newWith ? [`<option value="n:${s.newWith.id}" ${themeVal === `n:${s.newWith.id}` ? 'selected' : ''}>New theme with #${s.newWith.id}</option>`] : []),
      ...themeOptions().map((t) => `<option value="t:${esc(t.id)}" ${themeVal === `t:${t.id}` ? 'selected' : ''}>${esc(t.name)}</option>`),
    ].join('');
    const cats = state.categories.length ? state.categories : ['General Operations'];
    return `
      <label class="mini-field">Theme
        <select class="select select-inline" data-f="theme" aria-label="Theme for question ${n + 1}">${opts}</select>
        ${s && themeVal && !r.themeTouched ? `<span class="field-hint">${s.score}% match${s.newWith ? `: “${esc(s.newWith.question.slice(0, 60))}”` : ''}</span>` : ''}
      </label>
      <label class="mini-field">Category
        <select class="select select-inline" data-f="topic" aria-label="Category for question ${n + 1}">${cats.map((c) => `<option ${c === r.topic ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
      </label>
      <div class="mini-field" role="radiogroup" aria-label="Verdict for question ${n + 1}" title="Can we do what was asked? A “No, it’s optional” answer is a Yes.">Verdict
        <span class="pills">${VERDICTS.filter((v) => v.id !== 'na').map((v) => `<button type="button" class="pill" data-verdict="${v.id}" aria-pressed="${r.verdict === v.id}">${v.label}</button>`).join('')}</span>
      </div>
      ${r.followUp ? `<div class="fu-box"><strong>Follow-up</strong>${!r.fuTouched ? '<span>Detected in the answer.</span>' : ''}
        <label>Owner <input class="input input-sm" data-f="fuOwner" value="${esc(r.followUp.owner)}"></label>
        <label>Due <input class="input input-sm" type="date" data-f="fuDue" value="${esc(r.followUp.due)}"></label>
        <button type="button" class="link-btn" data-fu="remove">Remove</button></div>`
        : `<button type="button" class="link-btn" data-fu="add">Add follow-up</button>`}`;
  }

  function render(focus) {
    rowsEl.innerHTML = rows.map(rowHTML).join('');
    $('#call-count').textContent = `${rows.filter((r) => r.question.trim()).length} new question${rows.filter((r) => r.question.trim()).length === 1 ? '' : 's'}${existing ? ` · ${existingCount} already on this call` : ''}`;
    if (focus) rowsEl.querySelector(focus)?.focus();
  }
  const paintSugg = (n) => {
    const el = rowsEl.querySelector(`[data-row="${n}"] [data-sugg]`);
    if (el) el.innerHTML = suggHTML(rows[n], n);
    $('#call-count').textContent = `${rows.filter((r) => r.question.trim()).length} new questions${existing ? ` · ${existingCount} already on this call` : ''}`;
  };

  async function suggestRow(n) {
    const r = rows[n];
    if (!r) return;
    const repNow = $('#c-rep').value.trim();
    if (!r.verdictTouched) r.verdict = suggestVerdict(r.answer, r.question);
    if (!r.fuTouched) {
      r.followUp = (r.verdict === 'followup' || detectFollowUp(r.answer))
        ? { owner: r.followUp?.owner || repNow, due: r.followUp?.due || addDaysISO($('#c-date').value || todayISO(), 7), done: false } : null;
    }
    const text = `${r.question} ${r.answer}`.trim();
    if (r.question.trim().length >= 12) {
      const idx = getIndex();
      const fit = await matchTheme(text);
      const m = await matchText(text, (it) => it.kind !== 'feedback');
      if (fit && fit.score >= idx.themeThreshold) {
        // Fits an existing theme (judged against the whole theme, not one question).
        r.suggestion = { score: fit.score, themeId: fit.themeId };
        if (!r.themeTouched) r.theme = `t:${fit.themeId}`;
        const peer = state.items.find((i) => i.themeId === fit.themeId);
        if (!r.topicTouched && peer) r.topic = peer.topic;
      } else if (m && m.score >= idx.threshold && !m.item.themeId) {
        // Close to a question that has no theme yet: offer a new theme with it.
        r.suggestion = { score: m.score, newWith: m.item };
        if (!r.themeTouched) r.theme = `n:${m.item.id}`;
        if (!r.topicTouched) r.topic = m.item.topic;
      } else {
        r.suggestion = null;
        if (!r.themeTouched) r.theme = '';
      }
    }
    if (!r.topic) r.topic = state.categories[0] || 'General Operations';
    paintSugg(n);
  }
  const suggest = debounce(suggestRow, 350);

  rowsEl.addEventListener('input', (e) => {
    const rowEl = e.target.closest('[data-row]');
    if (!rowEl) return;
    const n = Number(rowEl.dataset.row);
    const f = e.target.dataset.f;
    if (f === 'question' || f === 'answer') { rows[n][f] = e.target.value; suggest(n); }
    if (f === 'fuOwner') { rows[n].followUp.owner = e.target.value; rows[n].fuTouched = true; }
    if (f === 'fuDue') { rows[n].followUp.due = e.target.value; rows[n].fuTouched = true; }
  });
  rowsEl.addEventListener('change', (e) => {
    const rowEl = e.target.closest('[data-row]');
    if (!rowEl) return;
    const n = Number(rowEl.dataset.row);
    if (e.target.dataset.f === 'theme') { rows[n].theme = e.target.value; rows[n].themeTouched = true; paintSugg(n); }
    if (e.target.dataset.f === 'topic') { rows[n].topic = e.target.value; rows[n].topicTouched = true; }
  });
  rowsEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && e.target.dataset.f === 'answer') {
      e.preventDefault();
      const n = Number(e.target.closest('[data-row]').dataset.row);
      if (n === rows.length - 1) { rows.push(newRow()); render(`#q${n + 1}`); } else rowsEl.querySelector(`#q${n + 1}`)?.focus();
    }
  });
  d.addEventListener('click', (e) => {
    const t = e.target;
    const rowEl = t.closest('[data-row]');
    const n = rowEl ? Number(rowEl.dataset.row) : -1;
    const v = t.closest('[data-verdict]');
    if (v && n >= 0) { rows[n].verdict = rows[n].verdict === v.dataset.verdict ? null : v.dataset.verdict; rows[n].verdictTouched = true; paintSugg(n); return; }
    const fu = t.closest('[data-fu]');
    if (fu && n >= 0) {
      rows[n].fuTouched = true;
      rows[n].followUp = fu.dataset.fu === 'add' ? { owner: $('#c-rep').value.trim(), due: addDaysISO($('#c-date').value || todayISO(), 7), done: false } : null;
      paintSugg(n);
      return;
    }
    const rm = t.closest('[data-remove]');
    if (rm) { rows.splice(Number(rm.dataset.remove), 1); render(); return; }
    if (t.closest('[data-add-row]')) { rows.push(newRow()); render(`#q${rows.length - 1}`); return; }
    if (t.closest('[data-save]')) save();
    if (t.closest('[data-parse]')) splitNotes();
  });
  d.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
  });

  async function splitNotes() {
    const text = $('#notes-in').value;
    const { pairs, skipped } = parseNotes(text);
    const out = $('#parse-result');
    if (!pairs.length) {
      out.textContent = 'No questions found. Make sure each question ends with “?” or starts with “Q:”.';
      return;
    }
    // Keep rows already filled in; replace empty ones.
    for (let n = rows.length - 1; n >= 0; n--) if (!rows[n].question.trim() && !rows[n].answer.trim()) rows.splice(n, 1);
    const start = rows.length;
    pairs.forEach((p) => rows.push({ ...newRow(), question: p.question, answer: p.answer }));
    render();
    out.textContent = `Found ${pairs.length} question${pairs.length === 1 ? '' : 's'}${skipped ? `; ${skipped} other line${skipped === 1 ? ' was' : 's were'} left out` : ''}. Suggesting themes…`;
    $('#paste-notes').open = false;
    for (let n = start; n < rows.length; n++) await suggestRow(n);
    out.textContent = `Found ${pairs.length} question${pairs.length === 1 ? '' : 's'}${skipped ? `; ${skipped} other line${skipped === 1 ? ' was' : 's were'} left out (headings, attendees and the like)` : ''}. Check them below.`;
  }

  async function save() {
    const details = {
      id: call.id,
      company: $('#c-company').value.trim(),
      contact: $('#c-contact').value.trim(),
      date: $('#c-date').value,
      type: $('#c-type').value,
      rep: $('#c-rep').value.trim(),
    };
    if (!details.company && !details.contact) { toastError('Add the account or the contact.'); $('#c-company').focus(); return; }
    if (!details.date) { toastError('Add the date of the call.'); $('#c-date').focus(); return; }
    const filled = rows.filter((r) => r.question.trim());
    if (!existing && !filled.length) { toastError('Add at least one question.'); rowsEl.querySelector('#q0')?.focus(); return; }
    const questions = filled.map((r) => {
      const q = { question: r.question.trim(), answer: r.answer.trim(), verdict: r.verdict, topic: r.topic || state.categories[0], answeredBy: details.rep, followUp: r.followUp };
      if (r.theme.startsWith('t:')) q.themeId = r.theme.slice(2);
      if (r.theme.startsWith('n:')) {
        const withId = Number(r.theme.slice(2));
        const peer = state.items.find((i) => i.id === withId);
        const name = [r.question.trim(), peer?.question || ''].filter(Boolean).sort((a, b) => a.length - b.length)[0];
        q.newTheme = { id: uid('theme'), name: name.replace(/\?$/, ''), withId };
      }
      return q;
    });
    d.close();
    const ok = await logCall(details, questions);
    if (ok) {
      toast(existing ? 'Call updated' : `Call saved with ${questions.length} question${questions.length === 1 ? '' : 's'}`);
      onSaved?.(details.id);
    }
  }

  render('#c-company');
  if (!existing) $('#c-company').focus();
}
