import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../../packages/local/store.mjs';
import {
  approveOperation,
  initialize,
  reconcileOperation,
  resaleCommand,
  submitOperation
} from '../../packages/resale/desk.mjs';
import { FixtureMarketplace } from '../../packages/resale/fixture-marketplace.mjs';

const [directory, command, inputFile, ...extra] = process.argv.slice(2);
async function main() {
  if (!directory || !command || extra.length)
    throw Error(
      'Usage: node apps/resale/cli.mjs DIRECTORY COMMAND [JSON_FILE|-]. See docs/resale.md'
    );
  let input = {};
  if (inputFile) {
    const raw = fs
      .readFileSync(inputFile === '-' ? 0 : inputFile, 'utf8')
      .replace(/^\uFEFF/, '');
    try {
      input = JSON.parse(raw);
    } catch {
      throw Error('Invalid resale input JSON');
    }
  }
  const filename = path.resolve(directory, 'resale.sqlite');
  let existing = path.dirname(filename);
  while (!fs.existsSync(existing)) existing = path.dirname(existing);
  for (
    let cursor = fs.realpathSync(existing);
    ;
    cursor = path.dirname(cursor)
  ) {
    if (fs.existsSync(path.join(cursor, '.git')))
      throw Error('Choose a private data directory outside a Git checkout');
    if (path.dirname(cursor) === cursor) break;
  }
  if (command === 'init')
    fs.mkdirSync(path.dirname(filename), { mode: 0o700, recursive: true });
  else if (!fs.existsSync(filename))
    throw Error('Initialize the resale directory first');
  for (const file of [
    filename,
    path.join(path.dirname(filename), 'simulated-marketplace.sqlite')
  ]) {
    if (
      fs.existsSync(file) &&
      (!fs.lstatSync(file).isFile() || fs.statSync(file).nlink !== 1)
    )
      throw Error('Use regular local database files');
  }
  const store = new Store(filename);
  let recipient;
  try {
    if (command === 'init')
      return { owner: initialize(store), mode: 'local-rehearsal' };
    const owner = store.read().resaleLocalOwner;
    if (command === 'approve-write')
      return approveOperation(store, owner, input);
    if (['submit-write', 'reconcile-write'].includes(command)) {
      recipient = new Store(
        path.resolve(directory, 'simulated-marketplace.sqlite')
      );
      const adapter = new FixtureMarketplace(recipient);
      return command === 'submit-write'
        ? await submitOperation(store, owner, input, adapter)
        : await reconcileOperation(store, owner, input.operationId, adapter);
    }
    return resaleCommand(store, owner, command, input);
  } finally {
    recipient?.close();
    store.close();
  }
}
main()
  .then((r) => console.log(JSON.stringify(r, null, 2)))
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
