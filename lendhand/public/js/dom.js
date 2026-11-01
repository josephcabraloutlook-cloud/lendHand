// Tiny DOM helpers. Text is always inserted as text nodes, never as HTML, so user data cannot inject markup.
const PROPS = new Set(['checked', 'value', 'disabled', 'hidden', 'selected', 'open']);

export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (PROPS.has(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, kids);
  return el;
}

function append(el, kids) {
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function svgCheck(size = 36) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', 'M5 12.5l4.5 4.5L19 7.5');
  p.setAttribute('fill', 'none');
  p.setAttribute('stroke', '#13231B');
  p.setAttribute('stroke-width', '3');
  p.setAttribute('stroke-linecap', 'round');
  p.setAttribute('stroke-linejoin', 'round');
  svg.append(p);
  return svg;
}

export async function api(path, { method = 'GET', body, csrf } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (csrf && method !== 'GET') headers['X-CSRF-Token'] = csrf;
  let res;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
  } catch {
    const e = new Error('We could not reach the server. Please check your connection and try again.');
    e.network = true;
    throw e;
  }
  let data = null;
  if ((res.headers.get('content-type') || '').includes('application/json')) data = await res.json().catch(() => null);
  if (!res.ok) {
    const e = new Error((data && data.error) || 'Something went wrong. Please try again.');
    e.status = res.status;
    e.data = data;
    throw e;
  }
  return data;
}
