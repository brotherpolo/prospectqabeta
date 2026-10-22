// Matching rules: how related questions are found, checked against an answer key from your own data.

import { state, updateConfig, DEFAULT_CONFIG, getItem, currentVectors, semanticStatus } from './store.js';
import { createIndex } from './similarity.js';
import { toast, toastError } from './ui.js';
import { esc, icon, debounce, pluralize } from './utils.js';

let root = null;
let draft = {};

const WORD_SLIDERS = [
  { key: 'overlapRatio', label: 'Overlap weight', min: 0, max: 100, unit: '%', hint: 'How much a short question being covered by a longer one counts. Jaccard (shared vocabulary) gets the rest.' },
  { key: 'matchThreshold', label: 'Word match threshold', min: 15, max: 80, unit: '%', hint: 'Used only when smart matching is off or still loading.' },
  { key: 'minShared', label: 'Minimum shared words', min: 1, max: 4, unit: '', hint: 'Stops short questions from matching on a single common word.' },
];

export function mount(el) {
  root = el;
  draft = {};
  el.innerHTML = `
    <div class="page">
      <header class="page-head">
        <div>
          <h1 class="page-title">Matching rules</h1>
          <p class="page-sub">How related questions are found, and how well it’s working on your data. Changes save automatically for everyone.</p>
        </div>
        <button type="button" class="btn" data-act="reset">Reset to defaults</button>
      </header>

      <div class="rules-layout">
        <div class="stack">
          <section class="card">
            <div class="card-head"><h2 class="card-title">Smart matching</h2><span class="sem-state" data-sem></span></div>
            <label class="radio-line"><input type="checkbox" class="switch" data-toggle-sem>Match questions by meaning</label>
            <p class="field-hint">An open AI model (all-MiniLM-L6-v2) runs in your browser, so questions never leave it. It downloads once (about 23 MB) and is cached. Account, contact and rep names are removed first, so questions don’t match just because they mention the same prospect.</p>
            <div class="range-field">
              <div class="range-top"><label for="r-semanticThreshold">Related at</label><output id="o-semanticThreshold"></output></div>
              <input type="range" id="r-semanticThreshold" data-key="semanticThreshold" min="25" max="75" step="1">
              <p class="field-hint">Questions scoring at or above this are grouped into themes and suggested for review. Check the effect in Matching check.</p>
            </div>
            <div class="range-field">
              <div class="range-top"><label for="r-shortWordThreshold">Brief answer threshold</label><output id="o-shortWordThreshold"></output></div>
              <input type="range" id="r-shortWordThreshold" data-key="shortWordThreshold" min="5" max="40" step="1">
              <p class="field-hint">Answers shorter than this are flagged as brief.</p>
            </div>
            <div class="field">
              <span class="field-label">Words to ignore when matching</span>
              <div class="toolbar" data-ignore></div>
              <form class="add-row" data-form="ignore">
                <label class="visually-hidden" for="ignore-word">Word to ignore</label>
                <input class="input" id="ignore-word" placeholder="Your product or company name">
                <button class="btn" type="submit">${icon('plus', 'icon-sm')}Add</button>
              </form>
            </div>
          </section>

          <section class="card">
            <div class="card-head"><h2 class="card-title">Matching check</h2><span class="field-hint">Pairs you’ve marked related or not, scored now</span></div>
            <div class="preview-box" data-check-summary aria-live="polite"></div>
            <div class="table-wrap"><table class="table check-table" data-check></table></div>
            <form class="add-row" data-form="pair" style="margin-top:12px">
              <label class="visually-hidden" for="pair-a">First question number</label>
              <input class="input" id="pair-a" placeholder="#" inputmode="numeric" style="max-width:80px">
              <label class="visually-hidden" for="pair-b">Second question number</label>
              <input class="input" id="pair-b" placeholder="#" inputmode="numeric" style="max-width:80px">
              <label class="visually-hidden" for="pair-rel">Are they related?</label>
              <select class="select" id="pair-rel" style="max-width:160px"><option value="1">Related</option><option value="0">Not related</option></select>
              <button class="btn" type="submit">${icon('plus', 'icon-sm')}Add pair</button>
            </form>
            <p class="field-hint" style="margin-top:8px">Decisions in Review add pairs automatically: approving or linking marks them related, dismissing marks them not related.</p>
          </section>
        </div>

        <div class="stack">
          <section class="card">
            <div class="card-head"><h2 class="card-title">Word matching</h2><span class="field-hint">Fallback when smart matching is off or loading</span></div>
            ${WORD_SLIDERS.map((s) => `
              <div class="range-field">
                <div class="range-top"><label for="r-${s.key}">${s.label}</label><output id="o-${s.key}"></output></div>
                <input type="range" id="r-${s.key}" data-key="${s.key}" min="${s.min}" max="${s.max}" step="1">
                <p class="field-hint">${s.hint}</p>
              </div>`).join('')}
          </section>

          <section class="card">
            <div class="card-head"><h2 class="card-title">Abbreviations</h2><span class="field-hint">Treated as the same words in word matching</span></div>
            <div class="rule-list" data-syn></div>
            <form class="add-row" data-form="syn">
              <label class="visually-hidden" for="syn-term">Abbreviation</label>
              <input class="input" id="syn-term" placeholder="PTP" style="max-width:110px">
              <label class="visually-hidden" for="syn-means">Means</label>
              <input class="input" id="syn-means" placeholder="pre-task plan">
              <button class="btn" type="submit">${icon('plus', 'icon-sm')}Add</button>
            </form>
          </section>

          <section class="card">
            <div class="card-head"><h2 class="card-title">Coaching rules</h2><span class="field-hint">Shown as notes when comparing questions</span></div>
            <div class="rule-list" data-rules></div>
            <form class="add-row" data-form="rule">
              <label class="visually-hidden" for="rule-text">New coaching rule</label>
              <input class="input" id="rule-text" placeholder="e.g. Mention offline mode when mobile comes up">
              <button class="btn" type="submit">${icon('plus', 'icon-sm')}Add</button>
            </form>
            <p class="field-hint" style="margin-top:10px">Rules mentioning “brevity”, “different representative”, “same rep” or “cross-topic” only appear when that condition is true. Other rules always show as reminders.</p>
          </section>
        </div>
      </div>
    </div>`;

  const save = debounce(() => { const patch = { ...draft }; draft = {}; updateConfig(patch); }, 600);
  el.oninput = (e) => {
    const k = e.target.dataset.key;
    if (!k) return;
    draft[k] = Number(e.target.value);
    if (k === 'overlapRatio') draft.jaccardRatio = 100 - draft[k];
    paintSliders();
    paintCheck();
    save();
  };
  el.onclick = onClick;
  el.onsubmit = onSubmit;
  el.onchange = (e) => {
    if (e.target.matches('[data-toggle-sem]')) updateConfig({ semanticMatching: e.target.checked });
  };
  update();
}

