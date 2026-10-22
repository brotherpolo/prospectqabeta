// Calls: every logged conversation, with delete (and undo) and a guarded "start fresh".

import { state, deleteCall, restoreCall, startFresh, backupData, restoreBackup } from './store.js';
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

async function onClick(e) {
  const t = e.target;
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
