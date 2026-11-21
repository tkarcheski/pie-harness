import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, requireValue } from '../../packages/local/store.mjs';
import { Execution } from '../../packages/local/execution.mjs';

const schema = JSON.parse(
  readFileSync(new URL('./startup.schema.json', import.meta.url))
);
export function validateConfig(config) {
  requireValue(
    config && typeof config === 'object' && !Array.isArray(config),
    'Expected configuration object'
  );
  for (const key of Object.keys(config))
    requireValue(
      Object.hasOwn(schema.properties, key),
      'Unknown configuration key: ' + key
    );
  for (const key of schema.required) {
    const rule = schema.properties[key],
      value = config[key];
    let valid;
    if ('const' in rule) valid = value === rule.const;
    else if (rule.type === 'integer')
      valid =
        Number.isSafeInteger(value) &&
        value >= rule.minimum &&
        value <= rule.maximum;
    else
      valid =
        typeof value === 'string' && value.trim().length >= rule.minLength;
    requireValue(valid, 'Invalid configuration field: ' + key);
  }
  return config;
}

export function sampleDomain(store) {
  const owner = store.create('owner', null, { name: 'Example owner' }).id;
  const business = store.create('business', owner, {
    name: 'Example business'
  }).id;
  const persona = store.create('persona', owner, { business }).id;
  const actor = store.create('agent', owner, { business }).id;
  const channel = store.create('channel', owner, { business, persona }).id;
  const opportunity = store.create('opportunity', owner, {
    channel,
    forecast: {
      currency: 'USD',
      lowMinor: 0,
      highMinor: 100,
      evidence: ['synthetic-observation'],
      horizon: '2030-02-01',
      reviewDate: '2030-01-15'
    }
  }).id;
  const experiment = store.create('experiment', owner, { opportunity }).id;
  const run = store.create('run', owner, { experiment }).id;
  return { owner, business, actor, experiment, run };
}

export function start(config, filename = ':memory:') {
  validateConfig(config);
  const store = new Store(filename);
  try {
    const scope = sampleDomain(store);
    const queue = new Execution(store, config);
    const worker = queue.enroll(scope.owner);
    queue.heartbeat(worker, true);
    queue.probe(scope.owner, worker.node, {
      name: 'fixture',
      version: '1',
      state: 'supported',
      evidence: 'local-fixture-probe'
    });
    const task = queue.enqueue(scope.owner, {
      ...scope,
      capability: 'fixture',
      budgetRef: 'simulation-only'
    });
    const claim = queue.claim(worker);
    requireValue(claim?.task === task.id, 'Fixture dispatch failed');
    const session = { ...worker, fence: claim.fence };
    queue.checkpoint(task.id, session, 'synthetic-result');
    queue.complete(task.id, session);
    return {
      mode: config.mode,
      nodeAlias: config.node,
      ...queue.inspect(scope.owner)
    };
  } finally {
    store.close();
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const source =
      process.argv[2] ||
      process.env.PIE_CONFIG ||
      new URL('./fixture.config.json', import.meta.url);
    const config = JSON.parse(readFileSync(source, 'utf8'));
    console.log(
      JSON.stringify(
        start(config, process.env.PIE_STATE_DB || ':memory:'),
        null,
        2
      )
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
