import { h, clear, api } from './dom.js';

const root = document.getElementById('root');
const app = { me: null, csrf: null, filters: { q: '', location: '', vehicle: '', start: '', days: '', status: '', job: '', flag: '' }, page: 1, data: null, loading: false };

const when = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const whenLong = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', dateStyle: 'medium', timeStyle: 'short' });
const fmt = (iso) => (iso ? when.format(new Date(iso)) : '');
const fmtLong = (iso) => (iso ? whenLong.format(new Date(iso)) : '');

const call = (path, opts = {}) => api(path, { csrf: app.csrf, ...opts });

// ---------- toast ----------
let toastTimer;
function toast(msg, kind = 'ok') {
  let el = document.getElementById('toast');
  if (!el) {
    el = h('div', { id: 'toast', class: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.append(el);
  }
  el.className = `toast ${kind}`;
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4500);
}

// ---------- sign in ----------
function showLogin(message = '') {
  clear(root);
  const email = h('input', { class: 'input', id: 'email', type: 'email', autocomplete: 'username', required: true, autocapitalize: 'off', spellcheck: 'false' });
  const pass = h('input', { class: 'input', id: 'password', type: 'password', autocomplete: 'current-password', required: true });
  const err = h('p', { class: 'error-text', role: 'alert' }, message);
  const btn = h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Sign in');
  root.append(
    h(
      'main',
      { class: 'login' },
      h(
        'form',
        {
          class: 'login-card',
          onsubmit: async (e) => {
            e.preventDefault();
            btn.disabled = true;
            err.textContent = '';
            try {
              await api('/api/admin/login', { method: 'POST', body: { email: email.value, password: pass.value } });
              await boot();
            } catch (ex) {
              err.textContent = ex.message;
              btn.disabled = false;
              pass.value = '';
              pass.focus();
            }
          },
        },
        h('img', { src: '/assets/lendhand-green.png', width: 1115, height: 142, alt: 'LendHand', class: 'login-logo' }),
        h('h1', {}, 'Team sign-in'),
        h('p', { class: 'help' }, 'For authorised LendHand team members only.'),
        h('label', { for: 'email', class: 'lbl' }, 'Email'),
        email,
        h('label', { for: 'password', class: 'lbl' }, 'Password'),
        pass,
        err,
        btn
      )
    )
  );
  email.focus();
}

// ---------- dashboard ----------
async function boot() {
  try {
    app.me = await api('/api/admin/me');
    app.csrf = app.me.csrf;
  } catch (e) {
    if (e.status === 401) return showLogin();
    clear(root).append(h('p', { class: 'notice notice-error' }, e.message));
    return;
  }
  renderShell();
  await load();
}

let shell = {};
function renderShell() {
  clear(root);
  const me = app.me;
  const isAdmin = me.user.role === 'admin';
  const issues = me.config.filter((c) => !c.ok);

  shell.stats = h('div', { class: 'stats', role: 'group', 'aria-label': 'Filter by status' });
  shell.list = h('div', { class: 'list', id: 'list' });
  shell.pager = h('div', { class: 'pager' });
  shell.exportLink = h('a', { class: 'btn btn-secondary btn-sm', href: '#', download: '' }, 'Export CSV');

  const sel = (key, label, options, allLabel) =>
    h(
      'label',
      { class: 'fld' },
      h('span', {}, label),
      h(
        'select',
        {
          class: 'input input-sm',
          onchange: (e) => {
            app.filters[key] = e.target.value;
            app.page = 1;
            load();
          },
        },
        h('option', { value: '' }, allLabel),
        options.map((o) => h('option', { value: o.value, selected: app.filters[key] === o.value }, o.label))
      )
    );

  let t;
  const text = (key, label, placeholder, type = 'search') =>
    h(
      'label',
      { class: 'fld' },
      h('span', {}, label),
      h('input', {
        class: 'input input-sm',
        type,
        placeholder,
        autocomplete: 'off',
        value: app.filters[key],
        oninput: (e) => {
          clearTimeout(t);
          t = setTimeout(() => {
            app.filters[key] = e.target.value.trim();
            app.page = 1;
            load();
          }, 300);
        },
      })
    );

  const filters = h(
    'form',
    { class: 'filters', onsubmit: (e) => e.preventDefault(), 'aria-label': 'Filter candidates' },
    text('q', 'Search', 'Name, number or reference'),
    text('location', 'Location', 'e.g. Bath', 'text'),
    sel('vehicle', 'Vehicle', me.filters.vehicle, 'Any vehicle'),
    sel('start', 'Available to start', me.filters.start, 'Any start date'),
    sel('days', 'Days available', me.filters.days, 'Any days'),
    me.jobs.length > 1 ? sel('job', 'Job category', me.jobs.map((j) => ({ value: j.slug, label: j.title })), 'All categories') : null,
    h(
      'label',
      { class: 'chk' },
      h('input', { type: 'checkbox', checked: app.filters.flag === 'clarify', onchange: (e) => ((app.filters.flag = e.target.checked ? 'clarify' : ''), (app.page = 1), load()) }),
      h('span', {}, 'Asked for clarification')
    ),
    h(
      'button',
      {
        type: 'button',
        class: 'btn-text',
        onclick: () => {
          Object.keys(app.filters).forEach((k) => (app.filters[k] = ''));
          app.page = 1;
          renderShell();
          load();
        },
      },
      'Clear filters'
    )
  );

  root.append(
    h(
      'header',
      { class: 'admin-bar' },
      h('div', { class: 'wide bar' }, h('img', { src: '/assets/lendhand-green.png', width: 1115, height: 142, alt: 'LendHand', class: 'admin-logo' }), h('div', { class: 'who' }, h('span', {}, me.user.email, ' ', h('em', {}, me.user.role)), h('button', { class: 'btn btn-secondary btn-sm', onclick: signOut }, 'Sign out')))
    ),
    h(
      'main',
      { class: 'wide dash' },
      h('div', { class: 'dash-head' }, h('h1', {}, 'Candidates'), isAdmin ? shell.exportLink : null),
      issues.length
        ? h(
            'details',
            { class: 'setup' },
            h('summary', {}, `Setup checklist: ${issues.length} thing${issues.length === 1 ? '' : 's'} to finish before launch`),
            h('ul', {}, me.config.map((c) => h('li', { class: c.ok ? 'ok' : 'todo-item' }, h('strong', {}, c.ok ? 'Done: ' : 'To do: '), `${c.label}. ${c.detail}`, c.ok ? null : h('code', {}, ` ${c.key}`))))
          )
        : null,
      shell.stats,
      filters,
      shell.list,
      shell.pager
    )
  );
}

async function signOut() {
  try {
    await call('/api/admin/logout', { method: 'POST' });
  } catch {
    /* already signed out */
  }
  app.me = null;
  showLogin();
}

function queryString(extra = {}) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(app.filters)) if (v) p.set(k, v);
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  return p.toString();
}

