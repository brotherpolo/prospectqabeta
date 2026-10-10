import { esc, icon } from './utils.js';

// ---------- Toasts ----------
export function toast(message, { action, tone, duration } = {}) {
  const region = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = 'toast';
  if (tone) el.dataset.tone = tone;
  el.setAttribute('role', tone === 'error' ? 'alert' : 'status');
  el.innerHTML = `<span>${esc(message)}</span>`;
  let timer;
  const remove = () => { clearTimeout(timer); el.remove(); };
  if (action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = action.label;
    b.addEventListener('click', () => { remove(); action.run(); });
    el.appendChild(b);
  }
  region.appendChild(el);
  while (region.children.length > 3) region.firstElementChild.remove();
  timer = setTimeout(remove, duration ?? (action ? 9000 : tone === 'error' ? 7000 : 3500));
  return remove;
}

export const toastError = (msg) => toast(msg, { tone: 'error' });

// ---------- Dialogs (one native <dialog>, reused) ----------
const dlg = () => document.getElementById('dialog');
let closeHandler = null;

export function openDialog({ title, sub = '', body = '', foot = '', between = '', wide = false, raw = null, label, onMount, onClose }) {
  const d = dlg();
  if (d.open) d.close();
  d.className = `dialog${wide ? ' wide' : ''}`;
  if (raw != null) {
    d.innerHTML = raw;
    d.setAttribute('aria-label', label || title || 'Dialog');
    d.removeAttribute('aria-labelledby');
  } else {
    d.removeAttribute('aria-label');
    d.setAttribute('aria-labelledby', 'dlg-title');
    d.innerHTML = `
      <div class="dlg">
        <div class="dlg-head">
          <div><h2 class="dlg-title" id="dlg-title">${esc(title)}</h2>${sub ? `<p class="dlg-sub">${sub}</p>` : ''}</div>
          <button type="button" class="icon-btn" data-close aria-label="Close">${icon('x', 'icon-sm')}</button>
        </div>
        ${between}
        <div class="dlg-body">${body}</div>
        ${foot ? `<div class="dlg-foot">${foot}</div>` : ''}
      </div>`;
  }
  closeHandler = onClose || null;
  d.onclick = (e) => {
    if (e.target === d || e.target.closest('[data-close]')) d.close();
  };
  d.onclose = () => {
    const h = closeHandler;
    closeHandler = null;
    d.onclick = null;
    h?.();
  };
  d.showModal();
  onMount?.(d);
  return d;
}

export const closeDialog = () => { if (dlg().open) dlg().close(); };

export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let result = false;
    openDialog({
      title,
      body: `<p>${message}</p>`,
      foot: `<div class="right">
        <button type="button" class="btn" data-close>Cancel</button>
        <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${esc(confirmLabel)}</button>
      </div>`,
      onMount: (d) => {
        const ok = d.querySelector('[data-ok]');
        ok.focus();
        ok.addEventListener('click', () => { result = true; d.close(); });
      },
      onClose: () => resolve(result),
    });
  });
}
