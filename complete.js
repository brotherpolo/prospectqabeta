// Complete records: fill in account, date, verdict and theme for older questions.
// Everything is suggested from the data and applied only when you confirm.

import { state, getItem, completeAccounts, createCalls, setVerdicts, saveThemes, companyOf } from './store.js';
import { VERDICTS, verdictLabel, suggestVerdict, effectiveThemes, isQuestion } from './model.js';
import { CALL_TYPES } from './logcall.js';
import { toast } from './ui.js';
import { esc, splitAsker, repNames, pluralize, uid } from './utils.js';

const ui = { acct: {}, dates: {}, names: {}, excluded: {}, skipped: new Set(), review: null, unticked: new Set(), rejected: new Set() };
let root = null;

export function mount(el) {
  root = el;
  el.onclick = onClick;
  el.oninput = onInput;
  el.onchange = onInput;
  update();
}

// ---------- Step 1 data ----------
function accountRows() {
  const groups = new Map();
  for (const i of state.items) {
    if (i.company || i.kind === 'feedback') continue;
    (groups.get(i.askedBy) || groups.set(i.askedBy, []).get(i.askedBy)).push(i);
  }
  const answered = new Map(), asked = new Map();
  state.items.forEach((i) => {
    repNames(i.answeredBy).forEach((r) => answered.set(r.toLowerCase(), (answered.get(r.toLowerCase()) || 0) + 1));
    const p = splitAsker(i.askedBy).person.toLowerCase();
    asked.set(p, (asked.get(p) || 0) + 1);
  });
  const cands = candidates();
  return [...groups.entries()].sort((a, b) => b[1].length - a[1].length).map(([askedBy, items]) => {
    const { person, company } = splitAsker(askedBy);
    const isRep = (answered.get(person.toLowerCase()) || 0) > (asked.get(person.toLowerCase()) || 0);
    const saved = ui.acct[askedBy] || {};
    return {
      askedBy, items, person, isRep,
      contact: saved.contact ?? person,
      company: saved.company ?? company,
      feedback: saved.feedback ?? false,
      source: company ? 'Split from the name' : '',
      cands: company ? [] : (cands.get(askedBy) || []),
    };
  });
}

/** Proper names that appear in one asker's questions but nobody else's, e.g. "COR3" or "Callan". */
function candidates() {
  // Skip greetings, your own product words, abbreviations (PTP, LMS) and rep names.
  const skip = new Set(['I', 'Yes', 'No', 'OK', ...state.config.ignoreWords, ...state.config.synonyms.map((x) => x.term),
    ...state.items.flatMap((i) => repNames(i.answeredBy))].map((w) => w.toLowerCase()));
  // Ignore questions "asked" by reps (e.g. a rep asking the prospect for feedback).
  const answered = new Map(), asked = new Map();
  state.items.forEach((i) => {
    repNames(i.answeredBy).forEach((r) => answered.set(r.toLowerCase(), (answered.get(r.toLowerCase()) || 0) + 1));
    const p = splitAsker(i.askedBy).person.toLowerCase();
    asked.set(p, (asked.get(p) || 0) + 1);
  });
  const repLike = (a) => { const p = splitAsker(a).person.toLowerCase(); return (answered.get(p) || 0) > (asked.get(p) || 0); };
  const seen = new Map(); // word -> Map(askedBy -> ids)
  for (const i of state.items) {
    if (repLike(i.askedBy)) continue;
    const text = `${i.question} ${i.answer}`;
    for (const m of text.matchAll(/\b[A-Z][A-Za-z0-9&-]*[A-Za-z0-9]\b/g)) {
      const before = text.slice(0, m.index).trimEnd();
      if (!before || /[.?!:]$/.test(before)) continue; // sentence start
      const w = m[0];
      if (skip.has(w.toLowerCase()) || w.length < 3) continue;
      const by = seen.get(w) || seen.set(w, new Map()).get(w);
      (by.get(i.askedBy) || by.set(i.askedBy, new Set()).get(i.askedBy)).add(i.id);
    }
  }
  const knownCompanies = new Set(state.items.map(companyOf).filter(Boolean));
  const out = new Map();
  for (const [w, by] of seen) {
    const owners = [...by.keys()];
    const solo = owners.length === 1 || knownCompanies.has(w);
    if (!solo) continue;
    for (const o of owners) {
      if (splitAsker(o).person === w) continue;
      (out.get(o) || out.set(o, []).get(o)).push({ word: w, ids: [...by.get(o)] });
    }
  }
  // Company-like names first: "COR3" (has a digit) or "Callan" (capitalized word) before all-caps acronyms like "OSHA".
  const looks = (w) => (/\d/.test(w) ? 2 : /[a-z]/.test(w) ? 1 : 0);
  for (const [o, list] of out) out.set(o, list.sort((a, b) => looks(b.word) - looks(a.word) || b.ids.length - a.ids.length).slice(0, 3));
  return out;
}