let loadSeq = 0;
async function load() {
  const seq = ++loadSeq;
  try {
    const data = await call(`/api/admin/candidates?${queryString({ page: app.page, pageSize: 25 })}`);
    if (seq !== loadSeq) return;
    app.data = data;
    paint();
  } catch (e) {
    if (e.status === 401) return showLogin('Your session has ended. Please sign in again.');
    clear(shell.list).append(h('p', { class: 'notice notice-error', role: 'alert' }, e.message));
  }
}

const STATUS_CLASS = { new: 'st-new', contacted: 'st-contacted', under_review: 'st-review', onboarded: 'st-onboarded', closed: 'st-closed' };

function paint() {
  const { items, total, counts, page, pageSize } = app.data;
  const all = Object.values(counts).reduce((a, b) => a + b, 0);

  clear(shell.stats).append(
    statBtn('', 'All', all),
    ...app.me.statuses.map((s) => statBtn(s.value, s.label, counts[s.value] || 0))
  );

  if (shell.exportLink.isConnected) shell.exportLink.href = `/api/admin/export.csv?${queryString()}`;

  clear(shell.list);
  if (!items.length) {
    shell.list.append(
      h('p', { class: 'empty' }, all === 0 ? "No registrations yet. They'll appear here as soon as someone applies." : 'No candidates match these filters.')
    );
  }
  for (const c of items) shell.list.append(row(c));

  const from = total ? (page - 1) * pageSize + 1 : 0;
  const to = Math.min(total, page * pageSize);
  clear(shell.pager).append(
    h('span', {}, total ? `Showing ${from} to ${to} of ${total}` : ''),
    h(
      'div',
      { class: 'pager-btns' },
      h('button', { class: 'btn btn-secondary btn-sm', disabled: page <= 1, onclick: () => ((app.page = page - 1), load(), window.scrollTo({ top: 0 })) }, 'Previous'),
      h('button', { class: 'btn btn-secondary btn-sm', disabled: to >= total, onclick: () => ((app.page = page + 1), load(), window.scrollTo({ top: 0 })) }, 'Next')
    )
  );
}

