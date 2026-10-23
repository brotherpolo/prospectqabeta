import {
  state, getItem, getIndex, saveQuestion, renameCategory, addCategory, removeCategory, matchText, companyOf, contactOf,
} from './store.js';
import { VERDICTS, verdictLabel, suggestVerdict, detectFollowUp } from './model.js';
import { openDialog, toast, toastError } from './ui.js';
import { esc, icon, debounce, repNames, copyText, todayISO, addDaysISO } from './utils.js';
import { signOut } from './sync.js';
import { PLANNER_URL } from './config.js';

// ---------- Add / edit a question ----------
export function openQuestionDialog(id = null, { onSaved, defaults = {} } = {}) {
  const rec = id != null ? getItem(id) : null;
  const v = rec || { question: '', answer: '', answeredBy: '', topic: defaults.topic || state.categories[0] || 'General Operations', askedAt: todayISO() };
  const company = rec ? companyOf(rec) : '';
  const contact = rec ? contactOf(rec) : '';
  const companies = [...new Set([...state.items.map(companyOf), ...Object.keys(state.config.accounts)].filter(Boolean))].sort();
  const contacts = [...new Set(state.items.map(contactOf).filter(Boolean))].sort();
  const reps = [...new Set(state.items.flatMap((i) => repNames(i.answeredBy)))].sort();
  const cats = state.categories.includes(v.topic) ? state.categories : [...state.categories, v.topic];
  const themes = [...state.config.themes].sort((a, b) => a.name.localeCompare(b.name));
  const fu = v.followUp || null;

  openDialog({
    title: rec ? `Edit question #${rec.id}` : 'New question',
    sub: rec?.callId ? 'This question is part of a logged call. Changing its account or date here affects only this question.' : '',
    wide: true,
    body: `
      <form id="q-form" class="form-grid form-grid-3" novalidate>
        <div class="field span-all">
          <label for="q-question">Question</label>
          <textarea class="textarea" id="q-question" rows="2" required>${esc(v.question)}</textarea>
          <p class="field-hint" id="q-dup" aria-live="polite"></p>
        </div>
        <div class="field span-all">
          <label for="q-answer">Answer</label>
          <textarea class="textarea" id="q-answer" rows="4">${esc(v.answer)}</textarea>
        </div>
        <div class="field">
          <label for="q-company">Account</label>
          <input class="input" id="q-company" list="dl-q-companies" value="${esc(company)}" placeholder="Company" autocomplete="off">
          <datalist id="dl-q-companies">${companies.map((a) => `<option value="${esc(a)}">`).join('')}</datalist>
        </div>
        <div class="field">
          <label for="q-contact">Contact</label>
          <input class="input" id="q-contact" list="dl-q-contacts" value="${esc(contact)}" autocomplete="off">
          <datalist id="dl-q-contacts">${contacts.map((a) => `<option value="${esc(a)}">`).join('')}</datalist>
        </div>
        <div class="field">
          <label for="q-date">Date asked</label>
          <input class="input" type="date" id="q-date" value="${esc(v.askedAt || '')}">
        </div>
        <div class="field">
          <label for="q-rep">Answered by</label>
          <input class="input" id="q-rep" list="dl-reps" value="${esc(v.answeredBy)}" placeholder="Rep name" autocomplete="off">
          <datalist id="dl-reps">${reps.map((a) => `<option value="${esc(a)}">`).join('')}</datalist>
        </div>
        <div class="field">
          <label for="q-topic">Category</label>
          <select class="select" id="q-topic">
            ${cats.map((c) => `<option ${c === v.topic ? 'selected' : ''}>${esc(c)}</option>`).join('')}
            <option value="__new">New category…</option>
          </select>
          <input class="input" id="q-topic-new" placeholder="New category name" hidden>
        </div>
        <div class="field">
          <label for="q-theme">Theme</label>
          <select class="select" id="q-theme">
            <option value="">No theme</option>
            ${themes.map((t) => `<option value="${esc(t.id)}" ${t.id === v.themeId ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}
          </select>
        </div>
        <div class="field span-all">
          <span class="field-label">Verdict: can we do what was asked? <span class="muted" id="q-vsug"></span></span>
          <div class="pills" role="radiogroup" aria-label="Verdict">${VERDICTS.map((x) => `<button type="button" class="pill" data-verdict="${x.id}" aria-pressed="${v.verdict === x.id}">${x.label}</button>`).join('')}</div>
        </div>
        <div class="field span-all">
          <label class="radio-line"><input type="checkbox" id="q-fu" ${fu ? 'checked' : ''}>Follow-up needed</label>
          <div class="fu-fields" id="q-fu-fields" ${fu ? '' : 'hidden'}>
            <label class="mini-field">Owner<input class="input input-sm" id="q-fu-owner" value="${esc(fu?.owner || v.answeredBy || '')}"></label>
            <label class="mini-field">Due<input class="input input-sm" type="date" id="q-fu-due" value="${esc(fu?.due || addDaysISO(todayISO(), 7))}"></label>
            <label class="radio-line"><input type="checkbox" id="q-fu-done" ${fu?.done ? 'checked' : ''}>Done</label>
          </div>
        </div>
      </form>`,
    foot: `<span class="field-hint">${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+Enter to save</span>
      <div class="right"><button type="button" class="btn" data-close>Cancel</button>
      <button type="submit" form="q-form" class="btn btn-primary">${rec ? 'Save changes' : 'Add question'}</button></div>`,
    onMount: (d) => {
      const $ = (s) => d.querySelector(s);
      const f = $('#q-form');
      const q = $('#q-question');
      const a = $('#q-answer');
      const topic = $('#q-topic');
      const topicNew = $('#q-topic-new');
      const dup = $('#q-dup');
      let verdict = v.verdict || null;
      let touched = !!v.verdict;
      q.focus();

      const paintVerdict = () => {
        d.querySelectorAll('[data-verdict]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.verdict === verdict)));
        const s = suggestVerdict(a.value, q.value);
        $('#q-vsug').textContent = s && s !== verdict ? `· suggested: ${verdictLabel(s)}` : '';
      };
      paintVerdict();
      d.addEventListener('click', (e) => {
        const b = e.target.closest('[data-verdict]');
        if (!b) return;
        verdict = verdict === b.dataset.verdict ? null : b.dataset.verdict;
        touched = true;
        paintVerdict();
      });
      a.addEventListener('input', () => {
        if (!touched) verdict = suggestVerdict(a.value, q.value);
        if (!rec && detectFollowUp(a.value) && !$('#q-fu').checked) { $('#q-fu').checked = true; $('#q-fu-fields').hidden = false; }
        paintVerdict();
      });
      $('#q-fu').addEventListener('change', (e) => { $('#q-fu-fields').hidden = !e.target.checked; });
      topic.addEventListener('change', () => {
        topicNew.hidden = topic.value !== '__new';
        if (!topicNew.hidden) topicNew.focus();
      });

      // Warn about likely duplicates while typing.
      const check = debounce(async () => {
        const text = q.value.trim();
        if (text.length < 12) { dup.textContent = ''; return; }
        const m = await matchText(`${text} ${a.value}`, (it) => it.id !== rec?.id);
        const th = getIndex().sameThreshold;
        if (m && m.score >= th) {
          dup.innerHTML = `Similar to <a href="#/library/${m.item.id}" data-close>#${m.item.id}</a> (${m.score}%): ${esc(m.item.question)}`;
        } else dup.textContent = '';
      }, 400);
      q.addEventListener('input', check);

      d.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); f.requestSubmit(); }
      });

      f.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!q.value.trim()) { toastError('Add the question text before saving.'); q.focus(); return; }
        let t = topic.value;
        if (t === '__new') {
          t = topicNew.value.trim();
          if (!t) { toastError('Name the new category, or pick an existing one.'); topicNew.focus(); return; }
        }
        const followUp = $('#q-fu').checked
          ? { owner: $('#q-fu-owner').value.trim(), due: $('#q-fu-due').value, done: $('#q-fu-done').checked } : null;
        d.close();
        const savedId = await saveQuestion({
          company: $('#q-company').value,
          contact: $('#q-contact').value,
          askedAt: $('#q-date').value,
          question: q.value,
          answer: a.value,
          answeredBy: $('#q-rep').value,
          topic: t,
          verdict,
          themeId: $('#q-theme').value,
          followUp,
        }, rec ? rec.id : null);
        if (savedId != null) {
          toast(rec ? 'Changes saved' : 'Question added');
          onSaved?.(savedId);
        }
      });
    },
  });
}

