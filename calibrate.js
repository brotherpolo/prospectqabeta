// Calibrate matching: label pairs the app is least sure about, then fit two thresholds
// (same topic / same question) to your answers.

import { state, getIndex, getItem, labelPair, unlabelPair, updateConfig, semanticStatus } from './store.js';
import { LABELS, fitThreshold, accuracyAt, scoredLabels, accountOf, isQuestion, themeTagHTML, SPOT_BANDS, bandOf, spotSummary } from './model.js';
import { toast } from './ui.js';
import { esc, isTyping, pluralize } from './utils.js';

const DECK = 20;
const ui = { deck: null, i: 0, done: [], mode: null, kind: 'border' };
let root = null;
let keysBound = false;

const key = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);

/** Pairs closest to either threshold, each question at most twice, half near each threshold. */
function buildDeck() {
  const idx = getIndex();
  const qs = state.items.filter(isQuestion);
  const labeled = new Set((state.config.matchCheck || []).map((p) => key(p.a, p.b)));
  const cands = [];
  for (let x = 0; x < qs.length; x++) {
    for (let y = x + 1; y < qs.length; y++) {
      const a = qs[x].id, b = qs[y].id;
      if (labeled.has(key(a, b))) continue;
      const s = idx.compare(a, b).score;
      if (s < 15) continue;
      const dT = Math.abs(s - idx.threshold), dS = Math.abs(s - idx.sameThreshold);
      cands.push({ a, b, s, u: Math.min(dT, dS), near: dS < dT ? 'same' : 'topic' });
    }
  }
  cands.sort((p, q) => p.u - q.u);
  const used = new Map(), picked = [], per = { same: 0, topic: 0 };
  const take = (c) => { picked.push(c); per[c.near]++; [c.a, c.b].forEach((id) => used.set(id, (used.get(id) || 0) + 1)); };
  for (const c of cands) {
    if (picked.length >= DECK) break;
    if ((used.get(c.a) || 0) >= 2 || (used.get(c.b) || 0) >= 2) continue;
    if (per[c.near] >= DECK / 2) continue;
    take(c);
  }
  for (const c of cands) { // fill if one side ran short
    if (picked.length >= DECK) break;
    if (picked.includes(c) || (used.get(c.a) || 0) >= 2 || (used.get(c.b) || 0) >= 2) continue;
    take(c);
  }
  // Alternate the two kinds so the deck doesn't feel repetitive.
  const s = picked.filter((c) => c.near === 'same'), t = picked.filter((c) => c.near === 'topic');
  const out = [];
  while (s.length || t.length) { if (t.length) out.push(t.shift()); if (s.length) out.push(s.shift()); }
  return out;
}

/** Spot check: random pairs from every score level, so accuracy can be measured on typical pairs. */
function buildSpotDeck() {
  const idx = getIndex();
  const qs = state.items.filter(isQuestion).map((i) => i.id);
  const labeled = new Set((state.config.matchCheck || []).map((p) => key(p.a, p.b)));
  const bands = SPOT_BANDS.slice(0, -1).map(() => []);
  for (let x = 0; x < qs.length; x++) {
    for (let y = x + 1; y < qs.length; y++) {
      if (labeled.has(key(qs[x], qs[y]))) continue;
      const s = idx.compare(qs[x], qs[y]).score;
      bands[bandOf(s)].push({ a: qs[x], b: qs[y], s });
    }
  }
  // Even quotas per score level (the summary re-weights by how common each level really is).
  const quota = Math.ceil(DECK / bands.length);
  const pick = [];
  const shuffle = (arr) => { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; };
  bands.forEach((b) => pick.push(...shuffle(b).slice(0, quota)));
  const rest = shuffle(bands.flatMap((b) => b.slice(quota)));
  while (pick.length < DECK && rest.length) pick.push(rest.pop());
  return shuffle(pick.slice(0, DECK));
}

export function mount(el, params = {}) {
  root = el;
  ui.deck = null; ui.i = 0; ui.done = [];
  if (params.kind === 'spot' || params.kind === 'border') ui.kind = params.kind;
  el.onclick = onClick;
  if (!keysBound) {
    keysBound = true;
    document.addEventListener('keydown', (e) => {
      if (!location.hash.startsWith('#/calibrate') || !root?.isConnected) return;
      if (document.getElementById('dialog').open || isTyping(document.activeElement) || e.metaKey || e.ctrlKey || e.altKey) return;
      const map = { 1: 'same', 2: 'topic', 3: 'unrelated' };
      if (map[e.key]) { e.preventDefault(); answer(map[e.key]); }
      else if (e.key.toLowerCase() === 's') { e.preventDefault(); skip(); }
      else if (e.key === 'Backspace') { e.preventDefault(); back(); }
    });
  }
  update();
}

