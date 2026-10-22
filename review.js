// Review: suggested look-alike groups, free comparison of any 2–3 questions,
// score breakdown (formerly the Formula Inspector) and coaching notes.

import {
  state, getIndex, getItem, openGroups, dismissGroup, linkQuestions, saveStandard, reopenGroup,
} from './store.js';
import { toast } from './ui.js';
import { esc, icon, wordCount, canonicalRep, relTime, pluralize, uid } from './utils.js';
import { displayTerm } from './similarity.js';

const ui = { tab: 'suggested', key: null, pick: [], std: {}, drafts: {}, names: {} };
let root = null;

export function mount(el, params) {
  root = el;
  if (params.tab) ui.tab = params.tab;
  if (params.ids) {
    ui.pick = params.ids.split(',').map(Number).filter((id) => getItem(id)).slice(0, 3);
    ui.tab = 'pick';
  }
  if (params.key) { ui.key = params.key; ui.tab = 'suggested'; }
  el.onclick = onClick;
  el.onchange = onChange;
  el.oninput = (e) => {
    if (e.target.matches('[data-draft]')) ui.drafts[e.target.dataset.draft] = e.target.value;
    if (e.target.matches('[data-name]')) ui.names[e.target.dataset.name] = e.target.value;
  };
  update();
}

export function update() {
  if (!root) return;
  const groups = openGroups();
  const resolved = state.config.review.resolved;
  if (ui.key && !groups.some((g) => g.key === ui.key)) ui.key = null;
  if (!ui.key && groups.length) ui.key = groups[0].key;

  root.innerHTML = `
    <div class="page">
      <header class="page-head">
        <div>
          <h1 class="page-title">Review</h1>
          <p class="page-sub">Questions that look alike, side by side. Pick the standard answer, link related questions, or dismiss false matches.</p>
        </div>
        <div class="tabs" role="tablist" aria-label="Review mode">
          ${tab('suggested', `Suggested · ${groups.length}`)}
          ${tab('pick', 'Compare any questions')}
          ${tab('resolved', `Resolved · ${resolved.length}`)}
        </div>
      </header>
      <div role="tabpanel">${ui.tab === 'pick' ? pickTab() : ui.tab === 'resolved' ? resolvedTab(resolved) : suggestedTab(groups)}</div>
    </div>`;
  wirePicker();
}

const tab = (id, label) =>
  `<button type="button" class="tab" role="tab" data-tab="${id}" aria-selected="${ui.tab === id}">${esc(label)}</button>`;

// ---------- Suggested ----------
function suggestedTab(groups) {
  if (!groups.length) {
    return `<div class="card empty"><strong>Nothing to review</strong>
      <span>No questions currently match at ${state.config.matchThreshold}% or higher.</span>
      <a href="#/rules">Adjust matching rules</a></div>`;
  }
  const g = groups.find((x) => x.key === ui.key);
  return `
    <div class="review-layout">
      <section class="queue" aria-label="Suggestions">
        <span class="queue-label">Sorted by closest match</span>
        ${groups.map((x) => `
          <button type="button" class="queue-item" data-key="${x.key}" aria-current="${x.key === ui.key}">
            <span class="queue-meta"><span>${pluralize(x.ids.length, 'question')} · ${esc(x.askers.length > 1 ? `${x.askers.length} prospects` : x.askers[0])}</span><span class="mono">${x.score}%</span></span>
            <span class="queue-title">${esc(x.title)}</span>
            ${x.topics.length > 1 ? '<span class="queue-note">Filed under different categories</span>' : ''}
          </button>`).join('')}
        <p class="queue-foot">${getIndex().mode === 'meaning' ? `Matched by meaning at ${state.config.semanticThreshold}% or higher.` : `Matched by shared words at ${state.config.matchThreshold}% or higher (smart matching isn’t active).`} <a href="#/rules">Change matching rules</a></p>
      </section>
      ${compareBlock(g.ids, g)}
    </div>`;
}