// ---------- Categories ----------
export function openCategoriesDialog() {
  const render = () => {
    const counts = new Map();
    state.items.forEach((i) => counts.set(i.topic, (counts.get(i.topic) || 0) + 1));
    return state.categories.map((c) => `
      <form class="cat-row" data-cat="${esc(c)}">
        <label class="visually-hidden" for="cat-${esc(c)}">Rename ${esc(c)}</label>
        <input class="input" id="cat-${esc(c)}" value="${esc(c)}">
        <span class="mono" title="Questions in this category">${counts.get(c) || 0}</span>
        <button class="btn btn-sm" type="submit">Rename</button>
        ${counts.get(c) ? '' : `<button class="icon-btn" type="button" data-remove aria-label="Remove ${esc(c)}">${icon('trash', 'icon-sm')}</button>`}
      </form>`).join('') || '<p class="muted">No categories yet.</p>';
  };

  openDialog({
    title: 'Categories',
    sub: 'Rename a category to update every question in it. Renaming to an existing name merges the two.',
    body: `<div id="cat-list" style="display:flex;flex-direction:column;gap:8px">${render()}</div>
      <form id="cat-add" class="add-row">
        <label class="visually-hidden" for="cat-new">New category</label>
        <input class="input" id="cat-new" placeholder="New category name">
        <button class="btn" type="submit">${icon('plus', 'icon-sm')}Add</button>
      </form>`,
    foot: '<div class="right"><button type="button" class="btn btn-primary" data-close>Done</button></div>',
    onMount: (d) => {
      const list = d.querySelector('#cat-list');
      const refresh = () => { list.innerHTML = render(); };
      list.addEventListener('submit', async (e) => {
        e.preventDefault();
        const from = e.target.dataset.cat;
        const to = e.target.querySelector('input').value.trim();
        if (!to || to === from) return;
        const merging = state.categories.includes(to);
        await renameCategory(from, to);
        toast(merging ? `Merged “${from}” into “${to}”` : `Renamed to “${to}”`);
        refresh();
      });
      list.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-remove]');
        if (!b) return;
        await removeCategory(b.closest('form').dataset.cat);
        refresh();
      });
      d.querySelector('#cat-add').addEventListener('submit', async (e) => {
        e.preventDefault();
        const inp = d.querySelector('#cat-new');
        const v = inp.value.trim();
        if (!v) return;
        if (state.categories.includes(v)) { toastError(`“${v}” already exists.`); return; }
        await addCategory(v);
        inp.value = '';
        refresh();
        toast(`Added “${v}”`);
      });
    },
  });
}

