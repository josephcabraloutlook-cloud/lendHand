import { h, clear, svgCheck, api } from './dom.js';

const app = document.getElementById('app');
const progressBox = document.getElementById('progress');
const progressLabel = document.getElementById('progress-label');
const progressFill = document.getElementById('progress-fill');
const progressTrack = document.getElementById('progress-track');

const state = {
  job: null,
  token: null,
  step: 0,
  answers: {},
  consent: { privacy: false, updates: false, whatsapp: false },
  errors: {},
  editing: false,
  submitting: false,
  done: false,
  banner: null,
};

const src = (() => {
  const p = new URLSearchParams(location.search);
  const v = p.get('src') || p.get('utm_source') || '';
  return /^[a-z0-9_.-]{1,40}$/i.test(v) ? v : null;
})();

// ---------- light client-side validation (the server is the authority) ----------
function normalisePhone(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim().replace(/[\s().-]/g, '');
  if (!/^\+?\d+$/.test(s)) return null;
  if (s.startsWith('0044')) s = '+44' + s.slice(4);
  else if (s.startsWith('+44')) s = '+44' + s.slice(3).replace(/^0/, '');
  else if (/^44\d{10}$/.test(s)) s = '+' + s;
  else if (s.startsWith('0')) s = '+44' + s.slice(1);
  else if (/^7\d{9}$/.test(s)) s = '+44' + s;
  else if (!s.startsWith('+')) return null;
  if (s.startsWith('+44')) return /^\+447[1-9]\d{8}$/.test(s) ? s : null;
  return /^\+[1-9]\d{7,14}$/.test(s) ? s : null;
}
function formatPhone(raw) {
  const p = normalisePhone(raw);
  if (p && /^\+447\d{9}$/.test(p)) {
    const n = '0' + p.slice(3);
    return `${n.slice(0, 5)} ${n.slice(5)}`;
  }
  return p || raw;
}

function checkField(f, v) {
  if (f.type === 'text') {
    const s = String(v || '').trim().replace(/\s+/g, ' ');
    if (s.length < 2) return 'Please answer this question.';
    if (f.id === 'full_name' && !/\s/.test(s)) return 'Please enter your first name and surname.';
    return '';
  }
  if (f.type === 'phone') return normalisePhone(String(v || '')) ? '' : 'Please enter a valid mobile number, for example 07123 456789.';
  if (f.type === 'choice') return v ? '' : 'Please choose one of the options.';
  if (f.type === 'multi') return Array.isArray(v) && v.length ? '' : 'Please choose at least one option.';
  return '';
}

function displayValue(f, v) {
  if (f.type === 'choice') return f.options.find((o) => o.value === v)?.label || '';
  if (f.type === 'multi') {
    const arr = v || [];
    if (f.allOption && f.options.every((o) => arr.includes(o.value))) return f.allOption.label;
    return f.options.filter((o) => arr.includes(o.value)).map((o) => o.label).join(', ');
  }
  if (f.type === 'phone') return formatPhone(v);
  return v || '';
}

// ---------- chrome ----------
function setProgress() {
  const total = state.job.fields.length + 1;
  const n = Math.min(state.step + 1, total);
  progressBox.hidden = state.done;
  progressLabel.textContent = state.step >= state.job.fields.length ? 'Almost done' : `Question ${n} of ${total}`;
  progressFill.style.setProperty('--p', `${Math.round((n / total) * 100)}%`);
  progressTrack.setAttribute('aria-valuenow', String(Math.round((n / total) * 100)));
}

function goto(step, { push = true } = {}) {
  state.step = step;
  if (push) history.pushState({ step }, '');
  else history.replaceState({ step }, '');
  render();
}

window.addEventListener('popstate', (e) => {
  if (state.done || !state.job) return;
  state.step = e.state && Number.isInteger(e.state.step) ? e.state.step : 0;
  state.editing = false;
  render();
});

