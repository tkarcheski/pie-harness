import fs from 'node:fs/promises';
import { qualifyProfile } from '../../packages/connectors/profiles.mjs';

try {
  if (process.argv.length !== 4)
    throw Error(
      'Supply the serving-profile JSON and device telemetry JSON paths'
    );
  const read = async (p) => JSON.parse(await fs.readFile(p, 'utf8'));
  const result = await qualifyProfile(await read(process.argv[2]), {
    sampleMemory: () => read(process.argv[3]),
    token: process.env.PIE_LOCAL_SERVING_KEY
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== 'qualified') process.exitCode = 2;
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
