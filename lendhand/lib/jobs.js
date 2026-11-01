// Job categories and their registration forms.
//
// To add a new category (warehouse, cleaning, admin...), add another object to JOBS with its own
// `fields`. The public form, server-side validation, dashboard detail view and CSV export all read
// from this one definition, so no page or database changes are needed. Answers are stored as JSON.
//
// Field types: text | phone | choice | multi
// Three fields are stored in their own columns: full_name, phone, area (and right_to_work for eligibility).

const YES_NO_UNSURE = [
  { value: 'yes', label: 'Yes' },
  { value: 'no', label: 'No' },
  { value: 'unsure', label: "I'm not sure" },
];

export const JOBS = [
  {
    slug: 'delivery-driver',
    title: 'Delivery driver',
    area: 'Bath and surrounding areas',
    active: true,
    requiresRightToWork: true,
    fields: [
      {
        id: 'full_name',
        type: 'text',
        label: 'What is your full name?',
        help: 'First name and surname.',
        placeholder: 'e.g. Alex Morgan',
        autocomplete: 'name',
        maxLength: 100,
        summaryLabel: 'Name',
      },
      {
        id: 'phone',
        type: 'phone',
        label: 'What is your mobile / WhatsApp number?',
        help: "We'll use this to contact you about opportunities.",
        placeholder: '07123 456789',
        autocomplete: 'tel',
        inputmode: 'tel',
        summaryLabel: 'Mobile',
      },
      {
        id: 'area',
        type: 'text',
        label: 'What area do you live in?',
        help: 'Your town or area is plenty. Please do not enter your full address.',
        placeholder: 'e.g. Bath',
        autocomplete: 'address-level2',
        maxLength: 80,
        suggestions: ['Bath', 'Bristol', 'Keynsham'],
        summaryLabel: 'Area',
      },
      {
        id: 'right_to_work',
        type: 'choice',
        label: 'Do you currently have the Right to Work in the UK?',
        help: "This is a first self-declaration only. We don't ask for any immigration documents or ID here. Checks happen later, when appropriate.",
        options: YES_NO_UNSURE,
        summaryLabel: 'Right to Work (self-declared)',
      },
      {
        id: 'licence',
        type: 'choice',
        label: 'Do you hold a full driving licence valid for driving in the UK?',
        help: 'A simple yes or no is fine. Please do not upload or send photos of your licence.',
        options: YES_NO_UNSURE,
        notes: {
          no: 'You can still register your interest. We confirm the requirements for each role before anything is offered.',
          unsure: 'No problem. We can talk it through with you later.',
        },
        summaryLabel: 'Full UK driving licence',
      },
      {
        id: 'vehicle',
        type: 'choice',
        label: 'Which type of delivery opportunity interests you?',
        help: 'Vehicle availability and terms are confirmed before any role is offered.',
        options: [
          { value: 'own_car', label: 'I have my own car' },
          { value: 'company_van', label: 'I would prefer a company-provided van' },
          { value: 'both', label: "I'm open to both" },
        ],
        summaryLabel: 'Vehicle',
      },
      {
        id: 'experience',
        type: 'choice',
        label: 'Do you have previous delivery driver experience?',
        help: 'No experience is not an automatic rejection.',
        options: [
          { value: 'yes', label: 'Yes' },
          { value: 'no', label: 'No' },
        ],
        summaryLabel: 'Delivery experience',
      },
      {
        id: 'start',
        type: 'choice',
        label: 'When are you available to start?',
        options: [
          { value: 'immediately', label: 'Immediately' },
          { value: '1_week', label: 'Within 1 week' },
          { value: '2_weeks', label: 'Within 2 weeks' },
          { value: 'later', label: 'Later' },
        ],
        summaryLabel: 'Available to start',
      },
      {
        id: 'days',
        type: 'multi',
        label: 'What days are you generally available?',
        help: 'Choose all that apply.',
        options: [
          { value: 'weekdays', label: 'Weekdays' },
          { value: 'weekends', label: 'Weekends' },
        ],
        // Adds a convenience "Both" button that selects every option.
        allOption: { label: 'Both' },
        summaryLabel: 'Days available',
      },
    ],
  },
];

export const STATUSES = [
  { value: 'new', label: 'New' },
  { value: 'contacted', label: 'Contacted' },
  { value: 'under_review', label: 'Under Review' },
  { value: 'onboarded', label: 'Onboarded' },
  { value: 'closed', label: 'Closed' },
];
export const STATUS_VALUES = STATUSES.map((s) => s.value);

export function getJob(slug) {
  return JOBS.find((j) => j.slug === slug && j.active) || null;
}
export function getJobAny(slug) {
  return JOBS.find((j) => j.slug === slug) || null;
}

