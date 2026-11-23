import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { insert, record, requireValue as check } from '../local/store.mjs';

export { check };
export function id(value, name = 'ID') {
  check(
    typeof value === 'string' &&
      /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(value),
    'Supply an opaque ' + name
  );
  return value;
}
export function ref(value) {
  check(
    typeof value === 'string' &&
      /^vault:[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(value),
    'Supply an opaque vault evidence reference'
  );
  return value;
}
export function word(value, name, max = 180) {
  check(
    typeof value === 'string' &&
      value.trim() &&
      value.trim().length <= max &&
      !/[\u0000-\u001f]/u.test(value),
    'Invalid ' + name
  );
  return value.trim();
}
export function choice(value, options, label) {
  check(options.includes(value), 'Invalid ' + label);
  return value;
}
export function number(value, name, min = 0, max = 1000000000000) {
  check(
    Number.isSafeInteger(value) && value >= min && value <= max,
    'Invalid ' + name
  );
  return value;
}
export function date(value, latest = Infinity) {
  check(
    typeof value === 'string' &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value),
    'Use a UTC timestamp'
  );
  const ms = Date.parse(value);
  check(
    Number.isFinite(ms) &&
      ms <= latest &&
      new Date(ms).toISOString().replace('.000Z', 'Z') ===
        value.replace('.000Z', 'Z'),
    'Invalid evidence date'
  );
  return ms;
}
export function moneyCode(value) {
  check(
    typeof value === 'string' && /^[A-Z]{3}$/.test(value),
    'Use a three-letter currency'
  );
  return value;
}
export function get(rows, key, label) {
  id(key, label + ' ID');
  const row = rows.find((r) => r.id === key);
  check(row, 'Unknown ' + label);
  return row;
}
export function unique(rows, row) {
  const prior = rows.find((r) => r.id === row.id);
  if (prior) {
    check(isDeepStrictEqual(row, prior), 'Conflicting source record ID');
    return prior;
  }
  rows.push(row);
  return row;
}
export function digest(parts) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}
export function fields(input, allowed) {
  check(
    input &&
      typeof input === 'object' &&
      !Array.isArray(input) &&
      Object.keys(input).every((k) => allowed.includes(k)),
    'Unexpected input fields; use opaque references for private evidence'
  );
}
export function deskOf(s, owner) {
  record(s, owner, 'owner');
  const d = s.resaleDesks?.find((d) => d.owner === owner);
  check(d, 'Resale desk has not been initialized for this owner');
  return d;
}
function addDesk(s, { owner, business, actor, account }) {
  record(s, business, 'business', owner);
  check(
    record(s, actor, 'agent', owner).business === business,
    'Actor belongs to a different business'
  );
  const binding = record(s, account, 'account', owner);
  check(
    binding.business === business &&
      ['ebay-simulation', 'ebay-sandbox'].includes(binding.platform),
    'Choose an eBay rehearsal or sandbox account in the same business'
  );
  const prior = s.resaleDesks?.find((d) => d.owner === owner);
  if (prior) {
    check(
      prior.business === business &&
        prior.actor === actor &&
        prior.account === account,
      'Existing desk has a different account or actor'
    );
    return owner;
  }
  (s.resaleDesks ??= []).push({
    owner,
    business,
    actor,
    account,
    items: [],
    listings: [],
    operations: [],
    orders: [],
    payouts: [],
    lines: [],
    bank: [],
    events: []
  });
  return owner;
}
export function bindResaleDesk(store, scope) {
  return store.change((s) => addDesk(s, scope));
}
export function initialize(store) {
  return store.change((s, now) => {
    if (s.resaleLocalOwner) return deskOf(s, s.resaleLocalOwner).owner;
    const owner = insert(s, 'owner', null, { name: 'Resale operator' }, now).id;
    const business = insert(
      s,
      'business',
      owner,
      { name: 'Owned-item resale' },
      now
    ).id;
    const actor = insert(s, 'agent', owner, { business }, now).id;
    const account = insert(
      s,
      'account',
      owner,
      {
        business,
        recoveryOwner: owner,
        platform: 'ebay-simulation',
        scopes: ['ebay.publish', 'ebay.end'],
        expiresAt: Number.MAX_SAFE_INTEGER,
        secretRef: 'secret-ref:simulation/resale',
        revoked: false
      },
      now
    ).id;
    addDesk(s, { owner, business, actor, account });
    s.resaleLocalOwner = owner;
    return owner;
  });
}
export function queue(s, owner, subject, code, dueAt, now) {
  const existing = s.ownerTasks.find(
    (t) =>
      t.owner === owner &&
      t.source === 'resale' &&
      t.subject === subject &&
      t.code === code &&
      !t.closedAt
  );
  if (existing) return existing;
  const task = { owner, source: 'resale', subject, code, dueAt, time: now };
  s.ownerTasks.push(task);
  return task;
}
export function resolve(s, owner, subject, code, now) {
  for (const t of s.ownerTasks)
    if (
      t.owner === owner &&
      t.source === 'resale' &&
      t.subject === subject &&
      t.code === code &&
      !t.closedAt
    )
      t.closedAt = now;
}
export function ownerQueue(s, owner, now) {
  return s.ownerTasks
    .filter((t) => t.owner === owner && t.source === 'resale' && !t.closedAt)
    .sort((a, b) => a.dueAt - b.dueAt)
    .map(({ subject, code, dueAt }) => ({
      subject,
      code,
      dueAt,
      overdue: dueAt < now
    }));
}
