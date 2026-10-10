// Matching rules: replaces the Insights Engine page. Weights now drive every match in the app.

import { state, updateConfig, DEFAULT_CONFIG } from '../store.js';
import { createIndex } from '../similarity.js';
import { toast } from '../ui.js';
import { esc, icon, debounce, pluralize } from '../utils.js';

let root = null;
let draft = {};

const SLIDERS = [
  { key: 'overlapRatio', label: 'Overlap weight', min: 0, max: 100, unit: '%',
    hint: 'How much a short question being covered by a longer one counts. Jaccard (shared vocabulary) gets the rest.' },
  { key: 'matchThreshold', label: 'Match threshold', min: 15, max: 80, unit: '%',
    hint: 'Questions scoring at or above this are suggested for review and grouped into themes.' },
  { key: 'minShared', label: 'Minimum shared terms', min: 1, max: 4, unit: '',
    hint: 'Stops short questions from matching on a single common word.' },
  { key: 'shortWordThreshold', label: 'Brief answer threshold', min: 5, max: 40, unit: ' words',
    hint: 'Answers shorter than this are flagged “Brief answer” and trigger the brevity coaching rule.' },
];

export function mount(el) {
  root = el;
  draft = {};
  el.innerHTML = `
    <div class="page">
      <header class="page-head">
        <div>
          <h1 class="page-title">Matching rules</h1>
          <p class="page-sub">Controls how similar questions are found and which coaching notes appear in Review. Changes save automatically for everyone.</p>
        </div>
        <button type="button" class="btn" data-act="reset">Reset to defaults</button>
      </header>

      <div class="rules-layout">
        <section class="card">
          <div class="card-head"><h2 class="card-title">Scoring</h2></div>
          ${SLIDERS.map((s) => `
            <div class="range-field">
              <div class="range-top"><label for="r-${s.key}">${s.label}</label><output id="o-${s.key}" for="r-${s.key}"></output></div>
              <input type="range" id="r-${s.key}" data-key="${s.key}" min="${s.min}" max="${s.max}" step="1">
              <p class="field-hint">${s.hint}</p>
            </div>`).join('')}
          <div class="preview-box" data-preview aria-live="polite"></div>
        </section>

        <div style="display:flex;flex-direction:column;gap:16px">
          <section class="card">
            <div class="card-head"><h2 class="card-title">Abbreviations</h2><span class="field-hint">Treated as the same words when matching</span></div>
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

  const save = debounce(() => {
    const patch = { ...draft };
    draft = {};
    updateConfig(patch);
  }, 600);

  el.oninput = (e) => {
    const k = e.target.dataset.key;
    if (!k) return;
    draft[k] = Number(e.target.value);
    if (k === 'overlapRatio') draft.jaccardRatio = 100 - draft[k];
    paintSliders();
    paintPreview();
    save();
  };
  el.onclick = onClick;
  el.onsubmit = onSubmit;
  update();
}

const cfg = () => ({ ...state.config, ...draft });

function paintSliders() {
  const c = cfg();
  for (const s of SLIDERS) {
    const input = root.querySelector(`#r-${s.key}`);
    if (document.activeElement !== input) input.value = c[s.key];
    root.querySelector(`#o-${s.key}`).textContent =
      s.key === 'overlapRatio' ? `${c.overlapRatio}% / Jaccard ${c.jaccardRatio}%` : `${c[s.key]}${s.unit}`;
  }
}

const paintPreview = debounce(() => {
  if (!root) return;
  const c = cfg();
  const idx = createIndex(state.items, c);
  const groups = idx.groups();
  const brief = state.items.filter((i) => (i.answer || '').trim().split(/\s+/).length < c.shortWordThreshold).length;
  root.querySelector('[data-preview]').innerHTML =
    `With these settings: <strong>${pluralize(idx.allPairs().length, 'matching pair')}</strong> forming
     <strong>${pluralize(groups.length, 'group')}</strong>, and <strong>${brief}</strong> answers flagged as brief.`;
}, 80);

export function update() {
  if (!root) return;
  const c = state.config;
  paintSliders();
  paintPreview();
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
    await updateConfig({ overlapRatio: d.overlapRatio, jaccardRatio: d.jaccardRatio, matchThreshold: d.matchThreshold, minShared: d.minShared, shortWordThreshold: d.shortWordThreshold });
    toast('Scoring reset to defaults');
    return;
  }
  const tog = t.closest('[data-toggle-rule]');
  if (tog) {
    const id = Number(tog.dataset.toggleRule);
    updateConfig({ customRules: c.customRules.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r)) });
    return;
  }
  const del = t.closest('[data-del-rule]');
  if (del) {
    const id = Number(del.dataset.delRule);
    updateConfig({ customRules: c.customRules.filter((r) => r.id !== id) });
    return;
  }
  const ds = t.closest('[data-del-syn]');
  if (ds) updateConfig({ synonyms: c.synonyms.filter((_, i) => i !== Number(ds.dataset.delSyn)) });
}

async function onSubmit(e) {
  e.preventDefault();
  const c = state.config;
  if (e.target.dataset.form === 'rule') {
    const inp = root.querySelector('#rule-text');
    const text = inp.value.trim();
    if (!text) return;
    const id = c.customRules.reduce((m, r) => Math.max(m, r.id), 0) + 1;
    inp.value = '';
    if (await updateConfig({ customRules: [...c.customRules, { id, text, enabled: true }] })) toast('Rule added');
  } else if (e.target.dataset.form === 'syn') {
    const term = root.querySelector('#syn-term').value.trim();
    const means = root.querySelector('#syn-means').value.trim();
    if (!term || !means) return;
    root.querySelector('#syn-term').value = '';
    root.querySelector('#syn-means').value = '';
    if (await updateConfig({ synonyms: [...c.synonyms.filter((s) => s.term.toLowerCase() !== term.toLowerCase()), { term, means }] })) toast(`${term} added`);
  }
}
