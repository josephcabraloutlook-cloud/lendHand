import { JOBS, STATUS_VALUES, STATUSES, getJobAny, describeAnswers, formatPhone, displayValue } from './jobs.js';
import { audit } from './db.js';

const escLike = (s) => String(s).replace(/[\\%_]/g, (c) => '\\' + c);

export function buildFilter(q) {
  const where = [];
  const args = [];
  const one = (k) => (typeof q[k] === 'string' ? q[k].trim() : '');

  if (STATUS_VALUES.includes(one('status'))) {
    where.push('status = ?');
    args.push(one('status'));
  }
  if (JOBS.some((j) => j.slug === one('job'))) {
    where.push('job_slug = ?');
    args.push(one('job'));
  }
  if (one('location')) {
    where.push("area LIKE ? ESCAPE '\\'");
    args.push(`%${escLike(one('location').slice(0, 80))}%`);
  }
  if (['own_car', 'company_van', 'both'].includes(one('vehicle'))) {
    where.push("json_extract(answers, '$.vehicle') = ?");
    args.push(one('vehicle'));
  }
  if (['immediately', '1_week', '2_weeks', 'later'].includes(one('start'))) {
    where.push("json_extract(answers, '$.start') = ?");
    args.push(one('start'));
  }
  if (one('days') === 'both') {
    where.push("EXISTS (SELECT 1 FROM json_each(answers, '$.days') WHERE value = 'weekdays')");
    where.push("EXISTS (SELECT 1 FROM json_each(answers, '$.days') WHERE value = 'weekends')");
  } else if (['weekdays', 'weekends'].includes(one('days'))) {
    where.push("EXISTS (SELECT 1 FROM json_each(answers, '$.days') WHERE value = ?)");
    args.push(one('days'));
  }
  if (['yes', 'no', 'unsure'].includes(one('rtw'))) {
    where.push('right_to_work = ?');
    args.push(one('rtw'));
  }
  if (one('flag') === 'clarify') where.push('clarification_requested_at IS NOT NULL');
  if (one('q')) {
    const like = `%${escLike(one('q').slice(0, 80))}%`;
    where.push("(full_name LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\' OR ref LIKE ? ESCAPE '\\')");
    args.push(like, like, like);
  }
  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', args };
}