export function update() {
  if (!root) return;
  const idx = getIndex();
  const sem = semanticStatus();
  const waiting = idx.mode === 'words' && state.config.semanticMatching !== false && sem.state !== 'error';
  if (waiting) {
    root.innerHTML = page(`<div class="card empty"><strong>Loading the matching model${sem.progress ? ` (${sem.progress}%)` : '…'}</strong>
      <span>Calibration tunes the meaning-based scores, so it waits for the model. This takes a few seconds the first time.</span></div>`);
    return;
  }
  if (ui.mode && ui.mode !== idx.mode) ui.deck = null; // scores changed underneath us
  ui.mode = idx.mode;
  if (!ui.deck) { ui.deck = ui.kind === 'spot' ? buildSpotDeck() : buildDeck(); ui.i = 0; }
  if (ui.i >= ui.deck.length) { root.innerHTML = page(summary()); return; }
  root.innerHTML = page(card(ui.deck[ui.i]));
}

const page = (inner) => `
  <div class="page calib">
    <header class="page-head">
      <div>
        <h1 class="page-title">Calibrate matching</h1>
        <p class="page-sub">${ui.kind === 'spot'
          ? 'Random pairs from every score level. Your answers measure how accurate matching is on typical questions, not just the hard ones.'
          : 'Pairs the app is least sure about. Your answers teach it where “same topic” ends and “same question” begins.'}</p>
      </div>
      <div class="page-actions">
        <div class="tabs" role="tablist" aria-label="Deck type">
          <button type="button" class="tab" role="tab" data-kind="border" aria-selected="${ui.kind === 'border'}">Borderline: tune</button>
          <button type="button" class="tab" role="tab" data-kind="spot" aria-selected="${ui.kind === 'spot'}">Spot check: measure</button>
        </div>
        <a class="btn" href="#/rules">Matching rules</a>
      </div>
    </header>
    ${inner}
  </div>`;

function side(id) {
  const it = getItem(id);
  return `<div class="calib-q">
    <span class="muted mono">#${it.id} · ${esc(accountOf(it))}</span>
    <strong>${esc(it.question)}</strong>
    <p>${esc(it.answer)}</p>
    ${themeTagHTML(it) || ''}
  </div>`;
}

function card(c) {
  const total = (state.config.matchCheck || []).length;
  return `
    <div class="calib-progress" aria-label="Pair ${ui.i + 1} of ${ui.deck.length}">
      <span>Pair <strong>${ui.i + 1}</strong> of ${ui.deck.length}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${Math.round((ui.i / ui.deck.length) * 100)}%"></span></span>
      <span class="muted">${pluralize(total, 'example')} so far</span>
    </div>
    <section class="card calib-card" aria-live="polite">
      <div class="calib-pair">${side(c.a)}<div class="calib-vs" aria-hidden="true">vs</div>${side(c.b)}</div>
      <div class="calib-actions" role="group" aria-label="How are these two related?">
        ${Object.entries(LABELS).map(([k, v], n) => `
          <button type="button" class="calib-btn calib-${k}" data-label="${k}">
            <strong>${v.label} <span class="kbd">${n + 1}</span></strong><span>${v.hint}</span>
          </button>`).join('')}
      </div>
      <div class="calib-foot">
        <button type="button" class="link-btn" data-act="back" ${ui.done.length ? '' : 'disabled'}>← Back</button>
        <span class="muted">Scores are hidden so they don’t sway you.</span>
        <button type="button" class="link-btn" data-act="skip">Not sure, skip <span class="kbd">S</span></button>
      </div>
    </section>`;
}

function spotResult() {
  const r = spotSummary();
  if (!r.n) return '';
  const pct = (x) => (x == null ? '–' : `${Math.round(x * 100)}%`);
  return `<div class="calib-rec spot-rec">
    <strong>Typical accuracy</strong>
    <span>${r.n >= 20 ? '' : `Early estimate (${r.n} of at least 20 spot-check pairs). `}At the current thresholds, about <strong>${pct(r.accTopic)}</strong> of question pairs are sorted the way you would (related or not), and <strong>${pct(r.acc)}</strong> when “same question” is counted separately.</span>
    <span class="field-hint">Weighted by how common each score level is in your library${r.covered < 0.98 ? `; score levels covering ${pct(1 - r.covered)} of pairs aren’t sampled yet` : ''}.</span>
  </div>`;
}

