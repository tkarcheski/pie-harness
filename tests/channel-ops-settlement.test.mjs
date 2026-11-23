import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../packages/local/store.mjs';
import { researchCommand, ranking } from '../packages/channel-ops/research.mjs';

test('opportunity settlement reconciles the exact experiment and records actual contribution apart from owner time and forecasts', (t) => {
  const now = 100000,
    store = new Store(':memory:', () => now);
  t.after(() => store.close());
  store.change((s) => {
    s.studio = {
      orders: {
        first: {
          channelExperiment: 'closed',
          currency: 'USD',
          settlement: { differenceMinor: 0, time: 90000, postedMinor: 470 }
        },
        second: {
          channelExperiment: 'closed',
          currency: 'USD',
          settlement: null
        },
        earlier: {
          channelExperiment: 'another-edition',
          currency: 'USD',
          settlement: { differenceMinor: 0, time: 90000, postedMinor: 5000 }
        }
      }
    };
    s.d = {
      opportunities: {
        guide: {
          id: 'guide',
          forecast: {
            contributionMinor: 1200,
            cashDays: 1,
            ownerMinutes: 15,
            reliabilityBps: 6000,
            growthBps: 50
          },
          forecastEvidence: { ref: 'evidence:forecast' },
          actuals: []
        }
      },
      experiments: {
        closed: {
          id: 'closed',
          opportunity: 'guide',
          releasedAt: 1000,
          endedAt: 80000,
          observations: [{ evidence: { observedAt: 80000 } }],
          totals: { costMinor: 50, ownerMinutes: 9 }
        }
      }
    };
  });
  const input = {
    id: 'guide',
    experiment: 'closed',
    costsComplete: true,
    evidence: {
      ref: 'evidence:period-close',
      observedAt: now,
      note: 'Completed observation of other costs.'
    }
  };
  const run = (data) =>
    store.change((s, at) =>
      researchCommand(s, s.d, 'opportunity-settlement', data, at)
    );
  assert.throws(() => run(input), /settlements/);
  store.change((s) => {
    s.studio.orders.second.settlement = {
      differenceMinor: 5,
      time: 95000,
      postedMinor: 80
    };
  });
  assert.throws(() => run(input), /settlements/);
  store.change((s) => {
    s.studio.orders.second.settlement.differenceMinor = 0;
  });
  assert.throws(() => run({ ...input, costsComplete: false }), /costs/);
  assert.throws(
    () => run({ ...input, evidence: { ...input.evidence, observedAt: 90000 } }),
    /predates/
  );
  const actual = run(input).actuals[0];
  assert.equal(actual.metrics.contributionMinor, 500);
  assert.equal(actual.metrics.ownerMinutes, 9);
  assert.equal(actual.settlement.settledOrders, 2);
  assert.equal(actual.settlement.netReceiptsMinor, 550);
  assert.throws(() => run(input), /already recorded/);
  const [row] = ranking(store.read().d, {}).opportunities;
  assert.equal(row.components.contributionMinor.basis, 'observed');
  assert.equal(row.forecast.contributionMinor, 1200);
  assert.equal(row.components.cashDays.basis, 'forecast');
});
