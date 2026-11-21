import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

export function record(state, id, kind, owner) {
  const item = state.records[id];
  requireValue(
    Object.hasOwn(state.records, id) && item?.kind === kind,
    'Missing ' + kind + ' record'
  );
  if (owner !== undefined)
    requireValue(item.owner === owner, 'Cross-owner reference');
  return item;
}

const relations = {
  owner: {},
  business: {},
  persona: { business: 'business' },
  agent: { business: 'business' },
  channel: { business: 'business', persona: 'persona' },
  opportunity: { channel: 'channel' },
  experiment: { opportunity: 'opportunity' },
  run: { experiment: 'experiment' },
  task: { run: 'run' },
  attempt: { task: 'task', node: 'node' },
  node: {},
  account: { business: 'business', recoveryOwner: 'owner' },
  action: { actor: 'agent', account: 'account' },
  artifact: { attempt: 'attempt' }
};

export function insert(state, kind, owner, data, now) {
  requireValue(Object.hasOwn(relations, kind), 'Unknown record kind');
  const id = randomUUID();
  if (kind === 'owner') owner = id;
  else record(state, owner, 'owner');
  for (const [key, type] of Object.entries(relations[kind]))
    record(state, data[key], type, owner);
  const item = { ...data, kind, id, owner, createdAt: now, version: 1 };
  state.records[id] = item;
  return item;
}

// One transactional document keeps this single-machine fixture portable. SQLite
// serializes writers across processes; no service process owns the only copy.
export class Store {
  constructor(filename, clock = Date.now) {
    this.clock = clock;
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
    try {
      const version = this.db.prepare('PRAGMA user_version').get().user_version;
      requireValue(version <= 2, 'Newer database schema');
      if (version === 0) {
        this.db.exec(
          'CREATE TABLE workspace(id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL)'
        );
        this.db
          .prepare('INSERT INTO workspace VALUES(1, ?)')
          .run(JSON.stringify({ records: {}, events: [] }));
      }
      if (version < 2) {
        const state = this.read();
        Object.assign(state, {
          grants: [],
          approvals: [],
          pauses: [],
          ownerTasks: []
        });
        this.save(state);
        this.db.exec('PRAGMA user_version=2');
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      this.db.close();
      throw error;
    }
  }

  read() {
    return JSON.parse(
      this.db.prepare('SELECT data FROM workspace WHERE id=1').get().data
    );
  }
  save(state) {
    this.db
      .prepare('UPDATE workspace SET data=? WHERE id=1')
      .run(JSON.stringify(state));
  }

  change(operation) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const state = this.read();
      const result = operation(state, this.clock());
      this.save(state);
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  create(kind, owner, data = {}) {
    const allowed = [
      'owner',
      'business',
      'persona',
      'agent',
      'channel',
      'opportunity',
      'experiment',
      'run'
    ];
    requireValue(
      allowed.includes(kind),
      'Use the component-specific registration operation'
    );
    if (kind === 'opportunity') {
      const f = data.forecast;
      requireValue(
        f &&
          Array.isArray(f.evidence) &&
          f.evidence.length &&
          Number.isSafeInteger(f.lowMinor) &&
          Number.isSafeInteger(f.highMinor) &&
          f.highMinor >= f.lowMinor &&
          /^[A-Z]{3}$/.test(f.currency) &&
          Number.isFinite(Date.parse(f.horizon)) &&
          Number.isFinite(Date.parse(f.reviewDate)),
        'Invalid opportunity forecast'
      );
    }
    return this.change((state, now) => insert(state, kind, owner, data, now));
  }

  close() {
    this.db.close();
  }
}