// The subset of a field definition that is safe and useful to send to the browser.
export function publicField(f) {
  const out = {
    id: f.id,
    type: f.type,
    label: f.label,
    summaryLabel: f.summaryLabel || f.label,
  };
  for (const k of ['help', 'placeholder', 'autocomplete', 'inputmode', 'maxLength', 'options', 'suggestions', 'notes', 'allOption']) {
    if (f[k] !== undefined) out[k] = f[k];
  }
  return out;
}

// ---------- validation ----------

const CONTROL = /[\u0000-\u001f\u007f]/g;
const clean = (s) => String(s).replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();

const NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M}' .’-]*$/u;
const AREA_RE = /^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N}' .,&’/-]*$/u;

/** Normalise a phone number. UK mobiles become +447XXXXXXXXX; other international numbers must start with +. */
export function normalisePhone(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim().replace(/[\s().-]/g, '');
  if (!/^\+?\d+$/.test(s)) return null;
  if (s.startsWith('0044')) s = '+44' + s.slice(4);
  else if (s.startsWith('+44')) s = '+44' + s.slice(3).replace(/^0/, '');
  else if (/^44\d{10}$/.test(s)) s = '+' + s;
  else if (s.startsWith('0')) s = '+44' + s.slice(1);
  else if (/^7\d{9}$/.test(s)) s = '+44' + s;
  else if (!s.startsWith('+')) return null;

  if (s.startsWith('+44')) {
    return /^\+447[1-9]\d{8}$/.test(s) ? s : null; // UK mobiles only (07xxx), excluding 070 personal numbers
  }
  return /^\+[1-9]\d{7,14}$/.test(s) ? s : null;
}

export function formatPhone(e164) {
  if (typeof e164 === 'string' && /^\+447\d{9}$/.test(e164)) {
    const n = '0' + e164.slice(3);
    return `${n.slice(0, 5)} ${n.slice(5)}`;
  }
  return e164;
}

/** Validate submitted answers against a job's field list. Unknown keys are ignored. */
export function validateAnswers(job, input) {
  const values = {};
  const errors = {};
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};

  for (const f of job.fields) {
    const raw = src[f.id];
    const missing = raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '') || (Array.isArray(raw) && raw.length === 0);
    if (missing) {
      errors[f.id] = 'Please answer this question.';
      continue;
    }

    if (f.type === 'phone') {
      const p = normalisePhone(raw);
      if (!p) errors[f.id] = 'Please enter a valid mobile number, for example 07123 456789.';
      else values[f.id] = p;
    } else if (f.type === 'text') {
      if (typeof raw !== 'string') {
        errors[f.id] = 'Please enter text.';
        continue;
      }
      const v = clean(raw);
      const max = f.maxLength || 100;
      if (v.length < 2) errors[f.id] = 'That looks too short.';
      else if (v.length > max) errors[f.id] = `Please keep this under ${max} characters.`;
      else if (f.id === 'full_name' && (!NAME_RE.test(v) || !/\s/.test(v))) {
        errors[f.id] = 'Please enter your first name and surname.';
      } else if (f.id === 'area' && !AREA_RE.test(v)) {
        errors[f.id] = 'Please enter a town or area, such as Bath or Bristol.';
      } else values[f.id] = v;
    } else if (f.type === 'choice') {
      const ok = typeof raw === 'string' && f.options.some((o) => o.value === raw);
      if (!ok) errors[f.id] = 'Please choose one of the options.';
      else values[f.id] = raw;
    } else if (f.type === 'multi') {
      const arr = Array.isArray(raw) ? raw : [];
      const set = [...new Set(arr)];
      const ok = set.length > 0 && set.every((v) => typeof v === 'string' && f.options.some((o) => o.value === v));
      if (!ok) errors[f.id] = 'Please choose at least one option.';
      else values[f.id] = f.options.map((o) => o.value).filter((v) => set.includes(v));
    }
  }
  return { values, errors, ok: Object.keys(errors).length === 0 };
}

// Human-readable answers for the dashboard and CSV.
export function describeAnswers(job, answers) {
  if (!job) return [];
  const out = [];
  for (const f of job.fields) {
    if (['full_name', 'phone', 'area'].includes(f.id)) continue;
    const v = answers[f.id];
    if (v === undefined) continue;
    out.push({ id: f.id, label: f.summaryLabel || f.label, value: displayValue(f, v) });
  }
  return out;
}

export function displayValue(f, v) {
  if (f.type === 'multi') {
    const arr = Array.isArray(v) ? v : [];
    if (f.options.length > 1 && f.options.every((o) => arr.includes(o.value))) return f.allOption?.label || arr.map((x) => labelFor(f, x)).join(', ');
    return arr.map((x) => labelFor(f, x)).join(', ');
  }
  if (f.type === 'choice') return labelFor(f, v);
  return String(v);
}
function labelFor(f, v) {
  return f.options?.find((o) => o.value === v)?.label ?? String(v);
}