// ---------- questions ----------
function next() {
  const f = state.job.fields[state.step];
  const err = checkField(f, state.answers[f.id]);
  if (err) {
    state.errors[f.id] = err;
    return render({ keepFocus: true });
  }
  delete state.errors[f.id];
  if (state.editing) {
    state.editing = false;
    return goto(state.job.fields.length);
  }
  goto(state.step + 1);
}

function back() {
  if (state.editing) {
    state.editing = false;
    return goto(state.job.fields.length);
  }
  goto(Math.max(0, state.step - 1), { push: false });
}

function actionsBar({ primaryLabel, formId, showBack }) {
  return h(
    'div',
    { class: 'actions' },
    h(
      'div',
      { class: 'actions-inner' },
      showBack ? h('button', { type: 'button', class: 'btn-text', onclick: back }, 'Back') : null,
      h('button', { type: 'submit', class: 'btn btn-primary btn-lg', form: formId, id: 'primary-action' }, primaryLabel)
    )
  );
}

function renderQuestion() {
  const f = state.job.fields[state.step];
  const errorId = 'q-error';
  const helpId = 'q-help';
  const describedBy = [f.help ? helpId : '', errorId].filter(Boolean).join(' ');
  let control;
  let focusTarget = null;

  const errP = h('p', { class: 'error-text', id: errorId, role: 'alert' }, state.errors[f.id] || '');

  if (f.type === 'text' || f.type === 'phone') {
    const input = h('input', {
      class: 'input',
      id: 'q-input',
      name: f.id,
      type: f.type === 'phone' ? 'tel' : 'text',
      inputmode: f.inputmode,
      autocomplete: f.autocomplete || 'off',
      enterkeyhint: 'next',
      maxlength: f.maxLength,
      placeholder: f.placeholder,
      spellcheck: 'false',
      autocapitalize: f.id === 'full_name' || f.id === 'area' ? 'words' : 'off',
      'aria-labelledby': 'q-title',
      'aria-describedby': describedBy,
      'aria-invalid': state.errors[f.id] ? 'true' : 'false',
      value: state.answers[f.id] || '',
      oninput: (e) => {
        state.answers[f.id] = e.target.value;
        if (state.errors[f.id]) {
          delete state.errors[f.id];
          errP.textContent = '';
          input.setAttribute('aria-invalid', 'false');
        }
      },
    });
    focusTarget = input;
    control = h(
      'div',
      { class: 'field' },
      input,
      errP,
      f.suggestions
        ? h(
            'div',
            { class: 'chips' },
            h('span', { class: 'chips-label' }, 'For example:'),
            f.suggestions.map((s) =>
              h(
                'button',
                {
                  type: 'button',
                  class: 'chip',
                  onclick: () => {
                    input.value = s;
                    state.answers[f.id] = s;
                    delete state.errors[f.id];
                    errP.textContent = '';
                    input.setAttribute('aria-invalid', 'false');
                    input.focus();
                  },
                },
                s
              )
            )
          )
        : null
    );
  } else if (f.type === 'choice') {
    const note = h('div', { class: 'choice-note', role: 'status', hidden: true });
    const showNote = () => {
      const t = f.notes && f.notes[state.answers[f.id]];
      note.hidden = !t;
      note.textContent = t || '';
    };
    const group = h(
      'div',
      { class: 'choices', role: 'radiogroup', 'aria-labelledby': 'q-title', 'aria-describedby': describedBy },
      f.options.map((o) =>
        h(
          'label',
          { class: 'choice' },
          h('input', {
            type: 'radio',
            name: f.id,
            value: o.value,
            checked: state.answers[f.id] === o.value,
            onclick: (e) => {
              state.answers[f.id] = o.value;
              delete state.errors[f.id];
              errP.textContent = '';
              showNote();
              // Pointer taps move on automatically; keyboard users press Continue. Options with a note wait so it can be read.
              if (e.detail > 0 && !(f.notes && f.notes[o.value])) setTimeout(next, 240);
            },
          }),
          h('span', { class: 'card' }, o.label)
        )
      )
    );
    showNote();
    control = h('div', { class: 'field' }, group, note, errP);
  } else if (f.type === 'multi') {
    const boxes = [];
    const sync = () => {
      const chosen = boxes.filter((b) => b.el.checked && b.value !== '__all').map((b) => b.value);
      state.answers[f.id] = chosen;
      const all = boxes.find((b) => b.value === '__all');
      if (all) all.el.checked = chosen.length === f.options.length;
      delete state.errors[f.id];
      errP.textContent = '';
    };
    const mk = (value, label, checked, onchange) => {
      const el = h('input', { type: 'checkbox', value, checked, onchange });
      boxes.push({ el, value });
      return h('label', { class: 'choice' }, el, h('span', { class: 'card' }, label));
    };
    const current = state.answers[f.id] || [];
    const items = f.options.map((o) => mk(o.value, o.label, current.includes(o.value), sync));
    if (f.allOption) {
      items.push(
        mk('__all', f.allOption.label, f.options.every((o) => current.includes(o.value)), (e) => {
          for (const b of boxes) if (b.value !== '__all') b.el.checked = e.target.checked;
          sync();
        })
      );
    }
    control = h('div', { class: 'field' }, h('div', { class: 'choices', role: 'group', 'aria-labelledby': 'q-title', 'aria-describedby': describedBy }, items), errP);
  }

  const formId = 'qform';
  const form = h(
    'form',
    { class: 'q', id: formId, novalidate: true, onsubmit: (e) => (e.preventDefault(), next()) },
    h('h1', { id: 'q-title', tabindex: '-1' }, f.label),
    f.help ? h('p', { class: 'help', id: helpId }, f.help) : null,
    control,
    actionsBar({ primaryLabel: 'Continue', formId, showBack: state.step > 0 || state.editing })
  );
  return { node: form, focus: focusTarget || form.querySelector('#q-title') };
}

