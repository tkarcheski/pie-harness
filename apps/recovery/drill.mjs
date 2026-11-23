import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, fork } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Studio } from '../studio/channel.mjs';
import { health, maintain } from '../studio/maintenance.mjs';
import { Execution } from '../../packages/local/execution.mjs';
import { Store, requireValue } from '../../packages/local/store.mjs';
import { payloadDigest } from '../../packages/local/authority.mjs';

const entry = fileURLToPath(import.meta.url);
const timing = { heartbeatMs: 3000, leaseMs: 1200 };
const capability = 'recovery-sample';
const output = 'fixture:verified-checkpoint';
const watchdogMs = 15000;

function protectDirectory(directory) {
  if (process.platform !== 'win32') {
    fs.chmodSync(directory, 0o700);
    return;
  }
  const options = { encoding: 'utf8', windowsHide: true, timeout: 5000 };
  const identity = execFileSync(
    'whoami.exe',
    ['/user', '/fo', 'csv', '/nh'],
    options
  );
  const sid = identity.match(/"(S-[0-9-]+)"\s*$/i)?.[1];
  requireValue(sid, 'Cannot identify the backup owner');
  execFileSync(
    'icacls.exe',
    [directory, '/inheritance:r', '/grant:r', '*' + sid + ':(OI)(CI)F'],
    options
  );
}

function copyPrivate(from, to) {
  fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
  if (process.platform !== 'win32') fs.chmodSync(to, 0o600);
}

function verifyPair(directory, sqlite = 'studio.sqlite') {
  const file = path.join(directory, sqlite);
  const token = fs.readFileSync(path.join(directory, 'worker.key'), 'utf8');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    requireValue(
      db.prepare('PRAGMA integrity_check').get().integrity_check === 'ok',
      'Recovery database integrity check failed'
    );
    const state = JSON.parse(
      db.prepare('SELECT data FROM workspace WHERE id=1').get().data
    );
    const node = state.records[state.studio.node];
    requireValue(
      /^[0-9a-f]{64}$/.test(token) &&
        node?.kind === 'node' &&
        !node.revoked &&
        node.keyHash === payloadDigest(token),
      'Recovery enrollment does not match snapshot'
    );
  } finally {
    db.close();
  }
}

// Both paths are exclusive new directories. Publishing the manifest last
// keeps an interrupted copy from becoming a usable backup.
export function createRecoveryBundle(studio, directory) {
  const snapshot = maintain(studio);
  fs.mkdirSync(directory, { mode: 0o700 });
  protectDirectory(directory);
  const database = path.join(directory, 'studio.sqlite');
  copyPrivate(path.join(studio.dir, snapshot.file), database);
  copyPrivate(
    path.join(studio.dir, 'worker.key'),
    path.join(directory, 'worker.key')
  );
  verifyPair(directory);
  fs.writeFileSync(
    path.join(directory, 'manifest.json'),
    JSON.stringify({
      version: 1,
      databaseSha256: payloadDigest(fs.readFileSync(database))
    }),
    { flag: 'wx', mode: 0o600, flush: true }
  );
}

export function restoreRecoveryBundle(directory, destination) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8')
  );
  const database = path.join(directory, 'studio.sqlite');
  requireValue(
    manifest?.version === 1 &&
      manifest.databaseSha256 === payloadDigest(fs.readFileSync(database)),
    'Recovery snapshot digest mismatch'
  );
  verifyPair(directory);
  fs.mkdirSync(destination, { mode: 0o700 });
  protectDirectory(destination);
  // Studio only recognizes the final filename. A partial restore is never runnable.
  copyPrivate(
    path.join(directory, 'worker.key'),
    path.join(destination, 'worker.key')
  );
  const restored = path.join(destination, 'snapshot.pending');
  copyPrivate(database, restored);
  requireValue(
    manifest.databaseSha256 === payloadDigest(fs.readFileSync(restored)),
    'Restored snapshot digest mismatch'
  );
  verifyPair(destination, 'snapshot.pending');
  fs.renameSync(restored, path.join(destination, 'studio.sqlite'));
  return new Studio(destination);
}

