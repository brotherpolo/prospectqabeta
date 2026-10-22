// Import from Excel or CSV: column matching, exact and near-duplicate detection, and undo.

import { state, getIndex, getItem, importRecords, undoImport, matchText, composeAsker, setAccounts, companyOf } from './store.js';
import { suggestVerdict } from './model.js';
import { openDialog, toast, toastError, confirmDialog } from './ui.js';
import { esc, icon, loadXLSX, pluralize, relTime } from './utils.js';

/** Accept 2026-10-14, 10/14/2026, Oct 14 2026 and similar; return YYYY-MM-DD or ''. */
export function toISODate(v) {
  const t = String(v ?? '').trim();
  if (!t) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? '' : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const FIELDS = [
  ['', 'Don’t import'],
  ['question', 'Question'],
  ['answer', 'Answer'],
  ['askedBy', 'Contact'],
  ['company', 'Account'],
  ['askedAt', 'Date asked'],
  ['answeredBy', 'Answered by'],
  ['topic', 'Category'],
];

const GUESS = [
  ['question', /^(q|questions?|inquiry)$/i, /question/i],
  ['answer', /^(a|answers?|responses?)$/i, /answer|response|reply/i],
  ['askedBy', /^(asked ?by|askedby|prospect|contact)$/i, /asked|prospect|contact|customer|client/i],
  ['company', /^(company|account)$/i, /company|account|organi[sz]ation/i],
  ['answeredBy', /^(answered ?by|answeredby|rep|se)$/i, /answered|rep\b|owner|responder|engineer/i],
  ['topic', /^(category|topic)$/i, /categor|topic|theme/i],
  ['askedAt', /^(date|date asked|asked on|call date)$/i, /date|when/i],
];

function guessMapping(headers) {
  const map = headers.map(() => '');
  for (const pass of [1, 2]) {
    for (const [field, exact, loose] of GUESS) {
      if (map.includes(field)) continue;
      const i = headers.findIndex((h, idx) => !map[idx] && (pass === 1 ? exact : loose).test(String(h).trim()));
      if (i >= 0) map[i] = field;
    }
  }
  return map;
}

export function openImportDialog() {
  const s = { step: 1, fileName: '', headers: [], rows: [], map: [], suggest: true, staged: [] };

  const steps = () => `<ol class="steps">${['Upload', 'Match columns', 'Review and add'].map((t, i) => {
    const st = i + 1 < s.step ? 'done' : i + 1 === s.step ? 'current' : 'todo';
    return `<li class="step" data-state="${st}"><span>${st === 'done' ? '✓' : i + 1}</span>${t}</li>`;
  }).join('')}</ol>`;

  const d = openDialog({ title: 'Import questions', wide: true, body: '' });
  const render = () => {
    const sub = s.fileName ? `${esc(s.fileName)} · ${pluralize(s.rows.length, 'row')}` : 'Excel (.xlsx, .xls) or CSV, first sheet only';
    d.innerHTML = `
      <div class="dlg">
        <div class="dlg-head">
          <div><h2 class="dlg-title" id="dlg-title">Import questions</h2><p class="dlg-sub">${sub}</p></div>
          <button type="button" class="icon-btn" data-close aria-label="Close">${icon('x', 'icon-sm')}</button>
        </div>
        ${steps()}
        <div class="dlg-body">${[step1, step2, step3][s.step - 1]()}</div>
        <div class="dlg-foot">${foot()}</div>
      </div>`;
    wire();
  };

  // ---- Step 1: upload ----
  function step1() {
    const last = state.config.lastImport;
    const lastLive = last && state.items.some((i) => i.importBatch === last.batch);
    return `
      <label class="dropzone" id="drop">
        ${icon('upload')}
        <strong>Choose a file or drop it here</strong>
        <span>Columns are matched automatically on the next step.</span>
        <input type="file" id="file" accept=".xlsx,.xls,.csv" class="visually-hidden">
      </label>
      ${lastLive ? `<div class="quote" style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
        <span>Last import: ${pluralize(last.count, 'question')}, ${esc(relTime(last.at))} by ${esc(last.by)}</span>
        <button type="button" class="btn btn-sm" data-undo-last>Undo last import</button></div>` : ''}`;
  }

  // ---- Step 2: column mapping ----
  function step2() {
    return `
      <p class="muted">Matched from your column names. Change any that look wrong. Only the question column is required.</p>
      <div class="map-grid" role="group" aria-label="Column matching">
        ${s.headers.map((h, i) => {
          const sample = s.rows.find((r) => String(r[i] ?? '').trim())?.[i] ?? '';
          return `<span class="map-col" title="${esc(h)}">${esc(h || `Column ${i + 1}`)}</span>
            <select class="select" data-map="${i}" aria-label="Field for column ${esc(h || i + 1)}">
              ${FIELDS.map(([v, l]) => `<option value="${v}" ${s.map[i] === v ? 'selected' : ''}>${l}</option>`).join('')}
            </select>
            <span class="map-sample">e.g. ${esc(String(sample).slice(0, 120)) || '(empty)'}</span>`;
        }).join('')}
      </div>
      <label class="radio-line"><input type="checkbox" id="suggest" ${s.suggest ? 'checked' : ''}>Suggest a category from similar questions when the file has none</label>`;
  }

  async function stage() {
    const col = (f) => s.map.indexOf(f);
    const ci = Object.fromEntries(FIELDS.map(([f]) => [f, col(f)]));
    const idx = getIndex();
    const closeAt = idx.mode === 'meaning' ? Math.max(state.config.semanticThreshold + 20, 70) : Math.max(state.config.matchThreshold, 50);
    const norm = (q) => q.toLowerCase().replace(/[“”"]/g, '"').replace(/[‘’']/g, "'").replace(/\s+/g, ' ').trim();
    const existing = new Set(state.items.map((i) => norm(i.question)));
    const seen = new Set();
    const val = (r, f) => (ci[f] >= 0 ? String(r[ci[f]] ?? '').trim() : '');

    s.staged = [];
    for (const r of s.rows) {
      const question = val(r, 'question');
      if (!question) continue;
      const person = val(r, 'askedBy');
      const company = val(r, 'company');
      const rec = {
        question,
        answer: val(r, 'answer') || 'No answer provided',
        askedBy: composeAsker(person, company),
        contact: person, company,
        askedAt: toISODate(val(r, 'askedAt')),
        answeredBy: val(r, 'answeredBy') || 'Unassigned',
        topic: val(r, 'topic'),
      };
      const v = suggestVerdict(rec.answer, rec.question);
      if (v) rec.verdict = v;
      const k = norm(question);
      const match = state.items.length ? await matchText(`${question} ${rec.answer}`) : null;
      if (!rec.topic) rec.topic = s.suggest && match && match.score >= idx.threshold ? match.item.topic : 'General Operations';
      if (existing.has(k) || seen.has(k)) rec.status = 'duplicate';
      else if (match && match.score >= closeAt) { rec.status = 'close'; rec.match = match; rec.decision = 'variant'; }
      else rec.status = 'new';
      seen.add(k);
      s.staged.push(rec);
    }
  }

  // ---- Step 3: review ----
  function step3() {
    const n = s.staged.filter((r) => r.status === 'new');
    const dups = s.staged.filter((r) => r.status === 'duplicate');
    const close = s.staged.filter((r) => r.status === 'close');
    const newCats = [...new Set(s.staged.filter((r) => r.status !== 'duplicate').map((r) => r.topic))].filter((c) => !state.categories.includes(c));
    return `
      <div class="stat-grid">
        <div class="stat"><strong>${n.length}</strong><span>New questions</span></div>
        <div class="stat"><strong>${dups.length}</strong><span>Exact duplicates, skipped</span></div>
        <div class="stat ${close.length ? 'warn' : ''}"><strong>${close.length}</strong><span>Close matches to check</span></div>
      </div>
      ${newCats.length ? `<p class="muted">New ${newCats.length === 1 ? 'category' : 'categories'} will be created: ${newCats.map((c) => `<span class="tag">${esc(c)}</span>`).join(' ')}</p>` : ''}
      ${close.map((r, i) => `
        <div class="match-card">
          <div class="queue-meta"><span>Close match ${i + 1} of ${close.length}</span><span class="mono">${r.match.score}%</span></div>
          <div><div class="lbl">Importing</div><div><strong>${esc(r.question)}</strong></div></div>
          <div><div class="lbl">Already in library as #${r.match.item.id}</div><div>${esc(r.match.item.question)}</div></div>
          <div class="radio-pills" role="radiogroup" aria-label="What to do with this row">
            ${[['variant', `Add as variant of #${r.match.item.id}`], ['new', 'Add as new'], ['skip', 'Skip']].map(([v, l]) =>
              `<label><input type="radio" name="close-${i}" value="${v}" data-close-idx="${i}" ${r.decision === v ? 'checked' : ''}>${l}</label>`).join('')}
          </div>
        </div>`).join('')}
      ${n.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Question</th><th>Asked by</th><th>Category</th></tr></thead><tbody>
        ${n.slice(0, 50).map((r) => `<tr><td>${esc(r.question)}</td><td>${esc(r.askedBy)}</td><td>${esc(r.topic)}</td></tr>`).join('')}
      </tbody></table>${n.length > 50 ? `<p class="field-hint">Showing 50 of ${n.length}.</p>` : ''}</div>` : ''}`;
  }

  const addCount = () => s.staged.filter((r) => r.status === 'new' || (r.status === 'close' && r.decision !== 'skip')).length;

  function foot() {
    if (s.step === 1) return '<div class="right"><button type="button" class="btn" data-close>Cancel</button></div>';
    if (s.step === 2) return `<button type="button" class="btn" data-back>Back</button>
      <div class="right"><button type="button" class="btn btn-primary" data-next>Continue</button></div>`;
    const c = addCount();
    return `<button type="button" class="btn" data-back>Back</button>
      <div class="right"><span class="field-hint">You can undo this import afterwards</span>
      <button type="button" class="btn btn-primary btn-lg" data-commit ${c ? '' : 'disabled'}>Add ${pluralize(c, 'question')}</button></div>`;
  }

  async function readFile(file) {
    try {
      const XLSX = await loadXLSX();
      if (/\.json$/i.test(file.name)) { toastError('To restore a backup file, use “Restore from backup” on the Calls page.'); return; }
      const buf = await file.arrayBuffer();
      // CSVs are decoded as UTF-8 explicitly; otherwise curly quotes and accents come through garbled.
      const wb = /\.csv$/i.test(file.name)
        ? XLSX.read(new TextDecoder('utf-8').decode(buf).replace(/^\uFEFF/, ''), { type: 'string' })
        : XLSX.read(new Uint8Array(buf), { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const all = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', blankrows: false, raw: false, dateNF: 'yyyy-mm-dd' });
      if (all.length < 2) { toastError('That file has no data rows under the header row.'); return; }
      s.fileName = file.name;
      s.headers = all[0].map((h) => String(h ?? '').trim());
      s.rows = all.slice(1).filter((r) => r.some((c) => String(c).trim()));
      s.map = guessMapping(s.headers);
      s.step = 2;
      render();
    } catch (err) {
      toastError(`Couldn't read that file. Make sure it's a valid Excel or CSV file. (${err.message})`);
    }
  }

  function wire() {
    const file = d.querySelector('#file');
    if (file) {
      const drop = d.querySelector('#drop');
      file.addEventListener('change', () => file.files[0] && readFile(file.files[0]));
      ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('drag'); }));
      ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('drag'); }));
      drop.addEventListener('drop', (e) => e.dataTransfer.files[0] && readFile(e.dataTransfer.files[0]));
    }
    d.querySelectorAll('[data-map]').forEach((sel) => sel.addEventListener('change', () => {
      const i = Number(sel.dataset.map);
      // A field can only map to one column.
      if (sel.value) s.map = s.map.map((v, j) => (j !== i && v === sel.value ? '' : v));
      s.map[i] = sel.value;
      render();
    }));
    d.querySelector('#suggest')?.addEventListener('change', (e) => { s.suggest = e.target.checked; });
    d.querySelectorAll('[data-close-idx]').forEach((r) => r.addEventListener('change', () => {
      s.staged.filter((x) => x.status === 'close')[Number(r.dataset.closeIdx)].decision = r.value;
      d.querySelector('.dlg-foot').innerHTML = foot();
      wireFoot();
    }));
    d.querySelector('[data-undo-last]')?.addEventListener('click', async () => {
      const last = state.config.lastImport;
      const ok = await confirmDialog({ title: 'Undo last import?', message: `This removes the ${pluralize(last.count, 'question')} added by that import, including any edits made to them since.`, confirmLabel: 'Undo import', danger: true });
      if (ok && await undoImport(last.batch)) toast('Import undone');
    });
    wireFoot();
  }

  function wireFoot() {
    d.querySelector('[data-back]')?.addEventListener('click', () => { s.step -= 1; render(); });
    d.querySelector('[data-next]')?.addEventListener('click', async (e) => {
      if (!s.map.includes('question')) { toastError('Pick which column holds the questions.'); return; }
      e.target.disabled = true;
      e.target.textContent = 'Checking for similar questions…';
      await stage();
      s.step = 3;
      render();
    });
    d.querySelector('[data-commit]')?.addEventListener('click', async () => {
      const rows = s.staged
        .filter((r) => r.status === 'new' || (r.status === 'close' && r.decision !== 'skip'))
        .map((r) => {
          const out = {
            question: r.question, answer: r.answer, askedBy: r.askedBy, answeredBy: r.answeredBy, topic: r.topic,
            contact: r.contact, company: r.company, askedAt: r.askedAt, verdict: r.verdict,
          };
          if (r.status === 'close' && r.decision === 'variant') {
            const target = getItem(r.match.item.id);
            if (target?.themeId) out.themeId = target.themeId;
            else out.variantOf = target?.variantOf || r.match.item.id;
          }
          return out;
        });
      const batch = `imp-${Date.now().toString(36)}`;
      d.close();
      if (await importRecords(rows, batch)) {
        toast(`Added ${pluralize(rows.length, 'question')}`, { action: { label: 'Undo', run: () => undoImport(batch).then((ok) => ok && toast('Import undone')) } });
      }
    });
  }

  render();
}


// ---------- Salesforce report: account stages ----------
export function openSalesforceImport() {
  openDialog({
    title: 'Import a Salesforce report',
    sub: 'Export a report of accounts or opportunities as Excel or CSV. Only account names and stages are used.',
    body: `<label class="dropzone" id="sf-drop">${icon('upload')}<strong>Choose the report file</strong>
      <span>Needs an account name column and a stage column. A won/lost column is optional.</span>
      <input type="file" id="sf-file" accept=".xlsx,.xls,.csv" class="visually-hidden"></label>
      <div id="sf-preview"></div>`,
    foot: '<div class="right"><button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn btn-primary" data-save disabled>Save stages</button></div>',
    onMount: (d) => {
      let parsed = null;
      const show = (html) => { d.querySelector('#sf-preview').innerHTML = html; };
      d.querySelector('#sf-file').addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        try {
          const XLSX = await loadXLSX();
          const buf = await file.arrayBuffer();
          const wb = /\.csv$/i.test(file.name)
            ? XLSX.read(new TextDecoder('utf-8').decode(buf).replace(/^\uFEFF/, ''), { type: 'string' })
            : XLSX.read(new Uint8Array(buf), { type: 'array' });
          const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '', raw: false });
          if (!rows.length) { toastError('That report has no rows.'); return; }
          const cols = Object.keys(rows[0]);
          const acctCol = cols.find((c) => /^account( name)?$/i.test(c.trim())) || cols.find((c) => /account|company/i.test(c));
          const stageCol = cols.find((c) => /stage/i.test(c));
          const wonCol = cols.find((c) => /\bwon\b|closed won|outcome/i.test(c));
          if (!acctCol || !stageCol) { show(`<div class="form-error">Couldn’t find ${!acctCol ? 'an account name' : 'a stage'} column. Columns found: ${cols.map(esc).join(', ')}.</div>`); return; }
          const accounts = {};
          for (const r of rows) {
            const name = String(r[acctCol]).trim();
            if (!name) continue;
            accounts[name] = { stage: String(r[stageCol]).trim(), ...(wonCol ? { outcome: String(r[wonCol]).trim() } : {}) };
          }
          const ours = [...new Set(state.items.map(companyOf).filter(Boolean))];
          const lower = new Map(Object.keys(accounts).map((k) => [k.toLowerCase(), k]));
          const matched = ours.filter((o) => lower.has(o.toLowerCase()));
          const unmatched = ours.filter((o) => !lower.has(o.toLowerCase()));
          // Store under the app's spelling, so stages line up with questions.
          for (const o of matched) { const k = lower.get(o.toLowerCase()); if (k !== o) { accounts[o] = accounts[k]; } }
          parsed = { accounts, file: file.name };
          show(`<div class="quote">
            <p>Using <strong>${esc(acctCol)}</strong> for account and <strong>${esc(stageCol)}</strong> for stage${wonCol ? `, <strong>${esc(wonCol)}</strong> for outcome` : ''}.</p>
            <p>${pluralize(Object.keys(accounts).length, 'account')} in the report. ${matched.length} of your ${pluralize(ours.length, 'account')} matched${matched.length ? `: ${matched.map(esc).join(', ')}` : ''}.</p>
            ${unmatched.length ? `<p class="warn-text">Not found in the report: ${unmatched.map(esc).join(', ')}. Check the spelling of these account names.</p>` : ''}
          </div>`);
          d.querySelector('[data-save]').disabled = false;
        } catch (err) { toastError(`Couldn't read that report. (${err.message})`); }
      });
      d.querySelector('[data-save]').addEventListener('click', async () => {
        if (!parsed) return;
        d.close();
        if (await setAccounts(parsed.accounts, { file: parsed.file, at: new Date().toISOString() })) toast('Stages imported');
      });
    },
  });
}
