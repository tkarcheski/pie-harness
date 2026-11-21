import { appendFileSync } from 'node:fs';
import { Store } from '../../packages/local/store.mjs';
import { Execution } from '../../packages/local/execution.mjs';

process.on('message', (job) => {
  const store = new Store(job.filename, () => job.now);
  const engine = new Execution(store, job.config);
  const claim = engine.claim(job.worker);
  const worker = { ...job.worker, fence: claim.fence };
  const result = engine.beginEffect(claim.task, worker, job.request);
  if (result.decision !== 'allow') throw Error('Fixture effect was denied');
  appendFileSync(job.receipts, result.intent + '\n');
  process.send({ intent: result.intent });
  // Wait after the simulated recipient accepts, before local confirmation.
});