// ---------- Step 2 data ----------
function callGroups() {
  const groups = new Map();
  for (const i of state.items) {
    if (i.callId || i.kind === 'feedback') continue;
    const company = i.company || '';
    const contact = i.contact || splitAsker(i.askedBy).person;
    // Imported questions may already have a date: same account, contact and date = one call.
    const key = `${company}|${contact}|${i.askedAt || ''}`;
    const g = groups.get(key) || { key, company, contact, date: i.askedAt || '', ids: [], reps: new Set() };
    g.ids.push(i.id);
    repNames(i.answeredBy).forEach((r) => r !== 'Unassigned' && g.reps.add(r));
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.ids.length - a.ids.length);
}

export function update() {
  if (!root) return;
  const qs = state.items.filter(isQuestion);
  const total = qs.length;
  const done = {
    acct: state.items.filter((i) => i.company || i.kind === 'feedback').length,
    date: qs.filter((i) => i.askedAt).length,
    verdict: qs.filter((i) => i.verdict).length,
    theme: qs.filter((i) => i.themeId).length,
  };
  const accts = accountRows();
  const calls = callGroups();
  const noVerdict = qs.filter((i) => !i.verdict);
  const buckets = {};
  noVerdict.forEach((i) => { const v = suggestVerdict(i.answer, i.question); if (v && !ui.rejected.has(i.id)) (buckets[v] ||= []).push(i.id); });
  const unclear = noVerdict.filter((i) => (!suggestVerdict(i.answer, i.question) || ui.rejected.has(i.id)) && !ui.skipped.has(i.id));
  if (ui.review && !buckets[ui.review]) ui.review = null;
  const suggestedThemes = effectiveThemes().filter((t) => !t.confirmed);
  const step = !accts.length ? (!calls.length ? (!noVerdict.length || noVerdict.length === ui.skipped.size ? 4 : 3) : 2) : 1;

  root.innerHTML = `
    <div class="page">
      <header class="page-head">
        <div>
          <h1 class="page-title">Complete records</h1>
          <p class="page-sub">Questions saved before accounts, dates, verdicts and themes existed. Most of it is suggested from what’s already there. Nothing changes until you confirm.</p>
        </div>
      </header>

      <div class="kpis">
        ${[['1 · Account', done.acct, state.items.length], ['2 · Date asked', done.date, total], ['3 · Verdict', done.verdict, total], ['4 · Theme', done.theme, total]].map(([l, n, t]) => `
          <div class="kpi"><span class="kpi-label">${l}</span><span class="kpi-value">${n} <span class="kpi-of">of ${t}</span></span>
          <span class="bar-track"><span class="bar-fill" style="width:${t ? Math.round((n / t) * 100) : 0}%"></span></span></div>`).join('')}
      </div>

      <section class="card cr-step ${step === 1 ? 'step-current' : ''}">
        <div class="card-head"><h2 class="card-title">1 · Account and contact</h2><span class="field-hint">Split from “Name (Company)”, or suggested from names in the questions</span></div>
        ${accts.length ? `<div class="table-wrap"><table class="table">
          <thead><tr><th>Asked by today</th><th class="num">Questions</th><th>Contact</th><th>Account</th><th>Suggestions</th></tr></thead>
          <tbody>${accts.map((r) => `<tr data-asker="${esc(r.askedBy)}">
            <td>${esc(r.askedBy)}</td>
            <td class="num mono">${r.items.length}</td>
            ${r.isRep ? `<td colspan="3"><label class="radio-line warn-text"><input type="checkbox" data-a="feedback" ${r.feedback ? 'checked' : ''}>${esc(r.person)} usually answers questions, so ${r.items.map((i) => `#${i.id}`).join(', ')} may be a rep asking the prospect. Mark as prospect feedback.</label></td>`
              : `<td><input class="input input-sm" data-a="contact" value="${esc(r.contact)}" aria-label="Contact for ${esc(r.askedBy)}"></td>
                 <td><input class="input input-sm" data-a="company" value="${esc(r.company)}" placeholder="Company" aria-label="Account for ${esc(r.askedBy)}"></td>
                 <td>${r.source ? `<span class="muted">${r.source}</span>` : r.cands.length ? r.cands.map((c) => `<button type="button" class="chip chip-sm" data-cand="${esc(c.word)}">${esc(c.word)} <span class="muted">${c.ids.map((id) => `#${id}`).join(' ')}</span></button>`).join(' ') : '<span class="muted">Type the account name</span>'}</td>`}
          </tr>`).join('')}</tbody></table></div>
          <div class="actions-bar"><button type="button" class="btn btn-primary" data-act="apply-accts">Apply to ${pluralize(accts.reduce((s, r) => s + r.items.length, 0), 'question')}</button></div>`
          : '<p class="ok-text">✓ Every question has an account.</p>'}
      </section>

      <section class="card cr-step ${step === 2 ? 'step-current' : ''}">
        <div class="card-head"><h2 class="card-title">2 · When were they asked?</h2><span class="field-hint">One date per conversation creates a call. Approximate is fine.</span></div>
        ${calls.length ? `<div class="date-grid">${calls.map((g) => {
          const v = { date: g.date, ...(ui.dates[g.key] || {}) };
          return `<div class="date-card" data-group="${esc(g.key)}">
            <span><strong>${esc(g.company || g.contact)}</strong>${g.company && g.contact ? ` · ${esc(g.contact)}` : ''} · ${pluralize(g.ids.length, 'question')}</span>
            <label class="mini-field">Date<input class="input input-sm" type="date" data-d="date" value="${esc(v.date || '')}"></label>
            <label class="mini-field">Call type<select class="select select-inline" data-d="type">${CALL_TYPES.map((t) => `<option ${t === (v.type || 'Not recorded') ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
          </div>`;
        }).join('')}</div>
        <p class="field-hint">More than one call with the same person? Create this one, then change individual questions’ dates in the Library.</p>
        <div class="actions-bar"><button type="button" class="btn btn-primary" data-act="apply-dates">Create calls for the dated groups</button></div>`
          : '<p class="ok-text">✓ Every question is linked to a call.</p>'}
      </section>

      <section class="card cr-step ${step === 3 ? 'step-current' : ''}">
        <div class="card-head"><h2 class="card-title">3 · Verdicts</h2><span class="field-hint">Suggested from how each answer begins or what it promises</span></div>
        ${noVerdict.length ? `
          <p class="field-hint verdict-guide">A verdict answers one thing: <strong>can we do what the prospect asked?</strong> Yes, Partial, No (a gap), Roadmap (promised later) or Follow-up (still open). Watch for questions framed in the negative: “Does a truck <em>have to</em> show a QR sticker?” answered “No, it’s optional” is a <strong>Yes</strong>.</p>
          ${ui.review ? reviewList(ui.review, buckets[ui.review]) : `
          <div class="toolbar">${Object.entries(buckets).map(([v, ids]) => `<button type="button" class="btn" data-bulk="${v}">Review ${ids.length} suggested ${verdictLabel(v)}</button>`).join('')}</div>
          ${Object.keys(buckets).length ? '<p class="field-hint">Suggestions come from how each answer begins. You’ll see each one and can untick any that are wrong before saving.</p>' : ''}
          ${unclear.length ? verdictCard(unclear[0], unclear.length) : ''}`}`
          : '<p class="ok-text">✓ Every question has a verdict.</p>'}
      </section>

      <section class="card cr-step ${step === 4 ? 'step-current' : ''}">
        <div class="card-head"><h2 class="card-title">4 · Name the themes</h2><span class="field-hint">${suggestedThemes.length ? `${suggestedThemes.reduce((s, t) => s + t.ids.length, 0)} questions fall into ${pluralize(suggestedThemes.length, 'suggested theme')}. Untick any that don’t belong.` : ''}</span></div>
        ${suggestedThemes.length ? `<div class="theme-cards">${suggestedThemes.map((t) => {
          const ex = ui.excluded[t.id] || new Set();
          return `<div class="theme-card" data-tid="${esc(t.id)}">
            <label class="visually-hidden" for="tn-${esc(t.id)}">Theme name</label>
            <input class="input" id="tn-${esc(t.id)}" data-t="name" value="${esc(ui.names[t.id] ?? t.name.replace(/\?$/, ''))}">
            ${t.ids.map((id) => { const it = getItem(id); return `<label class="radio-line small"><input type="checkbox" data-member="${id}" ${ex.has(id) ? '' : 'checked'}><span><span class="mono">#${id}</span> ${esc(it.question)} <span class="muted">· ${esc(it.company || it.askedBy)}</span></span></label>`; }).join('')}
          </div>`;
        }).join('')}</div>
        <div class="actions-bar"><button type="button" class="btn btn-primary" data-act="save-themes">Save ${pluralize(suggestedThemes.length, 'theme')}</button></div>`
          : '<p class="muted">No suggested themes right now. New ones appear as related questions are added.</p>'}
      </section>
    </div>`;
}

function reviewList(v, ids) {
  return `<div class="review-list">
    <div class="section-head"><h3 class="section-title">Suggested ${verdictLabel(v)} (${ids.length})</h3><span class="field-hint">Untick any that don’t fit. They’ll come back one at a time.</span></div>
    ${ids.map((id) => { const i = getItem(id); return `<label class="review-item"><input type="checkbox" data-tick="${id}" ${ui.unticked.has(id) ? '' : 'checked'}>
      <span><span class="mono muted">#${id}</span> <strong>${esc(i.question)}</strong><br><span>${esc(i.answer)}</span></span></label>`; }).join('')}
    <div class="actions-bar"><button type="button" class="btn" data-act="review-cancel">Cancel</button>
      <button type="button" class="btn btn-primary" data-act="review-apply">Mark ticked as ${verdictLabel(v)}</button></div>
  </div>`;
}

function verdictCard(i, left) {
  return `<div class="match-card">
    <span class="muted">${left} without a suggestion · #${i.id} · ${esc(i.company || i.askedBy)}</span>
    <strong>${esc(i.question)}</strong>
    <span>${esc(i.answer)}</span>
    <div class="pills">${VERDICTS.map((v) => `<button type="button" class="pill" data-one="${v.id}" data-id="${i.id}">${v.label}</button>`).join('')}
      <button type="button" class="link-btn" data-skip="${i.id}">Skip</button></div>
  </div>`;
}

function onInput(e) {
  const t = e.target;
  const row = t.closest('[data-asker]');
  if (row && t.dataset.a) {
    const k = row.dataset.asker;
    ui.acct[k] = { ...(ui.acct[k] || {}), [t.dataset.a]: t.type === 'checkbox' ? t.checked : t.value };
  }
  const g = t.closest('[data-group]');
  if (g && t.dataset.d) ui.dates[g.dataset.group] = { ...(ui.dates[g.dataset.group] || {}), [t.dataset.d]: t.value };
  const tc = t.closest('[data-tid]');
  if (tc && t.dataset.t === 'name') ui.names[tc.dataset.tid] = t.value;
  if (tc && t.dataset.member && e.type === 'change') {
    const set = ui.excluded[tc.dataset.tid] || (ui.excluded[tc.dataset.tid] = new Set());
    if (t.checked) set.delete(Number(t.dataset.member)); else set.add(Number(t.dataset.member));
  }
}

async function onClick(e) {
  const t = e.target;
  const cand = t.closest('[data-cand]');
  if (cand) {
    const row = cand.closest('[data-asker]');
    const input = row.querySelector('[data-a="company"]');
    input.value = cand.dataset.cand;
    ui.acct[row.dataset.asker] = { ...(ui.acct[row.dataset.asker] || {}), company: cand.dataset.cand };
    return;
  }
  const one = t.closest('[data-one]');
  if (one) { await setVerdicts([Number(one.dataset.id)], one.dataset.one); return; }
  const skip = t.closest('[data-skip]');
  if (skip) { ui.skipped.add(Number(skip.dataset.skip)); update(); return; }
  const bulk = t.closest('[data-bulk]');
  if (bulk) { ui.review = bulk.dataset.bulk; ui.unticked = new Set(); update(); return; }
  const tick = t.closest('[data-tick]');
  if (tick) { const id = Number(tick.dataset.tick); if (tick.checked) ui.unticked.delete(id); else ui.unticked.add(id); return; }
  const act = t.closest('[data-act]')?.dataset.act;
  if (act === 'review-cancel') { ui.review = null; update(); return; }
  if (act === 'review-apply') {
    const v = ui.review;
    const ids = state.items.filter((i) => !i.verdict && isQuestion(i) && !ui.rejected.has(i.id) && suggestVerdict(i.answer, i.question) === v).map((i) => i.id);
    const keep = ids.filter((id) => !ui.unticked.has(id));
    ui.unticked.forEach((id) => ui.rejected.add(id));
    ui.review = null;
    ui.unticked = new Set();
    if (!keep.length) { update(); return; }
    if (await setVerdicts(keep, v)) toast(`Marked ${pluralize(keep.length, 'question')} as ${verdictLabel(v)}${ids.length > keep.length ? `; ${ids.length - keep.length} left to decide one at a time` : ''}`);
    return;
  }
  if (act === 'apply-accts') {
    const rows = accountRows().map((r) => ({ askedBy: r.askedBy, contact: r.contact, company: r.company, feedback: r.isRep && r.feedback }));
    const missing = rows.filter((r) => !r.feedback && !r.company.trim()).length;
    if (await completeAccounts(rows)) {
      ui.acct = {};
      toast(missing ? `Saved. ${pluralize(missing, 'row')} without an account ${missing === 1 ? 'was' : 'were'} left as they are.` : 'Accounts saved');
    }
  } else if (act === 'apply-dates') {
    const groups = callGroups().filter((g) => ui.dates[g.key]?.date || g.date).map((g) => ({
      callId: uid('call'), ids: g.ids, date: ui.dates[g.key]?.date || g.date, type: ui.dates[g.key]?.type || 'Not recorded',
      company: g.company, contact: g.contact, rep: [...g.reps].join(', '),
    }));
    if (!groups.length) { toast('Add a date to at least one group first.'); return; }
    if (await createCalls(groups)) { toast(`Created ${pluralize(groups.length, 'call')}`); ui.dates = {}; }
  } else if (act === 'save-themes') {
    const themes = effectiveThemes().filter((x) => !x.confirmed).map((x) => {
      const ex = ui.excluded[x.id] || new Set();
      return { id: uid('theme'), name: (ui.names[x.id] ?? x.name).trim().replace(/\?$/, '') || x.name, ids: x.ids.filter((id) => !ex.has(id)) };
    }).filter((x) => x.ids.length >= 2);
    if (await saveThemes(themes)) { toast(`Saved ${pluralize(themes.length, 'theme')}`); ui.names = {}; ui.excluded = {}; }
  }
}
