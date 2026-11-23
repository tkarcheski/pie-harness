import { isDeepStrictEqual } from 'node:util';
import { channelCommand, channelTick } from './channel.mjs';
import { researchCommand, ranking } from './research.mjs';
import { check, key } from './values.mjs';

const ownerOnly = new Set([
  'channel-register',
  'channel-grant',
  'channel-revoke',
  'product-rights',
  'document-review',
  'research-open',
  'research-stop',
  'opportunity-override',
  'opportunity-settlement',
  'experiment-approve',
  'experiment-decide'
]);
const research = new Set([
  'research-open',
  'research-begin',
  'research-result',
  'research-stop',
  'research-get',
  'opportunity-record',
  'opportunity-actual',
  'opportunity-settlement',
  'opportunity-override'
]);
const channel = new Set([
  'channel-register',
  'channel-grant',
  'channel-revoke',
  'product-rights',
  'document-register',
  'document-review',
  'health-check',
  'experiment-plan',
  'experiment-approve',
  'experiment-observe',
  'experiment-decide'
]);
function init(s) {
  check(s.studio, 'Initialize the digital-product studio first');
  return (s.channelOps ??= {
    studies: {},
    opportunities: {},
    grants: {},
    documents: {},
    experiments: {},
    health: [],
    registration: null,
    receipts: {}
  });
}
// Keep one response per request without copying an ever-growing history into
// every receipt. Full dated line items stay in the primary study or experiment.
function receipt(result) {
  const response = { ...result };
  for (const [field, count] of Object.entries({
    attempts: 'attemptCount',
    findings: 'findingCount',
    actuals: 'actualCount',
    overrideHistory: 'overrideCount',
    decisions: 'decisionCount',
    observations: 'measurementCount',
    reviews: 'reviewCount'
  })) {
    if (Array.isArray(response[field])) {
      response[count] = response[field].length;
      delete response[field];
    }
  }
  return response;
}
// The caller supplies its role at the process boundary. No command accepts an actor in the payload.
export function deskCommand(store, command, input = {}, role = 'agent') {
  check(['owner', 'agent'].includes(role), 'Unknown caller');
  check(
    input && typeof input === 'object' && !Array.isArray(input),
    'Supply a JSON object'
  );
  check(
    !ownerOnly.has(command) || role === 'owner',
    'Requires the channel owner'
  );
  return store.change((s, now) => {
    const d = init(s);
    channelTick(s, now);
    if (command === 'opportunity-rank') return ranking(d, input);
    if (command === 'research-get')
      return researchCommand(s, d, command, input, now);
    if (command === 'status')
      return {
        registration: d.registration,
        grants: d.grants,
        studies: d.studies,
        opportunities: d.opportunities,
        documents: d.documents,
        experiments: d.experiments,
        health: d.health.at(-1) ?? null,
        nextHealthAt: d.nextHealthAt ?? null,
        alerts: (s.alerts ?? []).filter(
          (a) =>
            a.code === 'channel-review' &&
            a.owner === s.studio.owner &&
            a.status !== 'resolved'
        )
      };
    check(
      research.has(command) || channel.has(command),
      'Unknown channel desk command'
    );
    const { requestId, ...o } = input,
      id = key(requestId, 'request ID');
    const prior = d.receipts[id];
    if (prior) {
      check(
        prior.command === command &&
          prior.role === role &&
          isDeepStrictEqual(prior.input, o),
        'Conflicting request replay'
      );
      return prior.result;
    }
    const result = research.has(command)
      ? researchCommand(s, d, command, o, now)
      : channelCommand(s, d, command, o, now);
    channelTick(s, now);
    d.receipts[id] = {
      command,
      role,
      input: o,
      result: receipt(result)
    };
    return d.receipts[id].result;
  });
}
