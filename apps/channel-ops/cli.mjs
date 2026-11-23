import fs from 'node:fs';
import path from 'node:path';
import { Studio } from '../studio/channel.mjs';
import { deskCommand } from '../../packages/channel-ops/desk.mjs';
import { runRehearsal } from './rehearsal.mjs';

const usage =
  'node apps/channel-ops/cli.mjs STATE_DIRECTORY COMMAND [input.json|-]\nInitialize an operating workspace with apps/studio/cli.mjs init. Use rehearse in a fresh directory for the isolated internal experiment. Commands and input fields are in docs/channel-ops.md.';
const [dir, cmd, file, ...extra] = process.argv.slice(2);
let studio;
try {
  if (!dir || dir === '--help' || cmd === '--help') console.log(usage);
  else {
    if (!cmd || extra.length) throw Error(usage);
    const demo = cmd === 'rehearse';
    if (demo && (file || fs.existsSync(path.join(dir, 'studio.sqlite'))))
      throw Error('Rehearsal needs a fresh workspace and no input');
    studio = new Studio(dir, { initialize: demo });
    const input = file
      ? JSON.parse(
          fs
            .readFileSync(file === '-' ? 0 : file, 'utf8')
            .replace(/^\uFEFF/, '')
        )
      : {};
    const result = demo
      ? await runRehearsal(studio)
      : deskCommand(studio.store, cmd, input, 'owner');
    console.log(JSON.stringify(result, null, 2));
  }
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  studio?.close();
}