function statBtn(value, label, n) {
  return h(
    'button',
    {
      type: 'button',
      class: `stat ${app.filters.status === value ? 'on' : ''}`,
      'aria-pressed': app.filters.status === value ? 'true' : 'false',
      onclick: () => {
        app.filters.status = value;
        app.page = 1;
        load();
      },
    },
    h('strong', {}, String(n)),
    h('span', {}, label)
  );
}

function answerOf(c, id) {
  return c.answers.find((a) => a.id === id)?.value || '';
}

function statusSelect(c, onDone) {
  return h(
    'select',
    {
      class: `input input-sm status ${STATUS_CLASS[c.status] || ''}`,
      'aria-label': `Status for ${c.name}`,
      onclick: (e) => e.stopPropagation(),
      onchange: async (e) => {
        e.stopPropagation();
        const select = e.target;
        const previous = c.status;
        try {
          const updated = await call(`/api/admin/candidates/${c.id}`, { method: 'PATCH', body: { status: select.value } });
          Object.assign(c, updated);
          select.className = `input input-sm status ${STATUS_CLASS[c.status] || ''}`;
          toast(`${c.name} marked as ${app.me.statuses.find((s) => s.value === c.status).label}.`);
          onDone && onDone(updated);
          refreshCounts();
        } catch (ex) {
          select.value = previous;
          toast(ex.message, 'err');
        }
      },
    },
    app.me.statuses.map((s) => h('option', { value: s.value, selected: c.status === s.value }, s.label))
  );
}

async function refreshCounts() {
  try {
    const d = await call(`/api/admin/candidates?${queryString({ page: app.page, pageSize: 25 })}`);
    app.data.counts = d.counts;
    clear(shell.stats).append(statBtn('', 'All', Object.values(d.counts).reduce((a, b) => a + b, 0)), ...app.me.statuses.map((s) => statBtn(s.value, s.label, d.counts[s.value] || 0)));
  } catch {
    /* counts will refresh on the next load */
  }
}

function row(c) {
  const meta = [c.area, answerOf(c, 'vehicle'), answerOf(c, 'start') && `Start: ${answerOf(c, 'start')}`, answerOf(c, 'days') && answerOf(c, 'days')].filter(Boolean);
  return h(
    'article',
    { class: 'row' },
    h(
      'button',
      { class: 'row-main', onclick: () => openDetail(c.id), 'aria-label': `Open details for ${c.name}` },
      h('span', { class: 'name' }, c.name, c.clarificationRequestedAt ? h('span', { class: 'flag' }, 'Asked for clarification') : null, c.rightToWork === 'no' ? h('span', { class: 'flag flag-warn' }, 'No Right to Work declared') : null),
      h('span', { class: 'meta' }, meta.join('  |  ')),
      h('span', { class: 'when' }, `${c.phoneDisplay}  |  Applied ${fmt(c.createdAt)}`)
    ),
    statusSelect(c)
  );
}