export function toView(row) {
  const job = getJobAny(row.job_slug);
  let answers = {};
  try {
    answers = JSON.parse(row.answers);
  } catch {
    /* corrupted row: show nothing rather than crash */
  }
  return {
    id: row.id,
    ref: row.ref,
    jobSlug: row.job_slug,
    jobTitle: job ? job.title : row.job_slug,
    name: row.full_name,
    phone: row.phone,
    phoneDisplay: formatPhone(row.phone),
    area: row.area,
    rightToWork: row.right_to_work,
    answers: describeAnswers(job, { ...answers, right_to_work: row.right_to_work }),
    raw: answers,
    status: row.status,
    notes: row.notes,
    consents: {
      noticeVersion: row.notice_version,
      privacyAckAt: row.privacy_ack_at,
      updates: !!row.updates_opt_in,
      whatsapp: !!row.whatsapp_opt_in,
    },
    clarificationRequestedAt: row.clarification_requested_at,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listCandidates(db, query) {
  const { sql, args } = buildFilter(query);
  const pageSize = Math.min(100, Math.max(1, parseInt(query.pageSize, 10) || 25));
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const order = query.sort === 'oldest' ? 'ASC' : 'DESC';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM candidates ${sql}`).get(...args).n;
  const rows = db
    .prepare(`SELECT * FROM candidates ${sql} ORDER BY created_at ${order}, id ${order} LIMIT ? OFFSET ?`)
    .all(...args, pageSize, (page - 1) * pageSize);
  const counts = Object.fromEntries(STATUS_VALUES.map((s) => [s, 0]));
  for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM candidates GROUP BY status').all()) counts[r.status] = r.n;
  return { items: rows.map(toView), total, page, pageSize, counts };
}

export function getCandidate(db, id) {
  const row = db.prepare('SELECT * FROM candidates WHERE id = ?').get(id);
  return row ? toView(row) : null;
}

export function updateCandidate(db, id, patch, actor) {
  const row = db.prepare('SELECT * FROM candidates WHERE id = ?').get(id);
  if (!row) return null;
  const sets = [];
  const args = [];
  if (patch.status !== undefined) {
    if (!STATUS_VALUES.includes(patch.status)) throw Object.assign(new Error('Unknown status.'), { status: 400 });
    sets.push('status = ?');
    args.push(patch.status);
  }
  if (patch.notes !== undefined) {
    if (typeof patch.notes !== 'string' || patch.notes.length > 2000) throw Object.assign(new Error('Notes must be text under 2,000 characters.'), { status: 400 });
    sets.push('notes = ?');
    args.push(patch.notes.replace(/\u0000/g, ''));
  }
  if (!sets.length) return toView(row);
  sets.push('updated_at = ?');
  args.push(new Date().toISOString());
  db.prepare(`UPDATE candidates SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
  if (patch.status !== undefined && patch.status !== row.status) audit(db, actor, 'status_change', row.ref, `${row.status} -> ${patch.status}`);
  if (patch.notes !== undefined && patch.notes !== row.notes) audit(db, actor, 'notes_edit', row.ref);
  return getCandidate(db, id);
}

export function deleteCandidate(db, id, actor) {
  const row = db.prepare('SELECT ref FROM candidates WHERE id = ?').get(id);
  if (!row) return false;
  db.prepare('DELETE FROM candidates WHERE id = ?').run(id);
  audit(db, actor, 'candidate_delete', row.ref);
  return true;
}

/** Automatic retention: removes records that were never progressed to "Onboarded". */
export function purgeExpired(db, retentionDays) {
  const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();
  const r = db.prepare("DELETE FROM candidates WHERE status != 'onboarded' AND updated_at < ?").run(cutoff);
  const n = Number(r.changes);
  if (n > 0) audit(db, 'system', 'retention_purge', null, `${n} record(s) older than ${retentionDays} days`);
  db.prepare('DELETE FROM audit_log WHERE at < ?').run(new Date(Date.now() - 730 * 86400000).toISOString());
  return n;
}

// ---------- CSV ----------
const ukDate = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', dateStyle: 'short', timeStyle: 'short' });

function csvCell(v) {
  let s = v === null || v === undefined ? '' : String(v);
  // Neutralise spreadsheet formula injection (leave plain phone numbers like +447... alone).
  if (/^[=+\-@\t\r]/.test(s) && !/^\+\d[\d ]*$/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function exportCsv(db, query) {
  const { sql, args } = buildFilter(query);
  const rows = db.prepare(`SELECT * FROM candidates ${sql} ORDER BY created_at DESC, id DESC`).all(...args);

  const extra = [];
  for (const j of JOBS)
    for (const f of j.fields) if (!['full_name', 'phone', 'area'].includes(f.id) && !extra.some((e) => e.id === f.id)) extra.push(f);

  const header = [
    'Reference', 'Submitted (UK time)', 'Job', 'Name', 'Mobile', 'Area',
    ...extra.map((f) => f.summaryLabel || f.label),
    'Status', 'Updates opt-in', 'WhatsApp opt-in', 'Clarification requested', 'Privacy notice version', 'Source', 'Notes',
  ];
  const lines = [header.map(csvCell).join(',')];
  for (const r of rows) {
    const v = toView(r);
    const a = { ...v.raw, right_to_work: r.right_to_work };
    lines.push(
      [
        v.ref,
        ukDate.format(new Date(v.createdAt)),
        v.jobTitle,
        v.name,
        v.phoneDisplay,
        v.area,
        ...extra.map((f) => (a[f.id] === undefined ? '' : displayValue(f, a[f.id]))),
        STATUSES.find((s) => s.value === v.status)?.label || v.status,
        v.consents.updates ? 'Yes' : 'No',
        v.consents.whatsapp ? 'Yes' : 'No',
        v.clarificationRequestedAt ? 'Yes' : 'No',
        v.consents.noticeVersion,
        v.source || '',
        v.notes,
      ]
        .map(csvCell)
        .join(',')
    );
  }
  return { csv: '﻿' + lines.join('\r\n') + '\r\n', count: rows.length };
}