const cfg = () => ({ ...state.config, ...draft });
const ALL_KEYS = ['semanticThreshold', 'shortWordThreshold', ...WORD_SLIDERS.map((s) => s.key)];

function paintSliders() {
  const c = cfg();
  for (const key of ALL_KEYS) {
    const input = root.querySelector(`#r-${key}`);
    if (document.activeElement !== input) input.value = c[key];
    root.querySelector(`#o-${key}`).textContent =
      key === 'overlapRatio' ? `${c.overlapRatio}% / Jaccard ${c.jaccardRatio}%`
        : key === 'minShared' ? `${c[key]}` : key === 'shortWordThreshold' ? `${c[key]} words` : `${c[key]}%`;
  }
}

/** Score the answer key at the current settings and recommend a threshold. */
const paintCheck = debounce(() => {
  if (!root) return;
  const c = cfg();
  const vectors = currentVectors();
  const idx = createIndex(state.items, c, vectors);
  const pairs = (state.config.matchCheck || []).filter((p) => getItem(p.a) && getItem(p.b));
  const scored = pairs.map((p) => ({ ...p, score: idx.compare(p.a, p.b).score }));
  const th = idx.threshold;
  const rel = scored.filter((p) => p.related), unrel = scored.filter((p) => !p.related);
  const tp = rel.filter((p) => p.score >= th).length, fp = unrel.filter((p) => p.score >= th).length;

  let rec = null;
  if (rel.length && unrel.length) {
    const lo = idx.mode === 'meaning' ? 25 : 15, hi = idx.mode === 'meaning' ? 75 : 80;
    let best = -1; let range = [];
    for (let t = lo; t <= hi; t++) {
      const correct = rel.filter((p) => p.score >= t).length + unrel.filter((p) => p.score < t).length;
      if (correct > best) { best = correct; range = [t]; } else if (correct === best) range.push(t);
    }
    rec = Math.max(range[range.length - 1], th - 5); // strictest best fit, moving at most 5 points at a time
  }
  const groups = idx.groups();
  root.querySelector('[data-check-summary]').innerHTML = scored.length ? `
    Matching by <strong>${idx.mode === 'meaning' ? 'meaning' : 'shared words'}</strong> at ${th}%:
    finds <strong>${tp} of ${rel.length}</strong> related pairs and wrongly matches <strong>${fp} of ${unrel.length}</strong> unrelated ones.
    Groups ${pluralize(groups.reduce((s, g) => s + g.ids.length, 0), 'question')} into ${pluralize(groups.length, 'theme')}.
    ${scored.length < 30
      ? `<div class="field-hint" style="margin-top:6px">${pluralize(scored.length, 'pair')} is too few to tune the threshold reliably. Decisions in Review add pairs; a recommendation appears at 30.</div>`
      : rec != null && rec !== th ? `<div style="margin-top:8px"><button type="button" class="btn btn-sm" data-act="use-rec" data-rec="${rec}">Use ${rec}%, the best fit for these ${scored.length} pairs</button></div>`
        : rec != null ? '<div class="ok-text" style="margin-top:6px">✓ This is the best-fitting threshold for your answer key.</div>' : ''}`
    : 'No pairs yet. Add a few you know are related or unrelated, or make decisions in Review.';
  root.querySelector('[data-check]').innerHTML = scored.length ? `
    <thead><tr><th>Questions</th><th>Marked</th><th class="num">Score</th><th>Result</th><th><span class="visually-hidden">Remove</span></th></tr></thead>
    <tbody>${scored.map((p, n) => {
      const ok = (p.score >= th) === p.related;
      return `<tr><td><a href="#/library/${p.a}">#${p.a}</a> ${esc(getItem(p.a).question.slice(0, 60))}<br><a href="#/library/${p.b}">#${p.b}</a> ${esc(getItem(p.b).question.slice(0, 60))}</td>
        <td>${p.related ? 'Related' : 'Not related'}</td><td class="num mono">${p.score}%</td>
        <td class="${ok ? 'ok-text' : 'warn-text'}">${ok ? '✓ Correct' : p.related ? 'Missed' : 'Wrong match'}</td>
        <td><button type="button" class="icon-btn" data-del-pair="${n}" aria-label="Remove this pair">${icon('trash', 'icon-sm')}</button></td></tr>`;
    }).join('')}</tbody>` : '';
}, 60);