// ---------- detail dialog ----------
async function openDetail(id) {
  let c;
  try {
    c = await call(`/api/admin/candidates/${id}`);
  } catch (e) {
    return toast(e.message, 'err');
  }
  const isAdmin = app.me.user.role === 'admin';
  const dlg = h('dialog', { class: 'detail', 'aria-labelledby': 'dlg-title' });
  const notes = h('textarea', { class: 'input notes', rows: 5, maxlength: 2000, 'aria-label': 'Notes' }, c.notes);
  notes.value = c.notes;
  const saveNotes = h('button', { class: 'btn btn-secondary btn-sm', type: 'button' }, 'Save notes');
  saveNotes.onclick = async () => {
    saveNotes.disabled = true;
    try {
      await call(`/api/admin/candidates/${c.id}`, { method: 'PATCH', body: { notes: notes.value } });
      toast('Notes saved.');
    } catch (e) {
      toast(e.message, 'err');
    }
    saveNotes.disabled = false;
  };

  const deleteZone = h('div', { class: 'danger-zone' });
  const showDeleteBtn = () =>
    clear(deleteZone).append(h('button', { class: 'btn btn-secondary btn-sm', type: 'button', onclick: showConfirm }, 'Delete this record'));
  const showConfirm = () =>
    clear(deleteZone).append(
      h('p', {}, `Permanently delete ${c.name}'s record (${c.ref})? This can't be undone.`),
      h(
        'div',
        { class: 'row-btns' },
        h(
          'button',
          {
            class: 'btn btn-danger btn-sm',
            type: 'button',
            onclick: async () => {
              try {
                await call(`/api/admin/candidates/${c.id}`, { method: 'DELETE' });
                dlg.close();
                toast('Record deleted.');
                load();
              } catch (e) {
                toast(e.message, 'err');
              }
            },
          },
          'Yes, delete permanently'
        ),
        h('button', { class: 'btn btn-secondary btn-sm', type: 'button', onclick: showDeleteBtn }, 'Keep it')
      )
    );
  showDeleteBtn();

  const waDigits = c.phone.replace(/\D/g, '');
  dlg.append(
    h(
      'div',
      { class: 'detail-body' },
      h('div', { class: 'detail-head' }, h('div', {}, h('h2', { id: 'dlg-title' }, c.name), h('p', { class: 'ref' }, `${c.ref}  |  ${c.jobTitle}  |  Applied ${fmtLong(c.createdAt)}`)), h('button', { class: 'btn btn-secondary btn-sm', type: 'button', onclick: () => dlg.close(), 'aria-label': 'Close details' }, 'Close')),
      h('div', { class: 'contact' }, h('a', { class: 'btn btn-primary btn-sm', href: `tel:${c.phone}` }, `Call ${c.phoneDisplay}`), h('a', { class: 'btn btn-secondary btn-sm', href: `https://wa.me/${waDigits}`, target: '_blank', rel: 'noopener noreferrer' }, 'Message on WhatsApp')),
      c.clarificationRequestedAt ? h('p', { class: 'notice' }, `This candidate asked for clarification about the Right to Work on ${fmtLong(c.clarificationRequestedAt)}.`) : null,
      h('label', { class: 'lbl' }, 'Status', statusSelect(c, () => {})),
      h(
        'dl',
        { class: 'answers' },
        h('div', {}, h('dt', {}, 'Area'), h('dd', {}, c.area)),
        c.answers.map((a) => h('div', {}, h('dt', {}, a.label), h('dd', {}, a.value || 'Not answered'))),
        h('div', {}, h('dt', {}, 'Privacy Notice'), h('dd', {}, `Acknowledged ${fmtLong(c.consents.privacyAckAt)} (version ${c.consents.noticeVersion})`)),
        h('div', {}, h('dt', {}, 'Job updates'), h('dd', {}, c.consents.updates ? 'Opted in' : 'Not opted in')),
        h('div', {}, h('dt', {}, 'WhatsApp community'), h('dd', {}, c.consents.whatsapp ? 'Asked to be invited' : 'Did not ask')),
        c.source ? h('div', {}, h('dt', {}, 'Source'), h('dd', {}, c.source)) : null
      ),
      h('label', { class: 'lbl' }, 'Notes (visible to the team only)', notes),
      saveNotes,
      isAdmin ? deleteZone : null
    )
  );
  dlg.addEventListener('close', () => {
    dlg.remove();
    load();
  });
  document.body.append(dlg);
  dlg.showModal();
}

boot();
