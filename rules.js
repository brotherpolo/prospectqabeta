// Matching rules: how related questions are found, checked against an answer key from your own data.

import {
  state, updateConfig, DEFAULT_CONFIG, getItem, currentVectors, semanticStatus, labelPair,
  MODELS, activeModelId, compareModels, adoptModel, onModelProgress,
} from './store.js';
import { LABELS, fitThreshold, accuracyAt, spotSummary } from './model.js';
import { createIndex } from './similarity.js';
import { toast, toastError } from './ui.js';
import { esc, icon, debounce, pluralize, relTime } from './utils.js';

let root = null;
let draft = {};
const run = { active: false, model: null, pct: 0 };

const WORD_SLIDERS = [
  { key: 'overlapRatio', label: 'Overlap weight', min: 0, max: 100, unit: '%', hint: 'How much a short question being covered by a longer one counts. Jaccard (shared vocabulary) gets the rest.' },
  { key: 'matchThreshold', label: 'Same topic at (words)', min: 15, max: 80, unit: '%', hint: 'Used only when smart matching is off or still loading.' },
  { key: 'sameWordThreshold', label: 'Same question at (words)', min: 30, max: 95, unit: '%', hint: 'Duplicate warnings and conflicts when matching by words.' },
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
            <p class="field-hint">An open AI model (<strong data-model-name></strong>) runs in your browser, so questions never leave it. It downloads once (about <span data-model-size></span>) and is cached. Account, contact and rep names are removed first, so questions don’t match just because they mention the same prospect.</p>
            <div class="range-field">
              <div class="range-top"><label for="r-semanticThreshold">Same topic at</label><output id="o-semanticThreshold"></output></div>
              <input type="range" id="r-semanticThreshold" data-key="semanticThreshold" min="25" max="75" step="1">
              <p class="field-hint">Questions scoring at or above this are grouped into themes and suggested for review.</p>
            </div>
            <div class="range-field">
              <div class="range-top"><label for="r-sameThreshold">Same question at</label><output id="o-sameThreshold"></output></div>
              <input type="range" id="r-sameThreshold" data-key="sameThreshold" min="45" max="95" step="1">
              <p class="field-hint">A higher bar for “asking the same thing”: drives duplicate warnings, import close matches and conflict flags.</p>
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

          <section class="card" aria-label="Model comparison">
            <div class="card-head"><h2 class="card-title">Model comparison</h2><button type="button" class="btn btn-sm btn-primary" data-act="compare">Run comparison</button></div>
            <p class="field-hint" style="margin-bottom:10px">Tests each open model on your labeled examples. Each one is judged at its own best thresholds, because models score on different scales. All run in your browser; each downloads once (23–34 MB).</p>
            <div data-models></div>
          </section>

          <section class="card">
            <div class="card-head"><h2 class="card-title">Matching check</h2><a class="btn btn-sm btn-primary" href="#/calibrate">Calibrate</a></div>
            <p class="field-hint" style="margin-bottom:10px">Examples you’ve labeled, scored with the current settings. Calibrate adds the most useful ones: pairs the app is least sure about.</p>
            <div class="preview-box" data-check-summary aria-live="polite"></div>
            <div class="table-wrap"><table class="table check-table" data-check></table></div>
            <form class="add-row" data-form="pair" style="margin-top:12px">
              <label class="visually-hidden" for="pair-a">First question number</label>
              <input class="input" id="pair-a" placeholder="#" inputmode="numeric" style="max-width:80px">
              <label class="visually-hidden" for="pair-b">Second question number</label>
              <input class="input" id="pair-b" placeholder="#" inputmode="numeric" style="max-width:80px">
              <label class="visually-hidden" for="pair-rel">Are they related?</label>
              <select class="select" id="pair-rel" style="max-width:170px">${Object.entries(LABELS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('')}</select>
              <button class="btn" type="submit">${icon('plus', 'icon-sm')}Add pair</button>
            </form>
            <p class="field-hint" style="margin-top:8px">Decisions in Review and Themes add examples too: approving, linking or adding to a theme counts as same topic; dismissing or removing counts as unrelated.</p>
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
    if (e.target.matches('[data-relabel]')) {
      const [a, b] = e.target.dataset.relabel.split('-').map(Number);
      labelPair(a, b, e.target.value, 'manual').then((ok) => ok && toast('Label updated'));
    }
  };
  update();
}

const cfg = () => ({ ...state.config, ...draft });
const ALL_KEYS = ['semanticThreshold', 'sameThreshold', 'shortWordThreshold', ...WORD_SLIDERS.map((s) => s.key)];

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