// ---------- Pick any ----------
function pickTab() {
  const chosen = ui.pick.map(getItem).filter(Boolean);
  return `
    <div class="compare" style="max-width:none">
      <div class="card" style="display:flex;flex-direction:column;gap:12px">
        <div class="toolbar" style="justify-content:space-between">
          <span class="section-title">Choose 2 or 3 questions</span>
          <button type="button" class="btn btn-sm" data-act="best-pair">Find the most similar pair</button>
        </div>
        ${chosen.length < 3 ? `
        <div class="picker">
          <label class="search" style="height:44px">
            ${icon('search')}
            <span class="visually-hidden">Add a question to compare</span>
            <input type="text" id="picker-input" role="combobox" aria-expanded="false" aria-controls="picker-list" aria-autocomplete="list"
              placeholder="Search by keyword or #id to add a question" autocomplete="off">
          </label>
          <ul class="picker-results" id="picker-list" role="listbox" hidden></ul>
        </div>` : ''}
        ${chosen.length ? `<div class="toolbar">${chosen.map((c) => `
          <span class="chip" style="cursor:default">#${c.id} ${esc(c.question.slice(0, 48))}${c.question.length > 48 ? '…' : ''}
            <button type="button" class="link-btn" data-remove="${c.id}" aria-label="Remove #${c.id}">${icon('x', 'icon-sm')}</button></span>`).join('')}</div>` : ''}
      </div>
      ${chosen.length >= 2 ? compareBlock(chosen.map((c) => c.id), null)
        : '<div class="card empty"><strong>Add at least two questions</strong><span>The score breakdown, coaching notes and standard-answer tools appear here.</span></div>'}
    </div>`;
}

// ---------- Resolved ----------
function resolvedTab(list) {
  if (!list.length) return '<div class="card empty"><strong>Nothing resolved yet</strong><span>Decisions you make in Suggested are listed here so they can be reopened.</span></div>';
  const label = { dismissed: 'Dismissed as not related', linked: 'Linked as related', standard: 'Standard answer chosen' };
  return `<div class="card table-wrap"><table class="table">
    <thead><tr><th>Questions</th><th>Decision</th><th>By</th><th>When</th><th><span class="visually-hidden">Actions</span></th></tr></thead>
    <tbody>${[...list].reverse().map((r) => `<tr>
      <td>${r.ids.map((id) => { const it = getItem(id); return `<div><a href="#/library/${id}">#${id}</a> ${esc(it ? it.question : '(deleted)')}</div>`; }).join('')}</td>
      <td>${esc(label[r.action] || r.action)}${r.standardId ? ` (#${r.standardId})` : ''}</td>
      <td>${esc(r.by || '')}</td><td>${esc(relTime(r.at))}</td>
      <td><button type="button" class="btn btn-sm" data-reopen="${esc(r.key)}">Reopen</button></td>
    </tr>`).join('')}</tbody></table></div>`;
}