function summary() {
  const idx = getIndex();
  const L = scoredLabels();
  const sc = (f) => L.filter(f).map((p) => p.score);
  const topicPos = sc((p) => p.label !== 'unrelated'), topicNeg = sc((p) => p.label === 'unrelated');
  const samePos = sc((p) => p.label === 'same'), sameNeg = sc((p) => p.label !== 'same');
  const meaning = idx.mode === 'meaning';
  const recT = topicPos.length >= 10 && topicNeg.length >= 10 ? fitThreshold(topicPos, topicNeg) : null;
  const recS = samePos.length >= 5 && sameNeg.length >= 10 ? fitThreshold(samePos, sameNeg) : null;
  const pct = (x) => (x == null ? '–' : `${Math.round(x * 100)}%`);
  const row = (title, cur, rec, pos, neg, need, keyName) => `
    <div class="calib-rec">
      <strong>${title}</strong>
      ${rec ? `<span>Now ${cur}%: ${pct(accuracyAt(pos, neg, cur))} of examples sorted right.
        ${rec.t !== cur ? `Best fit ${rec.t}%: ${pct(rec.correct / rec.total)}.` : 'Already the best fit.'}</span>
        ${rec.t !== cur ? `<button type="button" class="btn btn-sm btn-primary" data-apply="${keyName}" data-val="${rec.t}">Use ${rec.t}%</button>` : '<span class="ok-text">✓</span>'}`
        : `<span class="muted">Needs ${need} before it can be tuned.</span>`}
    </div>`;
  const counts = { same: 0, topic: 0, unrelated: 0, skip: 0 };
  ui.done.forEach((d) => counts[d.label]++);
  return `
    <section class="card stack-12">
      <h2 class="card-title">${ui.deck.length ? 'Deck done. Thank you.' : 'Nothing left to check right now.'}</h2>
      ${ui.deck.length ? `<p>This round: ${counts.same} same question, ${counts.topic} same topic, ${counts.unrelated} unrelated${counts.skip ? `, ${counts.skip} skipped` : ''}. ${pluralize(L.length, 'example')} in total.</p>`
        : '<p class="muted">Every pair near the thresholds has been labeled. New questions will bring new pairs.</p>'}
      ${row('Same topic (grouping into themes)', meaning ? state.config.semanticThreshold : state.config.matchThreshold, recT, topicPos, topicNeg,
        `at least 10 related and 10 unrelated examples (now ${topicPos.length} and ${topicNeg.length})`, meaning ? 'semanticThreshold' : 'matchThreshold')}
      ${row('Same question (duplicates and conflicts)', meaning ? state.config.sameThreshold : state.config.sameWordThreshold, recS, samePos, sameNeg,
        `at least 5 “same question” and 10 other examples (now ${samePos.length} and ${sameNeg.length})`, meaning ? 'sameThreshold' : 'sameWordThreshold')}
      ${spotResult()}
      <p class="field-hint">Recommendations lean strict: a missed match is cheaper than a wrong one. Every example is listed on the Matching rules page, where you can change or remove it.</p>
      <div class="actions-bar"><a class="btn" href="#/rules">See all examples</a>
        ${ui.kind === 'spot' ? '' : '<button type="button" class="btn" data-kind="spot">Spot check instead</button>'}
        <button type="button" class="btn btn-primary" data-act="again">Label ${DECK} more</button></div>
    </section>`;
}

async function answer(label) {
  const c = ui.deck?.[ui.i];
  if (!c) return;
  ui.done.push({ ...c, label });
  ui.i++;
  update();
  await labelPair(c.a, c.b, label, ui.kind === 'spot' ? 'spot' : 'calibration');
}

function skip() {
  const c = ui.deck?.[ui.i];
  if (!c) return;
  ui.done.push({ ...c, label: 'skip' });
  ui.i++;
  update();
}

async function back() {
  const last = ui.done.pop();
  if (!last) return;
  ui.i--;
  update();
  if (last.label !== 'skip') await unlabelPair(last.a, last.b);
}

async function onClick(e) {
  const t = e.target;
  const k = t.closest('[data-kind]');
  if (k) { ui.kind = k.dataset.kind; ui.deck = null; ui.done = []; history.replaceState(null, '', `#/calibrate?kind=${ui.kind}`); update(); return; }
  const l = t.closest('[data-label]');
  if (l) { answer(l.dataset.label); return; }
  const ap = t.closest('[data-apply]');
  if (ap) { if (await updateConfig({ [ap.dataset.apply]: Number(ap.dataset.val) })) toast(`Threshold set to ${ap.dataset.val}%`); return; }
  const act = t.closest('[data-act]')?.dataset.act;
  if (act === 'skip') skip();
  else if (act === 'back') back();
  else if (act === 'again') { ui.deck = null; ui.done = []; update(); }
}