/** Score every labeled example with the current settings; recommend thresholds once there are enough. */
const paintCheck = debounce(() => {
  if (!root) return;
  const c = cfg();
  const idx = createIndex(state.items.filter((i) => i.kind !== 'feedback'), c, currentVectors());
  const pairs = (state.config.matchCheck || []).filter((p) => getItem(p.a) && getItem(p.b));
  const scored = pairs.map((p) => ({ ...p, score: idx.compare(p.a, p.b).score }));
  const thT = idx.threshold, thS = idx.sameThreshold;
  const sc = (f) => scored.filter(f).map((p) => p.score);
  const tPos = sc((p) => p.label !== 'unrelated'), tNeg = sc((p) => p.label === 'unrelated');
  const sPos = sc((p) => p.label === 'same'), sNeg = sc((p) => p.label !== 'same');
  const meaning = idx.mode === 'meaning';
  const pct = (x) => (x == null ? '–' : `${Math.round(x * 100)}%`);
  const recT = tPos.length >= 10 && tNeg.length >= 10 ? fitThreshold(tPos, tNeg) : null;
  const recS = sPos.length >= 5 && sNeg.length >= 10 ? fitThreshold(sPos, sNeg) : null;
  const line = (name, th, pos, neg, rec, key, need) => `
    <div class="check-line"><span><strong>${name} at ${th}%</strong>: finds ${pos.filter((x) => x >= th).length} of ${pos.length}, wrongly includes ${neg.filter((x) => x >= th).length} of ${neg.length} (${pct(accuracyAt(pos, neg, th))} right).</span>
      ${rec ? (rec.t !== th ? `<button type="button" class="btn btn-sm" data-act="use-rec" data-key="${key}" data-rec="${rec.t}">Use ${rec.t}% (${pct(rec.correct / rec.total)})</button>` : '<span class="ok-text">✓ Best fit</span>')
        : `<span class="field-hint">${need}</span>`}</div>`;
  const groups = idx.groups();
  const spot = spotSummary();
  root.querySelector('[data-check-summary]').innerHTML = scored.length ? `
    <p>Matching by <strong>${meaning ? 'meaning' : 'shared words'}</strong> · ${pluralize(scored.length, 'example')} · ${pluralize(groups.length, 'suggested group')}</p>
    ${spot.n ? `<div class="check-line"><span><strong>Typical accuracy</strong> (spot check, ${pluralize(spot.n, 'pair')}${spot.n < 20 ? ', early estimate' : ''}): about ${pct(spot.accTopic)} of question pairs sorted as you would; ${pct(spot.acc)} counting “same question” separately.</span></div>`
      : `<div class="check-line"><span class="field-hint">No typical-accuracy figure yet: these examples are mostly borderline cases. <a href="#/calibrate?kind=spot">Do a spot check</a>.</span></div>`}
    ${line('Same topic', thT, tPos, tNeg, recT, meaning ? 'semanticThreshold' : 'matchThreshold', `Tuning needs 10 related and 10 unrelated (${tPos.length}/${tNeg.length}).`)}
    ${line('Same question', thS, sPos, sNeg, recS, meaning ? 'sameThreshold' : 'sameWordThreshold', `Tuning needs 5 “same question” and 10 others (${sPos.length}/${sNeg.length}).`)}`
    : 'No examples yet. Calibrate to add some.';
  const verdict = (p) => {
    const want = p.label;
    const got = p.score >= thS ? 'same' : p.score >= thT ? 'topic' : 'unrelated';
    if (got === want) return ['✓ Correct', 'ok-text'];
    if (want === 'unrelated') return [got === 'same' ? 'Flagged as duplicate' : 'Wrongly grouped', 'warn-text'];
    if (want === 'same') return [got === 'topic' ? 'Grouped, not flagged as duplicate' : 'Missed', 'warn-text'];
    return [got === 'same' ? 'Flagged as duplicate' : 'Missed', 'warn-text'];
  };
  root.querySelector('[data-check]').innerHTML = scored.length ? `
    <thead><tr><th>Questions</th><th>Your label</th><th class="num">Score</th><th>Result</th><th><span class="visually-hidden">Remove</span></th></tr></thead>
    <tbody>${[...scored].reverse().map((p) => {
      const [txt, cls] = verdict(p);
      return `<tr><td><a href="#/library/${p.a}">#${p.a}</a> ${esc(getItem(p.a).question.slice(0, 60))}<br><a href="#/library/${p.b}">#${p.b}</a> ${esc(getItem(p.b).question.slice(0, 60))}</td>
        <td><label class="visually-hidden" for="lbl-${p.a}-${p.b}">Label</label><select class="select select-inline" id="lbl-${p.a}-${p.b}" data-relabel="${p.a}-${p.b}">
          ${Object.entries(LABELS).map(([k, v]) => `<option value="${k}" ${k === p.label ? 'selected' : ''}>${v.label}</option>`).join('')}</select></td>
        <td class="num mono">${p.score}%</td>
        <td class="${cls}">${txt}</td>
        <td><button type="button" class="icon-btn" data-del-pair="${p.a}-${p.b}" aria-label="Remove this example">${icon('trash', 'icon-sm')}</button></td></tr>`;
    }).join('')}</tbody>` : '';
}, 60);

