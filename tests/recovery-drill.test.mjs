import assert from 'node:assert/strict';
import { execFileSync, fork } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  createRecoveryBundle,
  restoreRecoveryBundle,
  runDrill
} from '../apps/recovery/drill.mjs';
import { Studio } from '../apps/studio/channel.mjs';
import { payloadDigest } from '../packages/local/authority.mjs';

const entry = fileURLToPath(
  new URL('../apps/recovery/drill.mjs', import.meta.url)
);

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-drill-test-'));
  const studio = new Studio(path.join(dir, 'source'), { initialize: true });
  studio.init({ topic: 'Recovery smoke', audience: 'test operator' });
  t.after(() => {
    studio.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { studio, dir };
}

function childWorker(t, args = []) {
  const child = fork(entry, ['--child', ...args], {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    execArgv: [],
    windowsHide: true
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  });
  return child;
}

test(
  'short drill resumes queued Studio work from the bundle after losing the worker and source',
  { timeout: 30000 },
  async (t) => {
    const result = await runDrill({ minutes: 0.035, intervalMs: 100 });
    const root = path.dirname(result.journal);
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    assert.ok(result.elapsedMs >= 2100);
    assert.equal(result.staleWorkerRejected, true);
    assert.equal(result.checkpointPreserved, true);
    assert.equal(result.completedTasks, result.cycles + 3);
    assert.equal(result.restoredIntegrity, 'ok');
    assert.equal(fs.existsSync(path.join(root, 'source')), false);
    const recovered = new Studio(path.join(root, 'restored'));
    try {
      const state = recovered.store.read();
      const product = Object.values(state.studio.products)[0];
      assert.equal(product.task, result.restoredStudioTask);
      assert.equal(state.records[product.task].status, 'done');
      assert.equal(product.status, 'review');
      assert.equal(payloadDigest(product.draft.content), result.draftDigest);
      assert.equal((await recovered.work()).status, 'idle');
    } finally {
      recovered.close();
    }
    const keyfile = path.join(result.bundle, 'worker.key');
    assert.equal(
      fs
        .readFileSync(result.journal, 'utf8')
        .includes(fs.readFileSync(keyfile, 'utf8')),
      false
    );
    if (process.platform === 'win32') {
      const script = [
        "$ErrorActionPreference = 'Stop'",
        '$acl = [System.IO.Directory]::GetAccessControl($env:PIE_DRILL_TEST_BUNDLE)',
        '$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
        '$rules = $acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])',
        'if (!$acl.AreAccessRulesProtected -or @($rules).Count -ne 1 -or $rules[0].IdentityReference.Value -ne $sid) {exit 1}'
      ].join('\n');
      execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        {
          env: { ...process.env, PIE_DRILL_TEST_BUNDLE: result.bundle },
          timeout: 10000,
          windowsHide: true
        }
      );
    } else {
      assert.equal(fs.statSync(result.bundle).mode & 0o777, 0o700);
      for (const file of fs.readdirSync(result.bundle))
        assert.equal(
          fs.statSync(path.join(result.bundle, file)).mode & 0o777,
          0o600
        );
    }
  }
);

test('an interrupted restore cannot open as a Studio, and the intact bundle can be retried', (t) => {
  const { studio, dir } = fixture(t);
  const bundle = path.join(dir, 'bundle');
  const interrupted = path.join(dir, 'interrupted');
  createRecoveryBundle(studio, bundle);
  const copy = fs.copyFileSync;
  const fault = t.mock.method(fs, 'copyFileSync', (from, to, flags) => {
    if (path.basename(to) === 'snapshot.pending') {
      fs.writeFileSync(to, 'partial snapshot', { mode: 0o600 });
      throw Error('Simulated disk interruption');
    }
    copy(from, to, flags);
  });
  assert.throws(
    () => restoreRecoveryBundle(bundle, interrupted),
    /disk interruption/
  );
  fault.mock.restore();
  assert.throws(() => new Studio(interrupted), /Initialize this studio first/);
  const recovered = restoreRecoveryBundle(bundle, path.join(dir, 'retry'));
  try {
    assert.equal(
      recovered.store.read().studio.brandTask,
      studio.store.read().studio.brandTask
    );
  } finally {
    recovered.close();
  }
});

test('recovery rejects incomplete bundles, unrelated keys, altered bytes and an occupied destination', (t) => {
  const { studio, dir } = fixture(t);
  const bundle = path.join(dir, 'bundle'),
    restore = path.join(dir, 'restore');
  createRecoveryBundle(studio, bundle);
  fs.mkdirSync(restore);
  assert.throws(() => restoreRecoveryBundle(bundle, restore), {
    code: 'EEXIST'
  });
  assert.deepEqual(fs.readdirSync(restore), []);
  fs.rmdirSync(restore);
  const keyfile = path.join(bundle, 'worker.key');
  const original = fs.readFileSync(keyfile);
  fs.writeFileSync(keyfile, '1'.repeat(64));
  assert.throws(
    () => restoreRecoveryBundle(bundle, restore),
    /enrollment does not match/
  );
  fs.writeFileSync(keyfile, original);
  fs.appendFileSync(path.join(bundle, 'studio.sqlite'), 'changed fixture');
  assert.throws(
    () => restoreRecoveryBundle(bundle, restore),
    /digest mismatch/
  );
  fs.unlinkSync(path.join(bundle, 'manifest.json'));
  assert.throws(() => restoreRecoveryBundle(bundle, restore), {
    code: 'ENOENT'
  });
  assert.equal(fs.existsSync(restore), false);
  fs.writeFileSync(path.join(studio.dir, 'worker.key'), '2'.repeat(64));
  const other = path.join(dir, 'mismatched-at-backup');
  assert.throws(
    () => createRecoveryBundle(studio, other),
    /enrollment does not match/
  );
  assert.equal(fs.existsSync(path.join(other, 'manifest.json')), false);
});

test(
  'checkpointed child terminates when its parent disconnects',
  { timeout: 10000 },
  async (t) => {
    const { studio } = fixture(t);
    const { owner, actor, run } = studio.store.read().studio;
    const worker = studio.engine.enroll(owner);
    studio.engine.probe(owner, worker.node, {
      name: 'recovery-sample',
      version: '1',
      state: 'supported',
      evidence: 'test'
    });
    const task = studio.engine.enqueue(owner, {
      actor,
      run,
      capability: 'recovery-sample',
      budgetRef: 'synthetic',
      retryLimit: 1,
      deadline: Date.now() + 60000
    }).id;
    const child = childWorker(t);
    const ack = once(child, 'message', { signal: AbortSignal.timeout(5000) });
    const stopped = once(child, 'exit', { signal: AbortSignal.timeout(8000) });
    child.send({ filename: studio.file, task, worker });
    assert.equal((await ack)[0].task, task);
    child.disconnect();
    assert.deepEqual(await stopped, [0, null]);
  }
);

test(
  'child watchdog terminates a stalled but still connected worker',
  { timeout: 5000 },
  async (t) => {
    const child = childWorker(t, ['150']);
    assert.deepEqual(
      await once(child, 'exit', { signal: AbortSignal.timeout(4000) }),
      [1, null]
    );
  }
);