// ---------- review + submit ----------
function renderReview() {
  const formId = 'review-form';
  const privacyBox = h('input', {
    type: 'checkbox',
    id: 'c-privacy',
    checked: state.consent.privacy,
    'aria-describedby': 'privacy-error',
    'aria-invalid': state.errors.privacy ? 'true' : 'false',
    onchange: (e) => {
      state.consent.privacy = e.target.checked;
      if (e.target.checked) {
        delete state.errors.privacy;
        privacyErr.textContent = '';
        privacyBox.setAttribute('aria-invalid', 'false');
      }
    },
  });
  const privacyErr = h('p', { class: 'error-text', id: 'privacy-error', role: 'alert' }, state.errors.privacy || '');

  const summary = h(
    'dl',
    { class: 'summary' },
    state.job.fields.map((f, i) =>
      h(
        'div',
        { class: 'summary-row' },
        h('div', {}, h('dt', {}, f.summaryLabel), h('dd', {}, displayValue(f, state.answers[f.id]))),
        h(
          'button',
          {
            type: 'button',
            class: 'btn-text',
            'aria-label': `Change: ${f.summaryLabel}`,
            onclick: () => {
              state.editing = true;
              goto(i);
            },
          },
          'Change'
        )
      )
    )
  );

  const form = h(
    'form',
    { class: 'q', id: formId, novalidate: true, onsubmit: (e) => (e.preventDefault(), submit()) },
    h('h1', { id: 'q-title', tabindex: '-1' }, 'Check your details'),
    h('p', { class: 'help' }, 'Take a quick look, then tick the box below to send them to us.'),
    state.banner ? h('div', { class: 'notice notice-error', role: 'alert' }, state.banner) : null,
    summary,
    h('p', { class: 'legend', id: 'consent-legend' }, 'Your choices'),
    h(
      'div',
      { class: 'consents', role: 'group', 'aria-labelledby': 'consent-legend' },
      h(
        'label',
        { class: 'check', for: 'c-privacy' },
        privacyBox,
        h(
          'div',
          {},
          h('strong', {}, 'I have read the Privacy Notice (required)'),
          h(
            'span',
            {},
            'We use your details to review your interest and contact you about suitable opportunities. ',
            h('a', { href: '/privacy', target: '_blank', rel: 'noopener' }, 'Read the Privacy Notice'),
            ' (opens in a new tab).'
          )
        )
      ),
      privacyErr,
      h(
        'label',
        { class: 'check' },
        h('input', { type: 'checkbox', checked: state.consent.updates, onchange: (e) => (state.consent.updates = e.target.checked) }),
        h('div', {}, h('strong', {}, 'Send me job updates ', h('span', { class: 'opt' }, '(optional)')), h('span', {}, 'Messages about delivery opportunities in your area. You can opt out at any time.'))
      ),
      h(
        'label',
        { class: 'check' },
        h('input', { type: 'checkbox', checked: state.consent.whatsapp, onchange: (e) => (state.consent.whatsapp = e.target.checked) }),
        h(
          'div',
          {},
          h('strong', {}, 'Invite me to the WhatsApp community ', h('span', { class: 'opt' }, '(optional)')),
          h('span', {}, "Group members may be able to see each other's phone numbers and profile information. Joining doesn't guarantee a job.")
        )
      )
    ),
    // Honeypot: hidden from people, tempting to bots.
    h('div', { class: 'hp', 'aria-hidden': 'true' }, h('label', {}, 'Website', h('input', { type: 'text', name: 'website', id: 'hp-website', tabindex: '-1', autocomplete: 'off' }))),
    actionsBar({ primaryLabel: state.submitting ? 'Sending…' : 'Submit my details', formId, showBack: true })
  );
  if (state.submitting) form.querySelector('#primary-action').disabled = true;
  return { node: form, focus: form.querySelector('#q-title') };
}

