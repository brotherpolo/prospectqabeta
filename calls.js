// Calls: every logged conversation, with delete (and undo) and a guarded "start fresh".

import {
  state, deleteCall, restoreCall, startFresh, backupData, restoreBackup,
  dataMode, layoutMeta, canWriteNewLayout, moveToNewLayout, singleDocBytes,
} from './store.js';
import { openLogCall } from './logcall.js';
import { openDialog, toast, toastError } from './ui.js';
import { esc, icon, fmtDate, todayISO, downloadText, loadXLSX, pluralize } from './utils.js';

let root = null;

export function mount(el) {
  root = el;
  el.onclick = onClick;
  update();
}

export function update() {
  if (!root) return;
  const counts = new Map();
  state.items.forEach((i) => i.callId && counts.set(i.callId, (counts.get(i.callId) || 0) + 1));
  const calls = [...state.config.calls].sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || '').localeCompare(a.createdAt || ''));
  const unlinked = state.items.filter((i) => !i.callId && i.kind !== 'feedback').length;

  root.innerHTML = `
    <div class="page">
      <header class="page-head">
        <div>
          <h1 class="page-title">Calls</h1>
          <p class="page-sub">Every logged conversation and the questions that came from it.</p>
        </div>
        <button type="button" class="btn btn-primary" data-act="log">${icon('plus', 'icon-sm')}Log a call</button>
      </header>

      ${unlinked ? `<div class="notice">${pluralize(unlinked, 'question')} ${unlinked === 1 ? 'isn’t' : 'aren’t'} linked to a call yet. <a href="#/complete">Complete records</a> groups them into calls by account and date.</div>` : ''}

      <section class="card" style="padding:0;overflow:hidden" aria-label="Calls">
        ${calls.length ? `<div class="table-wrap"><table class="table table-pad">
          <thead><tr><th>Date</th><th>Account</th><th>Contact</th><th>Type</th><th>Answered by</th><th class="num">Questions</th><th><span class="visually-hidden">Actions</span></th></tr></thead>
          <tbody>${calls.map((c) => `<tr>
            <td style="white-space:nowrap">${esc(fmtDate(c.date))}</td>
            <td><a href="#/library?call=${esc(c.id)}"><strong>${esc(c.company || '–')}</strong></a></td>
            <td>${esc(c.contact || '–')}</td>
            <td>${esc(c.type || '–')}</td>
            <td>${esc(c.rep || '–')}</td>
            <td class="num mono">${counts.get(c.id) || 0}</td>
            <td class="row-actions">
              <button type="button" class="icon-btn" data-edit="${esc(c.id)}" aria-label="Edit the ${esc(c.company)} call on ${esc(fmtDate(c.date))}">${icon('edit', 'icon-sm')}</button>
              <button type="button" class="icon-btn" data-del="${esc(c.id)}" aria-label="Delete the ${esc(c.company)} call on ${esc(fmtDate(c.date))}">${icon('trash', 'icon-sm')}</button>
            </td>
          </tr>`).join('')}</tbody></table></div>`
          : `<div class="empty"><strong>No calls yet</strong><span>Log a call, import a spreadsheet, or use Complete records to turn your existing questions into calls.</span></div>`}
      </section>

      <section class="card danger-zone">
        <div>
          <h2 class="card-title">Start fresh</h2>
          <p class="muted">Remove every call and question from the shared dataset, for everyone, and begin again. You’ll download a backup first, and you can keep your categories and rules.</p>
        </div>
        <button type="button" class="btn btn-danger-outline" data-act="fresh">Start fresh…</button>
      </section>

      ${databaseCard()}

      <section class="card danger-zone">
        <div>
          <h2 class="card-title">Backups</h2>
          <p class="muted">Download everything as a restore file, or restore from one. Restoring replaces the current data for everyone.</p>
        </div>
        <div class="toolbar">
          <button type="button" class="btn" data-act="backup">${icon('download', 'icon-sm')}Download backup</button>
          <label class="btn">${icon('upload', 'icon-sm')}Restore from backup<input type="file" accept=".json" data-restore class="visually-hidden"></label>
        </div>
      </section>
    </div>`;
  root.querySelector('[data-restore]').onchange = (e) => e.target.files[0] && restoreFlow(e.target.files[0]);
}

// ---------- Database layout ----------
const move = { rules: null, backup: false, oldAppRetired: false, running: false, step: '' };