export function update() {
  if (!root) return;
  const c = state.config;
  const sem = semanticStatus();
  const semEl = root.querySelector('[data-sem]');
  const on = c.semanticMatching !== false;
  root.querySelector('[data-toggle-sem]').checked = on;
  semEl.className = `sem-state ${!on ? '' : sem.state === 'ready' ? 'ok-text' : sem.state === 'error' ? 'warn-text' : ''}`;
  semEl.textContent = !on ? 'Off' : sem.state === 'ready' ? '✓ On'
    : sem.state === 'error' ? `Couldn’t load: ${sem.message || 'unknown error'}` : `Loading model${sem.progress ? ` ${sem.progress}%` : '…'}`;
  paintSliders();
  paintCheck();
  root.querySelector('[data-ignore]').innerHTML = c.ignoreWords.length
    ? c.ignoreWords.map((w, i) => `<span class="chip" style="cursor:default">${esc(w)}<button type="button" class="link-btn" data-del-ignore="${i}" aria-label="Remove ${esc(w)}">${icon('x', 'icon-sm')}</button></span>`).join('')
    : '<span class="muted">None</span>';
  root.querySelector('[data-syn]').innerHTML = c.synonyms.length
    ? c.synonyms.map((s, i) => `<div class="rule-item"><span class="grow"><strong>${esc(s.term)}</strong> = ${esc(s.means)}</span>
        <button type="button" class="icon-btn" data-del-syn="${i}" aria-label="Remove ${esc(s.term)}">${icon('trash', 'icon-sm')}</button></div>`).join('')
    : '<p class="muted">None yet.</p>';
  root.querySelector('[data-rules]').innerHTML = c.customRules.length
    ? c.customRules.map((r) => `<div class="rule-item ${r.enabled ? '' : 'off'}">
        <input type="checkbox" class="switch" data-toggle-rule="${r.id}" ${r.enabled ? 'checked' : ''} aria-label="Turn rule on or off">
        <span class="grow">${esc(r.text)}</span>
        <button type="button" class="icon-btn" data-del-rule="${r.id}" aria-label="Delete rule">${icon('trash', 'icon-sm')}</button></div>`).join('')
    : '<p class="muted">No rules yet.</p>';
}