const pct = (x) => (x == null ? '–' : `${Math.round(x * 100)}%`);

function paintModels() {
  const el = root?.querySelector('[data-models]');
  if (!el) return;
  const ids = new Set(state.items.map((i) => i.id));
  const labels = (state.config.matchCheck || []).filter((p) => ids.has(p.a) && ids.has(p.b));
  const rel = labels.filter((p) => (p.label || (p.related ? 'topic' : 'unrelated')) !== 'unrelated').length;
  const unrel = labels.length - rel;
  const enough = rel >= 10 && unrel >= 10;
  const cmp = state.config.modelComparison;
  const active = activeModelId();
  const res = (id) => cmp?.results?.find((r) => r.model === id);
  const cur = res(active);
  // Judge on typical pairs once there are enough spot-check examples; otherwise on everything.
  const useTypical = (cmp?.results || []).some((r) => r.ok && r.typicalRank != null && r.nSpot >= 20);
  const rank = (r) => (useTypical ? r.typicalRank : r.topicRank);
  const okRes = (cmp?.results || []).filter((r) => r.ok && rank(r) != null);
  const best = [...okRes].sort((a, b) => rank(b) - rank(a) || (b.sameRank ?? 0) - (a.sameRank ?? 0))[0];
  // Only call a winner when it clearly beats the model in use; small differences are noise.
  // A winner needs a real lead AND enough typical (spot-check) pairs behind it:
  //   clear     = 40+ spot-check pairs and a lead of 5+ points on Typical
  //   promising = a lead of 5+ points (Typical) or 3+ (borderline only), but too few spot-check pairs to be sure
  const SPOT_NEEDED = 40;
  const nSpot = cur?.nSpot ?? 0;
  const lead = best && cur?.ok && rank(cur) != null && best.model !== active ? rank(best) - rank(cur) : 0;
  const clear = useTypical && nSpot >= SPOT_NEEDED && lead >= 0.05;
  const promising = !clear && lead >= (useTypical ? 0.05 : 0.03);
  root.querySelector('[data-act="compare"]').disabled = run.active || !enough || state.config.semanticMatching === false;
  el.innerHTML = `
    ${!enough ? `<div class="notice">Needs at least 10 related and 10 unrelated examples (now ${rel} and ${unrel}). <a href="#/calibrate">Calibrate</a> adds the most useful ones.</div>` : ''}
    <div class="table-wrap"><table class="table models-table">
      <thead><tr><th>Model</th>
        <th class="num" title="Ranking on spot-check pairs, sampled from every score level">Typical</th>
        <th class="num" title="Ranking on borderline pairs: the deck, Review and Themes examples">Borderline</th>
        <th class="num" title="How often a same-question pair scores above the rest">Same question</th><th class="num">Time</th><th><span class="visually-hidden">Action</span></th></tr></thead>
      <tbody>${MODELS.map((m) => {
        const r = res(m.id);
        const running = run.active && run.model === m.id;
        return `<tr class="${m.id === active ? 'model-active' : ''}">
          <td><strong>${esc(m.name)}</strong> <span class="muted">· ${m.size}</span><br><span class="field-hint">${esc(m.note)}</span></td>
          ${running ? `<td colspan="4" class="muted">Testing${run.pct ? `, downloading ${run.pct}%` : '…'}</td>`
            : !r ? '<td colspan="4" class="muted">Not tested yet</td>'
              : !r.ok ? `<td colspan="4" class="warn-text">Couldn’t load: ${esc(r.error)}</td>`
                : `<td class="num mono">${r.typicalRank == null ? '<span class="muted" title="Needs spot-check examples">–</span>' : pct(r.typicalRank)}</td>
                   <td class="num mono">${r.borderRank == null ? pct(r.topicRank) : pct(r.borderRank)}</td>
                   <td class="num mono">${r.sameRank == null ? '<span class="muted" title="Needs 3+ same-question examples">–</span>' : pct(r.sameRank)}</td><td class="num mono">${(r.ms / 1000).toFixed(1)}s</td>`}
          <td>${m.id === active ? '<span class="badge badge-ok">In use</span>'
            : r?.ok ? `<button type="button" class="btn btn-sm${clear && best.model === m.id ? ' btn-primary' : ''}" data-adopt="${esc(m.id)}">Use</button>` : ''}</td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>
    <p class="field-hint" style="margin-top:8px">Columns show <strong>ranking</strong>: how often a related pair scores above an unrelated one (100% is perfect, 50% is a coin toss). <strong>Typical</strong> uses spot-check pairs from every score level; <strong>Borderline</strong> uses the hard cases near the thresholds, where every model scores lower.
      ${useTypical ? '' : `<a href="#/calibrate?kind=spot">Do a spot check</a> (20+ pairs) to fill in Typical; the recommendation then uses it.`}</p>
    ${cmp ? `<p class="field-hint" style="margin-top:8px">Last run ${esc(relTime(cmp.at))} by ${esc(cmp.by)} on ${pluralize(cmp.labels, 'example')}. ${
      clear ? `<strong>${esc(MODELS.find((x) => x.id === best.model).name)}</strong> ranks noticeably better than the model in use, on ${nSpot} spot-check pairs.`
        : promising ? `<strong>${esc(MODELS.find((x) => x.id === best.model).name)}</strong> looks promising (${Math.round(lead * 100)} points ahead${useTypical ? ' on typical pairs' : ', on borderline pairs only'}), but ${nSpot ? `${nSpot} spot-check pairs aren’t` : 'there aren’t'} enough to be sure. <a href="#/calibrate?kind=spot">Do another spot check</a> (${Math.max(SPOT_NEEDED - nSpot, 20)} more pairs), then run the comparison again. Trying it now is safe: switching back restores your settings.`
        : okRes.length > 1 ? 'No clear winner: the differences are small enough to be noise. Keeping the current model is fine.' : ''}
      Time includes the first download.</p>` : ''}
    <p class="field-hint">Switching translates both thresholds to the new model’s scale so they stay equally selective. With 30+ examples on each side, they’re fitted to your labels instead. You can switch back at any time.</p>`;
}

export function update() {
  if (!root) return;
  const am = MODELS.find((m) => m.id === activeModelId());
  root.querySelectorAll('[data-model-name]').forEach((el) => { el.textContent = am.name; });
  root.querySelectorAll('[data-model-size]').forEach((el) => { el.textContent = am.size; });
  paintModels();
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
      sameThreshold: d.sameThreshold, sameWordThreshold: d.sameWordThreshold,
    });
    toast('Settings reset to defaults');
    return;
  }
  const useRec = t.closest('[data-act="use-rec"]');
  if (useRec) {
    if (await updateConfig({ [useRec.dataset.key]: Number(useRec.dataset.rec) })) toast(`Threshold set to ${useRec.dataset.rec}%`);
    return;
  }
  if (t.closest('[data-act="compare"]')) {
    run.active = true; run.pct = 0;
    const off = onModelProgress((m) => { if (m.model === run.model && m.total) { run.pct = Math.round((m.loaded / m.total) * 100); paintModels(); } });
    try {
      await compareModels(({ model, phase }) => { run.model = phase === 'running' ? model : null; run.pct = 0; paintModels(); });
      toast('Comparison finished');
    } catch (err) { toastError(`Comparison stopped: ${err.message}`); }
    finally { off(); run.active = false; run.model = null; paintModels(); }
    return;
  }
  const ad = t.closest('[data-adopt]');
  if (ad) {
    const name = MODELS.find((m) => m.id === ad.dataset.adopt)?.name;
    const r = await adoptModel(ad.dataset.adopt);
    if (r) toast(`Switched to ${name}: same topic at ${r.topic}%, same question at ${r.same}% (${r.how}). Re-scoring your questions…`, { duration: 9000 });
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
    const [a, b] = dp.dataset.delPair.split('-').map(Number);
    updateConfig({ matchCheck: (c.matchCheck || []).filter((p) => !(p.a === a && p.b === b)) });
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
    const label = root.querySelector('#pair-rel').value;
    root.querySelector('#pair-a').value = '';
    root.querySelector('#pair-b').value = '';
    if (await labelPair(a, b, label, 'manual')) toast('Example added');
  }
}