export const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // Who may use the app: the same two accounts as before. Add more user IDs to this list
    // to give other people access (each person's ID is shown in the app under Account).
    function isTeam() {
      return request.auth != null && request.auth.uid in [
        "BJYNIOG65MebPqza3JKvtqQ1xeN2",
        "xT0Lzm2YKJambi7BWmY5mIJWUTJ2"
      ];
    }

    // The dataset ("data" for real use; another name such as "data-staging" for testing).
    match /artifacts/{appId}/public/{dataDoc} {
      allow read, write: if isTeam();

      // New layout: one document per question, theme, call and matching example, plus settings.
      match /{coll}/{docId} {
        allow read, write: if isTeam() && coll in ['questions', 'themes', 'calls', 'labels', 'meta'];
      }

      // Change history: can be added to and read, never edited or deleted.
      match /history/{entryId} {
        allow read, create: if isTeam();
      }
    }
  }
}`;

function databaseCard() {
  if (dataMode() === 'collections') {
    const m = layoutMeta();
    return `<section class="card db-card">
      <div class="card-head"><h2 class="card-title">Database</h2><span class="badge badge-ok">New layout</span></div>
      <p class="muted">One document per question, theme, call and matching example. Saves write only what changed, and every change to a question is recorded in its history.${m?.migratedAt ? ` Moved ${esc(fmtDate(m.migratedAt.slice(0, 10)))}${m.migratedBy ? ` by ${esc(m.migratedBy)}` : ''}.` : ''}</p>
      <details class="field-hint"><summary>How to go back to the original layout</summary>
        <p>In the Firebase console, delete the document <code>meta/settings</code> under your dataset. Every copy of the app returns to the original single document, as it was at the moment of the move. Changes made since then would need restoring from a backup.</p></details>
    </section>`;
  }
  const kb = Math.round(singleDocBytes() / 1024);
  const pct = Math.round((kb / 1024) * 100);
  const ready = move.rules === true && move.backup && move.oldAppRetired;
  const tick = (ok) => (ok ? '<span class="ok-text">✓</span>' : '<span class="muted">○</span>');
  return `<section class="card db-card">
    <div class="card-head"><h2 class="card-title">Database</h2><span class="badge">Original layout</span></div>
    <p>Everything is in one Firestore document: about <strong>${kb} KB</strong> of its 1 MB limit (${pct}%).</p>
    <div class="bar-track" style="height:8px;max-width:420px"><span class="bar-fill ${pct > 70 ? 'warn' : ''}" style="width:${Math.max(2, pct)}%"></span></div>
    <p class="muted">Moving to the new layout removes the limit, makes saves smaller and safer when several people work at once, and starts recording a change history on every question. The original document stays untouched as a fallback.</p>
    <ol class="db-steps">
      <li>${tick(move.rules === true)} <span><strong>Update your Firestore rules</strong> so the app may use the new layout.
        <span class="toolbar"><button type="button" class="btn btn-sm" data-db="rules">Show the rules</button><button type="button" class="btn btn-sm" data-db="check">Check rules</button>
        ${move.rules === false ? '<span class="warn-text">Not allowed yet: the rules haven’t been updated, or haven’t taken effect (allow a minute).</span>' : move.rules === true ? '<span class="ok-text">Rules allow the new layout.</span>' : ''}</span></span></li>
      <li>${tick(move.backup)} <span><strong>Download a backup.</strong> <button type="button" class="btn btn-sm" data-db="backup">Download backup</button></span></li>
      <li>${tick(move.oldAppRetired)} <span><label class="radio-line"><input type="checkbox" data-db="retired" ${move.oldAppRetired ? 'checked' : ''}><span><strong>Nobody is using the original app any more.</strong> After the move it would save to the old document, and those changes wouldn’t appear here.</span></label></span></li>
    </ol>
    <div class="actions-bar" style="justify-content:flex-start">
      <button type="button" class="btn btn-primary" data-db="move" ${ready && !move.running ? '' : 'disabled'}>${move.running ? 'Moving…' : 'Move to the new layout'}</button>
      ${move.running ? `<span class="muted" aria-live="polite">${esc(move.step)}</span>` : ''}
    </div>
  </section>`;
}

function showRules() {
  openDialog({
    title: 'Firestore rules for the new layout',
    sub: 'Firebase console › Firestore Database › Rules. Replace the rules with these, then Publish.',
    wide: true,
    body: `<p>These keep the same two accounts as your current rules, and add the new layout. Your current data keeps working exactly as before until you press <strong>Move to the new layout</strong>.</p>
      <pre class="rules-code">${esc(RULES)}</pre>`,
    foot: `<button type="button" class="btn" data-copy-rules>${icon('copy', 'icon-sm')}Copy rules</button><div class="right"><button type="button" class="btn btn-primary" data-close>Done</button></div>`,
    onMount: (d) => d.querySelector('[data-copy-rules]').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(RULES); toast('Rules copied'); } catch { toastError('Couldn’t copy. Select the text and copy it instead.'); }
    }),
  });
}

async function runMove() {
  openDialog({
    title: 'Move to the new layout?',
    sub: 'This copies everything, checks the copy, then switches every open copy of the app over. It takes under a minute.',
    body: `<p>The original document is left as it is. Type <span class="kbd">move</span> to confirm.</p><input class="input" id="move-confirm" autocomplete="off">`,
    foot: '<div class="right"><button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn btn-primary" data-go disabled>Move now</button></div>',
    onMount: (d) => {
      const inp = d.querySelector('#move-confirm');
      const go = d.querySelector('[data-go]');
      inp.addEventListener('input', () => { go.disabled = inp.value.trim().toLowerCase() !== 'move'; });
      inp.focus();
      go.addEventListener('click', async () => {
        d.close();
        move.running = true; move.step = 'Starting';
        update();
        try {
          const counts = await moveToNewLayout((step) => { move.step = step; update(); });
          toast(`Moved ${counts.questions} questions, ${counts.themes} themes, ${counts.calls} calls and ${counts.labels} matching examples. Switching over…`, { duration: 8000 });
        } catch (err) {
          move.running = false;
          update();
          toastError(`The move didn’t complete: ${err.message}`);
        }
      });
    },
  });
}

async function onClick(e) {
  const t = e.target;
  const db = t.closest('[data-db]');
  if (db) {
    const a = db.dataset.db;
    if (a === 'rules') showRules();
    else if (a === 'check') { try { move.rules = await canWriteNewLayout(); } catch (err) { toastError(err.message); } update(); }
    else if (a === 'backup') { await downloadBackup(); move.backup = true; update(); }
    else if (a === 'retired') { move.oldAppRetired = db.checked; update(); }
    else if (a === 'move') runMove();
    return;
  }
  const edit = t.closest('[data-edit]');
  if (edit) { openLogCall(edit.dataset.edit); return; }
  const del = t.closest('[data-del]');
  if (del) { confirmDelete(del.dataset.del); return; }
  const act = t.closest('[data-act]')?.dataset.act;
  if (act === 'log') openLogCall();
  else if (act === 'fresh') openStartFresh();
  else if (act === 'backup') { await downloadBackup(); }
}

function confirmDelete(callId) {
  const c = state.config.calls.find((x) => x.id === callId);
  if (!c) return;
  const n = state.items.filter((i) => i.callId === callId).length;
  let mode = 'all';
  openDialog({
    title: `Delete the ${c.company || c.contact} call on ${fmtDate(c.date)}?`,
    sub: `${esc(c.contact || '')}${c.type ? ` · ${esc(c.type)}` : ''} · ${pluralize(n, 'question')}`,
    body: `<div class="choice-list" role="radiogroup" aria-label="What happens to its questions">
      <label class="choice"><input type="radio" name="del-mode" value="all" checked><span><strong>Delete the call and its ${pluralize(n, 'question')}</strong><span class="muted">They disappear from themes, counts and the Overview.</span></span></label>
      <label class="choice"><input type="radio" name="del-mode" value="keep"><span><strong>Delete only the call details</strong><span class="muted">Keep the questions and answers in the Library, without a call or date.</span></span></label>
    </div>`,
    foot: `<span class="field-hint">You can undo this right after.</span>
      <div class="right"><button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn btn-danger" data-ok>Delete</button></div>`,
    onMount: (d) => {
      d.querySelectorAll('[name="del-mode"]').forEach((r) => r.addEventListener('change', () => { mode = r.value; }));
      d.querySelector('[data-ok]').addEventListener('click', async () => {
        d.close();
        const snap = await deleteCall(callId, mode);
        if (snap) {
          toast(mode === 'all' ? `Deleted the call and ${pluralize(n, 'question')}` : 'Deleted the call; questions kept', {
            action: { label: 'Undo', run: () => restoreCall(snap).then((ok) => ok && toast('Call restored')) },
          });
        }
      });
    },
  });
}