// ---------- Account ----------
export function openAccountDialog() {
  const u = state.user;
  openDialog({
    title: 'Account',
    body: `
      <dl class="meta-grid">
        <div><dt>Signed in as</dt><dd>${esc(u?.email || 'Unknown')}</dd></div>
        <div><dt>Questions you added</dt><dd>${state.items.filter((i) => i.createdBy === u?.email || i.createdBy === u?.uid).length}</dd></div>
      </dl>
      <div class="field">
        <span class="field-label">User ID</span>
        <div class="add-row"><code class="quote mono" style="flex:1;overflow-wrap:anywhere">${esc(u?.uid)}</code>
        <button class="btn" type="button" data-copy-uid>${icon('copy', 'icon-sm')}Copy</button></div>
        <p class="field-hint">An admin adds this ID to the Firestore rules to give you access.</p>
      </div>`,
    foot: `<button type="button" class="btn" data-signout>Sign out</button><div class="right"><button type="button" class="btn btn-primary" data-close>Done</button></div>`,
    onMount: (d) => {
      d.querySelector('[data-copy-uid]').addEventListener('click', async () => {
        if (await copyText(u.uid)) toast('User ID copied');
      });
      d.querySelector('[data-signout]').addEventListener('click', async () => {
        d.close();
        await signOut();
        toast('Signed out');
      });
    },
  });
}

// ---------- Mobile "More" menu ----------
export function openMoreDialog(actions) {
  openDialog({
    title: 'More',
    body: `<nav class="nav" aria-label="More">
      <button class="nav-link" type="button" data-act="log">${icon('plus')}Log a call</button>
      <a class="nav-link" href="#/review" data-close>${icon('review')}Review</a>
      <a class="nav-link" href="#/themes" data-close>${icon('tag')}Themes</a>
      <a class="nav-link" href="#/reps" data-close>${icon('user')}Reps</a>
      <a class="nav-link" href="#/insights" data-close>${icon('chart')}Insights</a>
      <a class="nav-link" href="#/calls" data-close>${icon('calendar')}Calls</a>
      <a class="nav-link" href="#/complete" data-close>${icon('flag')}Complete records</a>
      <a class="nav-link" href="#/rules" data-close>${icon('sliders')}Matching rules</a>
      <a class="nav-link" href="#/calibrate" data-close>${icon('check')}Calibrate matching</a>
      <button class="nav-link" type="button" data-act="import">${icon('upload')}Import</button>
      <button class="nav-link" type="button" data-act="categories">${icon('tag')}Categories</button>
      <button class="nav-link" type="button" data-act="palette">${icon('search')}Quick find</button>
      <a class="nav-link" href="${PLANNER_URL}" target="_blank" rel="noopener noreferrer">${icon('calendar')}<span class="grow">PPSC Planner</span>${icon('external', 'icon-sm')}</a>
      <button class="nav-link" type="button" data-act="account">${icon('user')}Account</button>
    </nav>`,
    onMount: (d) => {
      d.addEventListener('click', (e) => {
        const b = e.target.closest('[data-act]');
        if (!b) return;
        d.close();
        actions[b.dataset.act]?.();
      });
    },
  });
}
