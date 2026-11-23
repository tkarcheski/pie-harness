import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Readable, PassThrough } from 'node:stream';
import { MediaDesk } from '../packages/connectors/media.mjs';
import { payloadDigest } from '../packages/local/authority.mjs';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAD0lEQVR4nGNgqKsHIQgFABm+A/WP1l8ZAAAAAElFTkSuQmCC',
  'base64'
);
const spec = {
  key: 'test',
  kind: 'image',
  width: 2,
  height: 2,
  sourceRef: 'fixture:input',
  rightsRef: 'fixture:owner',
  maxBytes: 4096,
  stepMs: 2000,
  jobMs: 60000
};
const valid = {
  id: 'fixture',
  start: () => ({
    output: Readable.from([png]),
    done: Promise.resolve(),
    stop() {}
  })
};
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-media-'));
  const time = { now: Date.now() };
  const desk = new MediaDesk(directory, { clock: () => time.now });
  t.after(() => {
    desk.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, desk, time };
}
test('PIE-025 publishes immutable evidence, repairs an interrupted commit and flags corrupt output', async (t) => {
  const { desk, directory } = fixture(t);
  const result = await desk.render(spec, valid);
  assert.equal(result.sha256, payloadDigest(png));
  assert.equal(result.rightsRef, spec.rightsRef);
  assert.deepEqual(
    await desk.render(spec, {
      ...valid,
      start: () => {
        throw Error('repeated work');
      }
    }),
    result
  );
  await assert.rejects(
    desk.render({ ...spec, width: 4 }, valid),
    /Conflicting/
  );
  // A crash after bundle rename rolls back its surrounding SQLite update.
  desk.store.change((s) => {
    const job = s.mediaJobs[0];
    job.state = 'running';
    delete job.artifact;
  });
  assert.deepEqual(desk.recover(), [{ key: 'test', state: 'done' }]);
  assert.equal(desk.status(spec.key).artifact.sha256, result.sha256);
  fs.appendFileSync(path.join(directory, result.job, result.file), 'tail');
  assert.throws(() => desk.recover(), /manifest/);
});
test('PIE-025 enforces byte, duration and attempt caps and cleans staging on cancellation', async (t) => {
  const { desk, directory } = fixture(t);
  const budget = { ...spec, maxBytes: 16, maxAttempts: 1 };
  await assert.rejects(desk.render(budget, valid), /budget/);
  assert.equal(desk.status('test').state, 'failed');
  const truncated = {
    ...valid,
    start: () => ({
      output: Readable.from([png.subarray(0, 32)]),
      done: Promise.resolve(),
      stop() {}
    })
  };
  await assert.rejects(
    desk.render({ ...spec, key: 'partial' }, truncated),
    /Incomplete/
  );
  const hold = {
    ...valid,
    start: () => {
      const output = new PassThrough();
      output.write(png.subarray(0, 24));
      return { output, done: Promise.resolve(), stop: () => output.destroy() };
    }
  };
  const job = desk.render({ ...spec, key: 'cancel' }, hold);
  assert.equal(desk.cancel('cancel').state, 'cancelled');
  await assert.rejects(job, /interrupt|abort/i);
  assert.equal(desk.status('cancel').state, 'cancelled');
  await assert.rejects(
    desk.render({ ...spec, key: 'timeout', stepMs: 20, maxAttempts: 1 }, hold),
    /interrupt|abort/i
  );
  assert.equal(desk.status('timeout').state, 'failed');
  assert(!fs.readdirSync(directory).some((n) => n.startsWith('.stage-')));
});
test('PIE-025 a separate supervisor recovers a killed renderer and resumes its original job', async (t) => {
  const { desk, directory, time } = fixture(t);
  const url = new URL('../packages/connectors/media.mjs', import.meta.url).href;
  const script =
    'import {MediaDesk} from ' +
    JSON.stringify(url) +
    ";import {PassThrough} from 'node:stream';" +
    'const desk=new MediaDesk(process.argv[1]);await desk.render(' +
    JSON.stringify(spec) +
    ",{id:'fixture',start(){const out=new PassThrough();" +
    "out.write(Buffer.from('partial'));setTimeout(()=>console.log('ready'),40);return {output:out,done:new Promise(()=>{}),stop(){out.destroy()}}}});";
  const child = spawn(
    process.execPath,
    ['--input-type=module', '-e', script, directory],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
  );
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  });
  const closed = once(child, 'close'),
    ready = await Promise.race([
      once(child.stdout, 'data').then(([b]) => b.toString().trim()),
      closed.then(() => null)
    ]);
  assert.equal(ready, 'ready');
  child.kill('SIGKILL');
  await closed;
  const before = desk.status('test');
  assert.equal(before.state, 'running');
  time.now = before.attempt.until + 1;
  assert.equal(desk.recover()[0].state, 'ready');
  const result = await desk.render(spec, valid);
  assert.equal(desk.status('test').attempts, 2);
  assert.equal(result.sha256, payloadDigest(png));
  assert(!fs.readdirSync(directory).some((n) => n.startsWith('.stage-')));
});