// ---------- Shared comparison ----------
function compareBlock(ids, group) {
  const idx = getIndex();
  const items = ids.map(getItem).filter(Boolean);
  const k = group ? group.key : `pick:${ids.join('-')}`;

  const pairs = [];
  for (let a = 0; a < items.length; a++) for (let b = a + 1; b < items.length; b++) {
    pairs.push({ a: items[a], b: items[b], ...idx.compare(items[a].id, items[b].id) });
  }
  const best = [...pairs].sort((p, q) => q.score - p.score)[0];

  const existingStd = items.find((i) => i.standard);
  const longest = [...items].sort((a, b) => wordCount(b.answer) - wordCount(a.answer))[0];
  const stdId = ui.std[k] ?? existingStd?.id ?? longest.id;
  const stdItem = items.find((i) => i.id === stdId) || longest;
  const draft = ui.drafts[k] ?? stdItem.answer;
  const th = idx.threshold;
  const strength = best.score >= th + 15 ? 'strong match' : best.score >= th ? 'likely related' : 'weak match';
  const meaning = best.mode === 'meaning';
  const existingTheme = items[0].themeId && items.every((i) => i.themeId === items[0].themeId) ? state.config.themes.find((t) => t.id === items[0].themeId) : null;
  const themeName = ui.names[k] ?? (existingTheme?.name || (group ? group.title : [...items].sort((a, b) => a.question.length - b.question.length)[0].question).replace(/\?$/, ''));

  return `
    <section class="compare" aria-label="Comparison">
      <div class="card score-card">
        <div class="score-big"><strong>${best.score}%</strong><span>${meaning ? 'meaning match' : 'word match'}, ${strength} (#${best.a.id} and #${best.b.id})</span></div>
        <div class="terms-wrap"><span>Shared words</span>
          <div class="terms">${best.shared.length ? best.shared.map((t) => `<span class="term">${esc(displayTerm(t, `${best.a.question} ${best.b.question}`, state.config.synonyms))}</span>`).join('') : '<span class="muted">None</span>'}</div>
        </div>
        <details class="how">
          <summary>How this is scored</summary>
          <table class="how-table">
            <thead><tr><th>Pair</th>${meaning ? '<th>Meaning</th>' : ''}<th>Word score</th><th>Overlap</th><th>Jaccard</th></tr></thead>
            <tbody>${pairs.map((p) => `<tr><td>#${p.a.id} · #${p.b.id}</td>${meaning ? `<td>${p.score}%</td>` : ''}<td>${p.wordScore}%</td><td>${p.overlap}%</td><td>${p.jaccard}%</td></tr>`).join('')}</tbody>
          </table>
          <p class="field-hint" style="margin-top:8px">${meaning
            ? `The meaning score comes from an AI model that reads each question and answer (account and rep names removed). ${th}% or higher counts as related.`
            : `Word score = overlap × ${state.config.overlapRatio}% + Jaccard × ${state.config.jaccardRatio}%. Pairs with fewer than ${state.config.minShared} shared words score 0.`}</p>
        </details>
      </div>

      <div class="cmp-grid" style="--cols:${items.length}">
        ${items.map((it) => {
          const vs = it.id === best.a.id ? best.b : best.a;
          const sc = idx.compare(it.id, vs.id).score;
          const isStd = it.id === stdItem.id;
          return `<article class="cmp-card" data-std="${isStd}">
            <div class="cmp-top"><a class="mono" href="#/library/${it.id}">#${it.id}</a>
              ${isStd ? '<span class="badge badge-ok">Approved answer</span>' : `<span>${sc}% to #${vs.id}</span>`}</div>
            <h3 class="cmp-q">${esc(it.question)}</h3>
            <p class="cmp-a">${esc(it.answer)}</p>
            <div class="cmp-foot"><span>${esc(it.askedBy)} → ${esc(it.answeredBy)}</span><span>${pluralize(wordCount(it.answer), 'word')} · ${esc(it.topic)}</span></div>
            <label class="radio-line"><input type="radio" name="std-${esc(k)}" value="${it.id}" data-std-key="${esc(k)}" ${isStd ? 'checked' : ''}>Use this answer</label>
          </article>`;
        }).join('')}
      </div>

      <div class="two-col">
        <div class="card notes">
          <h3 class="section-title">Coaching notes</h3>
          ${coachingNotes(items).map((n) => `<div class="note" data-tone="${n.tone}"><span>${n.html}</span></div>`).join('')}
        </div>
        <div class="card" style="display:flex;flex-direction:column;gap:10px">
          <div class="field"><label class="field-label" for="theme-name">Theme name</label>
            <input class="input" id="theme-name" data-name="${esc(k)}" value="${esc(themeName)}"></div>
          <div class="section-head"><label class="section-title" for="std-draft">Approved answer</label><span class="field-hint">Edit before saving</span></div>
          <textarea class="textarea" id="std-draft" data-draft="${esc(k)}" rows="4">${esc(draft)}</textarea>
          <span class="field-hint">Saved to #${stdItem.id}. All ${items.length} questions join this theme.</span>
        </div>
      </div>

      <div class="actions-bar">
        ${group ? `<button type="button" class="btn btn-lg" data-act="dismiss">Not related, dismiss</button>` : ''}
        <button type="button" class="btn btn-lg" data-act="link" data-ids="${ids.join(',')}">Keep separate, link them</button>
        <button type="button" class="btn btn-primary btn-lg" data-act="standard" data-ids="${ids.join(',')}" data-std="${stdItem.id}" data-k="${esc(k)}" data-theme="${esc(existingTheme?.id || '')}">Approve answer and save theme</button>
      </div>
    </section>`;
}

/** Same checks as the original Training & Consistency Insights, extended to 3 questions. */
function coachingNotes(items) {
  const notes = [];
  const reps = [...new Set(items.map((i) => canonicalRep(i.answeredBy).toLowerCase()))];
  const topics = [...new Set(items.map((i) => i.topic.trim().toLowerCase()))];
  const sameRep = reps.length === 1;
  const sameTopic = topics.length === 1;
  const words = items.map((i) => wordCount(i.answer));
  const uniq = (xs) => [...new Set(xs)];
  const th = state.config.shortWordThreshold || 15;

  notes.push(sameRep
    ? { tone: 'ok', html: `All answered by <strong>${esc(items[0].answeredBy)}</strong>, so wording should be consistent.` }
    : { tone: 'info', html: `Answered by different reps: ${uniq(items.map((i) => i.answeredBy)).map((r) => `<strong>${esc(r)}</strong>`).join(', ')}. Check the answers agree.` });
  notes.push(sameTopic
    ? { tone: 'ok', html: `All filed under <strong>${esc(items[0].topic)}</strong>.` }
    : { tone: 'warn', html: `Filed under different categories (${uniq(items.map((i) => i.topic)).map(esc).join(' vs ')}). Consider moving them together.` });

  const verdicts = items.map((i) => (/^\s*(yes|no)\b/i.exec(i.answer)?.[1] || '').toLowerCase()).filter(Boolean);
  if (new Set(verdicts).size > 1) notes.push({ tone: 'warn', html: 'One answer starts with “Yes” and another with “No”. Make sure they don’t contradict each other.' });

  for (const r of state.config.customRules.filter((x) => x.enabled)) {
    const lower = r.text.toLowerCase();
    let hit = false, extra = '';
    if (r.id === 1 || lower.includes('brevity') || lower.includes('word threshold')) {
      if (words.some((w) => w < th)) { hit = true; extra = ` (${words.join(' vs ')} words, threshold ${th})`; }
    } else if (r.id === 2 || lower.includes('multi-rep') || lower.includes('different representative')) {
      if (!sameRep) { hit = true; extra = ` (${uniq(items.map((i) => i.answeredBy)).join(' vs ')})`; }
    } else if (lower.includes('same representative') || lower.includes('same rep')) {
      if (sameRep) { hit = true; extra = ` (handled by ${items[0].answeredBy})`; }
    } else if (r.id === 3 || lower.includes('cross-topic') || lower.includes('cross-category')) {
      if (!sameTopic) { hit = true; extra = ` (${uniq(items.map((i) => i.topic)).join(' vs ')})`; }
    } else if (r.text.trim().length > 10) {
      hit = true;
    }
    if (hit) notes.push({ tone: 'warn', html: `${esc(r.text)}${esc(extra)}` });
  }
  return notes;
}

// ---------- Events ----------
async function onClick(e) {
  const t = e.target;
  const tabBtn = t.closest('[data-tab]');
  if (tabBtn) { ui.tab = tabBtn.dataset.tab; history.replaceState(null, '', `#/review?tab=${ui.tab}`); update(); return; }

  const q = t.closest('[data-key]');
  if (q) { ui.key = q.dataset.key; update(); root.querySelector('.compare')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); return; }

  const rm = t.closest('[data-remove]');
  if (rm) { ui.pick = ui.pick.filter((id) => id !== Number(rm.dataset.remove)); update(); return; }

  const opt = t.closest('[data-pick]');
  if (opt) { addPick(Number(opt.dataset.pick)); return; }

  const re = t.closest('[data-reopen]');
  if (re) { if (await reopenGroup(re.dataset.reopen)) toast('Moved back to Suggested'); return; }

  const actBtn = t.closest('[data-act]');
  if (!actBtn) return;
  const act = actBtn.dataset.act;
  const group = openGroups().find((g) => g.key === ui.key);

  if (act === 'best-pair') {
    const idx = getIndex();
    let best = idx.allPairs()[0];
    if (!best) {
      // Nothing above the threshold: fall back to the closest pair overall.
      const ids = state.items.map((i) => i.id);
      for (let a = 0; a < ids.length; a++) for (let b = a + 1; b < ids.length; b++) {
        const s = idx.compare(ids[a], ids[b]).score;
        if (!best || s > best.score) best = { a: ids[a], b: ids[b], score: s };
      }
    }
    if (best) { ui.pick = [best.a, best.b]; update(); }
    return;
  }
  if (act === 'dismiss' && ui.tab === 'suggested' && group) {
    if (await dismissGroup(group)) toast('Dismissed. Find it under Resolved if you change your mind.');
    return;
  }
  const ids = (actBtn.dataset.ids || '').split(',').map(Number).filter(Boolean);
  const key = ui.tab === 'suggested' && group ? group.key : null;
  if (act === 'link') {
    if (await linkQuestions(ids, key)) toast(`Linked ${pluralize(ids.length, 'question')}`);
    return;
  }
  if (act === 'standard') {
    const k = actBtn.dataset.k;
    const text = root.querySelector('#std-draft')?.value ?? '';
    const name = (root.querySelector('#theme-name')?.value || '').trim() || 'Untitled theme';
    if (await saveStandard(ids, Number(actBtn.dataset.std), text, key, name, actBtn.dataset.theme || uid('theme'))) {
      delete ui.drafts[k];
      delete ui.names[k];
      toast(`Saved “${name}” with #${actBtn.dataset.std} as the approved answer`);
    }
  }
}

function onChange(e) {
  const r = e.target.closest('[data-std-key]');
  if (r) {
    const k = r.dataset.stdKey;
    ui.std[k] = Number(r.value);
    delete ui.drafts[k]; // load the newly chosen answer into the editor
    update();
  }
}

function addPick(id) {
  if (!ui.pick.includes(id) && ui.pick.length < 3) ui.pick.push(id);
  update();
  root.querySelector('#picker-input')?.focus();
}

function wirePicker() {
  const input = root.querySelector('#picker-input');
  const list = root.querySelector('#picker-list');
  if (!input) return;
  let active = 0;
  let results = [];

  const render = () => {
    const q = input.value.trim().toLowerCase();
    if (!q) { list.hidden = true; input.setAttribute('aria-expanded', 'false'); return; }
    const idq = /^#?(\d+)$/.exec(q);
    results = state.items
      .filter((i) => !ui.pick.includes(i.id) && (idq ? String(i.id).startsWith(idq[1]) : `${i.question} ${i.askedBy}`.toLowerCase().includes(q)))
      .slice(0, 8);
    active = Math.min(active, Math.max(results.length - 1, 0));
    list.innerHTML = results.length
      ? results.map((i, n) => `<li class="picker-option" role="option" id="pk-${i.id}" data-pick="${i.id}" aria-selected="${n === active}">
          <span class="mono">#${i.id}</span><span>${esc(i.question)}</span></li>`).join('')
      : '<li class="picker-option" aria-disabled="true">No matching questions</li>';
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    if (results[active]) input.setAttribute('aria-activedescendant', `pk-${results[active].id}`);
  };

  input.addEventListener('input', () => { active = 0; render(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, results.length - 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); render(); }
    else if (e.key === 'Enter' && results[active]) { e.preventDefault(); addPick(results[active].id); }
    else if (e.key === 'Escape') { input.value = ''; render(); }
  });
  list.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus so the click lands
  input.addEventListener('blur', () => setTimeout(() => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); }, 150));
}