function enroll(engine, owner) {
  const worker = engine.enroll(owner);
  engine.probe(owner, worker.node, {
    name: capability,
    version: '1',
    state: 'supported',
    evidence: 'local drill'
  });
  engine.heartbeat(worker, true);
  return worker;
}
async function interrupt(filename, worker, task) {
  const child = fork(entry, ['--child'], {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    execArgv: [],
    windowsHide: true
  });
  const exit = once(child, 'exit', {
    signal: AbortSignal.timeout(watchdogMs + 5000)
  });
  const ack = once(child, 'message', { signal: AbortSignal.timeout(10000) });
  try {
    child.send({ filename, worker, task });
    const first = await Promise.race([
      ack,
      exit.then(() => {
        throw Error('Worker stopped before checkpoint');
      })
    ]);
    requireValue(
      first[0]?.task === task && first[0].fence,
      'Missing durable checkpoint acknowledgment'
    );
    return first[0];
  } finally {
    child.kill('SIGKILL');
    try {
      await exit;
    } finally {
      if (child.connected) child.disconnect();
      child.unref();
    }
  }
}
export async function runDrill({ minutes = 5, intervalMs = 2500 } = {}) {
  requireValue(
    Number.isFinite(minutes) && minutes > 0 && minutes <= 60,
    'Use up to 60 minutes'
  );
  requireValue(
    Number.isInteger(intervalMs) && intervalMs >= 100 && intervalMs <= 10000,
    'Invalid sampling interval'
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-recovery-'));
  protectDirectory(dir);
  const started = Date.now(),
    journal = path.join(dir, 'recovery.jsonl');
  function log(type, fields = {}) {
    fs.appendFileSync(
      journal,
      JSON.stringify({ at: new Date().toISOString(), type, ...fields }) + '\n',
      { mode: 0o600 }
    );
  }
  let studio = new Studio(path.join(dir, 'source'), { initialize: true });
  try {
    studio.init({
      topic: 'Recovery drill',
      audience: 'test operator',
      model: 'fixture'
    });
    requireValue(
      (await studio.work()).status === 'done',
      'Studio warmup failed'
    );
    const { owner, actor, run } = studio.store.read().studio;
    let engine = new Execution(studio.store, timing);
    const first = enroll(engine, owner),
      replacement = enroll(engine, owner);
    const submit = () =>
      engine.enqueue(owner, {
        actor,
        run,
        capability,
        budgetRef: 'synthetic',
        retryLimit: 1,
        deadline: Date.now() + 60000
      }).id;
    const task = submit();
    log('run-start', { minutes });
    const old = await interrupt(studio.file, first, task);
    const loss = Date.now();
    log('terminated-worker-after-checkpoint');
    let claim;
    do {
      engine.heartbeat(replacement, true);
      claim = engine.claim(replacement, run);
      if (!claim) await wait(100);
    } while (!claim && Date.now() - loss < 15000);
    requireValue(
      claim?.task === task &&
        studio.store.read().records[claim.checkpoint]?.outputRef === output,
      'Replacement did not resume the saved checkpoint'
    );
    let fenced = false;
    try {
      engine.complete(task, { ...first, fence: old.fence });
    } catch {
      fenced = true;
    }
    requireValue(fenced, 'Stale worker could commit');
    engine.complete(task, { ...replacement, fence: claim.fence });
    engine.revoke(owner, first.node);
    const failoverMs = Date.now() - loss;
    log('replacement-completed', { failoverMs, staleWorkerRejected: fenced });
    const pending = studio.product({
      title: 'Recovery verification',
      source: 'Recover this queued work and send the draft to local review.',
      rightsConfirmed: true,
      priceMinor: 0
    });
    const before = Date.now();
    const bundle = path.join(dir, 'backup-bundle');
    createRecoveryBundle(studio, bundle);
    studio.close();
    studio = null;
    // This is the disposable source created only for this drill.
    const source = path.join(dir, 'source');
    requireValue(
      fs.realpathSync(source) === path.join(fs.realpathSync(dir), 'source'),
      'Unexpected drill source'
    );
    fs.rmSync(source, { recursive: true });
    log('source-removed-after-backup');
    studio = restoreRecoveryBundle(bundle, path.join(dir, 'restored'));
    requireValue(
      health(studio).integrity === 'ok' &&
        studio.store.read().records[task]?.status === 'done',
      'Restore lost committed work'
    );
    const result = await studio.work();
    const product = studio.store.read().studio.products[pending.product];
    requireValue(
      result.task === pending.task &&
        result.kind === 'product' &&
        result.status === 'done' &&
        product.status === 'review' &&
        product.draft?.content?.includes('Recover this queued work'),
      'Restored worker did not produce the queued Studio draft'
    );
    engine = new Execution(studio.store, timing);
    const recoveredWorker = enroll(engine, studio.store.read().studio.owner);
    const restoreMs = Date.now() - before;
    log('restored-on-fresh-directory', {
      restoreMs,
      studioTask: result.task,
      draftDigest: payloadDigest(product.draft.content)
    });
    let cycles = 0;
    do {
      const id = submit();
      engine.heartbeat(recoveredWorker, true);
      const next = engine.claim(recoveredWorker, run);
      requireValue(next?.task === id, 'Lost scheduled work after restore');
      engine.complete(id, { ...recoveredWorker, fence: next.fence });
      cycles++;
      if (cycles === 1 || cycles % 12 === 0) log('sample', { cycles });
      const left = started + minutes * 60000 - Date.now();
      if (left > 0) await wait(Math.min(left, intervalMs));
    } while (Date.now() < started + minutes * 60000);
    const tasks = engine.inspect(owner).tasks;
    requireValue(
      tasks.length === cycles + 3 && tasks.every((t) => t.status === 'done'),
      'Unexpected task count or terminal state'
    );
    const report = {
      mode: 'synthetic operated recovery',
      startedAt: new Date(started).toISOString(),
      elapsedMs: Date.now() - started,
      failoverMs,
      restoreMs,
      cycles,
      completedTasks: tasks.length,
      checkpointPreserved: true,
      staleWorkerRejected: fenced,
      bundle,
      sourceRemoved: !fs.existsSync(source),
      restoredStudioTask: result.task,
      draftDigest: payloadDigest(product.draft.content),
      restoredIntegrity: health(studio).integrity,
      journal
    };
    requireValue(
      failoverMs < 15000 && restoreMs < 15000,
      'Recovery target exceeded'
    );
    log('passed', report);
    return report;
  } catch (e) {
    log('failed', { reason: e.message });
    throw e;
  } finally {
    studio?.close();
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === entry) {
  if (process.argv[2] === '--child' && process.send) {
    const timeout = Number(process.argv[3] ?? watchdogMs);
    requireValue(
      Number.isSafeInteger(timeout) && timeout > 0 && timeout <= watchdogMs,
      'Invalid child watchdog'
    );
    process.once('disconnect', () => process.exit(0));
    setTimeout(() => process.exit(1), timeout);
    process.once('message', ({ filename, worker, task }) => {
      const store = new Store(filename);
      const engine = new Execution(store, timing);
      engine.heartbeat(worker, true);
      const claim = engine.claim(worker);
      requireValue(claim?.task === task, 'Child acquired wrong job');
      engine.checkpoint(task, { ...worker, fence: claim.fence }, output);
      process.send({ task, fence: claim.fence });
    });
  } else {
    runDrill({ minutes: Number(process.argv[2] ?? 5) })
      .then((v) => console.log(JSON.stringify(v)))
      .catch((e) => {
        console.error(e.message);
        process.exitCode = 1;
      });
  }
}