async function onClick(e) {
  const t = e.target;
  const c = state.config;
  if (t.closest('[data-act="reset"]')) {
    draft = {};
    const d = DEFAULT_CONFIG;
    await updateConfig({
      overlapRatio: d.overlapRatio, jaccardRatio: d.jaccardRatio, matchThreshold: d.matchThreshold, minShared: d.minShared,
      shortWordThreshold: d.shortWordThreshold, semanticThreshold: d.semanticThreshold, semanticMatching: true,
    });
    toast('Settings reset to defaults');
    return;
  }
  const useRec = t.closest('[data-act="use-rec"]');
  if (useRec) {
    const key = currentVectors() ? 'semanticThreshold' : 'matchThreshold';
    if (await updateConfig({ [key]: Number(useRec.dataset.rec) })) toast(`Threshold set to ${useRec.dataset.rec}%`);
    return;
  }
  const tog = t.closest('[data-toggle-rule]');
  if (tog) { const id = Number(tog.dataset.toggleRule); updateConfig({ customRules: c.customRules.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r)) }); return; }
  const del = t.closest('[data-del-rule]');
  if (del) { const id = Number(del.dataset.delRule); updateConfig({ customRules: c.customRules.filter((r) => r.id !== id) }); return; }
  const ds = t.closest('[data-del-syn]');
  if (ds) { updateConfig({ synonyms: c.synonyms.filter((_, i) => i !== Number(ds.dataset.delSyn)) }); return; }
  const di = t.closest('[data-del-ignore]');
  if (di) { updateConfig({ ignoreWords: c.ignoreWords.filter((_, i) => i !== Number(di.dataset.delIgnore)) }); return; }
  const dp = t.closest('[data-del-pair]');
  if (dp) {
    const live = (c.matchCheck || []).filter((p) => getItem(p.a) && getItem(p.b));
    const target = live[Number(dp.dataset.delPair)];
    updateConfig({ matchCheck: (c.matchCheck || []).filter((p) => p !== target) });
  }
}

async function onSubmit(e) {
  e.preventDefault();
  const c = state.config;
  const form = e.target.dataset.form;
  if (form === 'rule') {
    const inp = root.querySelector('#rule-text');
    const text = inp.value.trim();
    if (!text) return;
    const id = c.customRules.reduce((m, r) => Math.max(m, r.id), 0) + 1;
    inp.value = '';
    if (await updateConfig({ customRules: [...c.customRules, { id, text, enabled: true }] })) toast('Rule added');
  } else if (form === 'syn') {
    const term = root.querySelector('#syn-term').value.trim();
    const means = root.querySelector('#syn-means').value.trim();
    if (!term || !means) return;
    root.querySelector('#syn-term').value = '';
    root.querySelector('#syn-means').value = '';
    if (await updateConfig({ synonyms: [...c.synonyms.filter((s) => s.term.toLowerCase() !== term.toLowerCase()), { term, means }] })) toast(`${term} added`);
  } else if (form === 'ignore') {
    const inp = root.querySelector('#ignore-word');
    const w = inp.value.trim();
    if (!w || c.ignoreWords.includes(w)) return;
    inp.value = '';
    updateConfig({ ignoreWords: [...c.ignoreWords, w] });
  } else if (form === 'pair') {
    const a = Number(root.querySelector('#pair-a').value.replace('#', ''));
    const b = Number(root.querySelector('#pair-b').value.replace('#', ''));
    if (!getItem(a) || !getItem(b) || a === b) { toastError('Enter two different question numbers from the Library.'); return; }
    const related = root.querySelector('#pair-rel').value === '1';
    const rest = (c.matchCheck || []).filter((p) => !((p.a === a && p.b === b) || (p.a === b && p.b === a)));
    root.querySelector('#pair-a').value = '';
    root.querySelector('#pair-b').value = '';
    if (await updateConfig({ matchCheck: [...rest, { a, b, related }] })) toast('Pair added to the check');
  }
}