async function submit() {
  if (state.submitting) return;
  if (!state.consent.privacy) {
    state.errors.privacy = 'Please confirm you have read the Privacy Notice to continue.';
    render();
    document.getElementById('c-privacy')?.focus();
    return;
  }
  state.submitting = true;
  state.banner = null;
  render({ keepFocus: true });
  const hp = document.getElementById('hp-website')?.value || '';
  try {
    const res = await api(`/api/apply/${state.job.slug}`, {
      method: 'POST',
      body: { answers: state.answers, consent: state.consent, token: state.token, website: hp, src },
    });
    state.done = true;
    state.submitting = false;
    history.replaceState({ step: -1 }, '');
    renderDone(res);
  } catch (err) {
    state.submitting = false;
    const fields = err.data && err.data.fields;
    if (fields) {
      const first = state.job.fields.findIndex((f) => fields[f.id]);
      Object.assign(state.errors, fields);
      if (first >= 0) {
        state.editing = true;
        return goto(first);
      }
      state.banner = 'Please check your choices below.';
    } else if (err.data && err.data.code === 'token') {
      state.banner = 'This page has been open for a while. Please reload it to continue. Your answers will need entering again.';
    } else {
      state.banner = err.message;
    }
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

// ---------- success ----------
function renderDone(res) {
  const o = res.outcome;
  progressBox.hidden = true;
  app.classList.add('is-done');
  clear(app);

  const blocks = [
    h('div', { class: 'done-badge' }, svgCheck(38)),
    h('h1', { id: 'q-title', tabindex: '-1' }, "You're All Set!"),
    h('p', { class: 'lead' }, "Thanks for registering with LendHand. We've received your details."),
    h('p', {}, "Registering your interest isn't a job offer. If a suitable opportunity is available, our team may contact you on the number you gave us about the next steps."),
  ];

  if (o.rightToWork === 'no') {
    blocks.push(
      h(
        'section',
        { class: 'panel' },
        h('h2', {}, 'About the Right to Work in the UK'),
        h('p', {}, "The roles we're recruiting for at the moment need the Right to Work in the UK, so we may not be able to take your details further right now."),
        h('p', {}, "Thank you for being straight with us. If your circumstances change, you're welcome to register again."),
        o.whatsapp.requested ? h('p', {}, "Because of this, we won't be sending you an invitation to our WhatsApp community for these roles.") : null
      )
    );
  } else if (o.rightToWork === 'unsure') {
    const slot = h('div', { class: 'panel-slot' });
    const askBtn = h(
      'button',
      {
        type: 'button',
        class: 'btn btn-secondary',
        onclick: async () => {
          askBtn.disabled = true;
          try {
            await api('/api/clarify', { method: 'POST', body: { ref: res.ref, receipt: res.receipt } });
            clear(slot).append(h('p', { role: 'status' }, "Thanks. We've noted that you'd like to talk it through, and a team member will get in touch."));
          } catch (err) {
            askBtn.disabled = false;
            clear(slot).append(h('p', { class: 'error-text', role: 'alert' }, err.message), askBtn);
          }
        },
      },
      'Ask us to clarify'
    );
    if (o.canRequestClarification) slot.append(askBtn);
    else slot.append(h('p', {}, 'Mention it when we get in touch and we can talk it through.'));
    blocks.push(
      h(
        'section',
        { class: 'panel' },
        h('h2', {}, 'Not sure about your Right to Work?'),
        h('p', {}, "That's okay. It depends on each person's circumstances, and we never make assumptions based on nationality. If you'd like us to talk it through with you, just ask."),
        slot
      )
    );
  }

  if (o.whatsapp.eligible) {
    blocks.push(
      h(
        'section',
        { class: 'panel' },
        h('h2', {}, 'Want to stay updated on delivery opportunities in your area?'),
        h(
          'ul',
          {},
          h('li', {}, "Group members may be able to see each other's phone numbers and profile information."),
          h('li', {}, "Joining the group doesn't guarantee a job, and it doesn't replace our recruitment checks."),
          h('li', {}, 'You can leave the group whenever you like.')
        ),
        o.whatsapp.url ? null : h('p', { class: 'notice notice-warn' }, "Our WhatsApp community isn't open yet. We'll let you know as soon as it is.")
      )
    );
    const actions = h('div', { class: 'done-actions' });
    if (o.whatsapp.url) {
      actions.append(h('a', { class: 'btn btn-primary btn-lg', href: o.whatsapp.url, target: '_blank', rel: 'noopener noreferrer' }, 'Join Our WhatsApp Community'));
    }
    actions.append(h('a', { class: 'btn btn-secondary', href: '/' }, o.whatsapp.url ? 'Finish Without Joining' : 'Finish'));
    blocks.push(actions);
  } else {
    blocks.push(h('div', { class: 'done-actions' }, h('a', { class: 'btn btn-primary btn-lg', href: '/' }, 'Finish')));
  }

  if (res.ref) blocks.push(h('p', { class: 'ref' }, `Your reference: ${res.ref}`));
  app.append(h('div', { class: 'done q' }, blocks));
  document.getElementById('q-title').focus();
  window.scrollTo({ top: 0 });
}

// ---------- render loop ----------
function render({ keepFocus = false } = {}) {
  setProgress();
  const activeId = keepFocus ? document.activeElement && document.activeElement.id : null;
  clear(app);
  const { node, focus } = state.step >= state.job.fields.length ? renderReview() : renderQuestion();
  app.append(node);
  const restore = activeId && document.getElementById(activeId);
  (restore || focus)?.focus({ preventScroll: false });
}

// ---------- start ----------
async function start() {
  try {
    let slug = (location.pathname.match(/^\/apply\/([a-z0-9-]+)/) || [])[1] || new URLSearchParams(location.search).get('job');
    if (!slug) slug = (await api('/api/jobs')).jobs[0]?.slug;
    if (!slug) throw new Error('There are no roles open for registration right now.');
    const job = await api(`/api/jobs/${slug}`);
    state.job = job;
    state.token = job.token;
    history.replaceState({ step: 0 }, '');
    clear(app);
    render();
  } catch (err) {
    clear(app).append(
      h('div', { class: 'q' }, h('h1', {}, "We couldn't load the form"), h('p', { class: 'help' }, err.message), h('p', { class: 'field' }, h('button', { class: 'btn btn-primary', onclick: () => location.reload() }, 'Try again')))
    );
  }
}
start();