async function downloadBackup() {
  const data = backupData();
  const stamp = todayISO();
  downloadText(`QA_Hub_restore_${stamp}.json`, JSON.stringify(data, null, 1));
  try {
    const XLSX = await loadXLSX();
    const wb = XLSX.utils.book_new();
    const callById = new Map(state.config.calls.map((c) => [c.id, c]));
    const themeById = new Map(state.config.themes.map((t) => [t.id, t.name]));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(state.items.map((i) => ({
      ID: i.id, Date: i.askedAt || '', Account: i.company || '', Contact: i.contact || i.askedBy, Question: i.question, Answer: i.answer,
      'Answered By': i.answeredBy, Category: i.topic, Theme: themeById.get(i.themeId) || '', Verdict: i.verdict || '',
      'Call type': callById.get(i.callId)?.type || '', 'Follow-up owner': i.followUp?.owner || '', 'Follow-up due': i.followUp?.due || '',
    }))), 'Questions');
    XLSX.writeFile(wb, `QA_Hub_backup_${stamp}.xlsx`);
  } catch { /* the restore file alone is enough */ }
  return true;
}

function openStartFresh() {
  const nCalls = state.config.calls.length;
  const nQ = state.items.length;
  const approved = state.items.filter((i) => i.standard && i.themeId).length;
  let backedUp = false;
  openDialog({
    title: 'Start fresh',
    sub: `This removes all ${pluralize(nCalls, 'call')} and ${pluralize(nQ, 'question')} from the shared dataset. Everyone using the app will see an empty library.`,
    body: `
      <div class="field">
        <span class="field-label">1 · Download a backup</span>
        <div class="toolbar"><button type="button" class="btn" data-backup>${icon('download', 'icon-sm')}Download backup</button><span class="field-hint" data-backup-state>Required before you can continue</span></div>
        <span class="field-hint">An Excel copy to read, plus a restore file. “Restore from backup” on this page brings everything back exactly.</span>
      </div>
      <div class="field">
        <span class="field-label">2 · Choose what to keep</span>
        <label class="radio-line"><input type="checkbox" data-keep="categories" checked>Categories (${state.categories.length})</label>
        <label class="radio-line"><input type="checkbox" data-keep="rules" checked>Matching rules, coaching rules and abbreviations</label>
        <label class="radio-line"><input type="checkbox" data-keep="approved" ${approved ? '' : 'disabled'}>Approved answers (${approved}), so new questions match against them</label>
      </div>
      <div class="field">
        <label for="fresh-confirm" class="field-label">3 · Type <span class="kbd">start fresh</span> to confirm</label>
        <input class="input" id="fresh-confirm" autocomplete="off">
      </div>`,
    foot: `<div class="right"><button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn btn-danger" data-go disabled>Delete everything and start fresh</button></div>`,
    onMount: (d) => {
      const go = d.querySelector('[data-go]');
      const input = d.querySelector('#fresh-confirm');
      const check = () => { go.disabled = !(backedUp && input.value.trim().toLowerCase() === 'start fresh'); };
      input.addEventListener('input', check);
      d.querySelector('[data-backup]').addEventListener('click', async () => {
        await downloadBackup();
        backedUp = true;
        const s = d.querySelector('[data-backup-state]');
        s.textContent = '✓ Backup downloaded';
        s.classList.add('ok-text');
        check();
      });
      go.addEventListener('click', async () => {
        const keep = Object.fromEntries([...d.querySelectorAll('[data-keep]')].map((c) => [c.dataset.keep, c.checked]));
        d.close();
        if (await startFresh(keep)) toast('Library cleared. Your backup is in your downloads folder.');
      });
    },
  });
}

async function restoreFlow(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { toastError('That file isn’t a valid backup.'); return; }
  if (data?.app !== 'prospect-qa-hub' || !Array.isArray(data.items)) { toastError('That file isn’t a Prospect Q&A Hub backup.'); return; }
  openDialog({
    title: 'Restore this backup?',
    sub: `${pluralize(data.items.length, 'question')} and ${pluralize(data.insightConfig?.calls?.length || 0, 'call')}, saved ${esc(fmtDate((data.exportedAt || '').slice(0, 10)))}${data.exportedBy ? ` by ${esc(data.exportedBy)}` : ''}.`,
    body: '<p>This replaces the current data for everyone. If you might need what’s there now, download a backup first.</p>',
    foot: `<button type="button" class="btn" data-pre>${icon('download', 'icon-sm')}Back up current data</button>
      <div class="right"><button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn btn-danger" data-ok>Restore</button></div>`,
    onMount: (d) => {
      d.querySelector('[data-pre]').addEventListener('click', downloadBackup);
      d.querySelector('[data-ok]').addEventListener('click', async () => {
        d.close();
        if (await restoreBackup(data)) toast('Backup restored');
      });
    },
  });
}
