import {
  checkConformance,
  fixtureConnector
} from '../../packages/connectors/sdk.mjs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const filename = process.argv[2];
try {
  const factory = filename
    ? (await import(pathToFileURL(path.resolve(filename)))).fixtureConnector
    : fixtureConnector;
  console.log(JSON.stringify(await checkConformance(factory), null, 2));
} catch (error) {
  console.error('Connector conformance failed: ' + error.message);
  process.exitCode = 1;
}
