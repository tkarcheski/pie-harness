import { requireValue as check } from '../local/store.mjs';
export { check };
export function label(value, name, max = 600) {
  check(
    typeof value === 'string' &&
      !!value.trim() &&
      value.length <= max &&
      !/[\u0000-\u001f]/u.test(value),
    'Invalid ' + name
  );
  return value.trim();
}
export function integer(value, name, min = 0, max = 1000000000) {
  check(
    Number.isSafeInteger(value) && value >= min && value <= max,
    'Invalid ' + name
  );
  return value;
}
export function key(value, name = 'record ID') {
  check(
    typeof value === 'string' &&
      /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(value) &&
      !Object.hasOwn(Object.prototype, value) &&
      value !== 'prototype',
    'Invalid ' + name
  );
  return value;
}
export function get(collection, id, name) {
  key(id);
  check(Object.hasOwn(collection, id), 'Unknown ' + name);
  return collection[id];
}
export function fresh(collection, id, name) {
  key(id);
  check(!Object.hasOwn(collection, id), 'Duplicate ' + name);
  return id;
}
export function time(value, name) {
  let ms = value;
  if (typeof ms === 'string') {
    check(
      /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d\d:\d\d)$/.test(ms),
      'Use an ISO timestamp with time zone for ' + name
    );
    ms = Date.parse(ms);
  }
  return integer(ms, name, 0, 8640000000000000);
}
export function evidence(src, now) {
  check(src && typeof src === 'object', 'Supply dated evidence');
  const ref = label(src.ref, 'evidence reference', 400);
  const observedAt = time(src.observedAt, 'evidence time');
  check(observedAt <= now, 'Evidence is future-dated');
  if (ref.startsWith('https://')) {
    const u = new URL(ref);
    check(!u.username && !u.password, 'Credentials in source URL');
  } else
    check(
      /^(evidence|studio|document):[A-Za-z0-9._/-]+$/.test(ref),
      'Use an HTTPS source or local evidence reference'
    );
  return { ref, observedAt, note: label(src.note, 'evidence note') };
}
