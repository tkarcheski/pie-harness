import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../../packages/local/store.mjs';
import {
  initialize,
  approveOperation,
  submitOperation,
  reconcileOperation,
  resaleCommand
} from '../../packages/resale/desk.mjs';
import { FixtureMarketplace } from '../../packages/resale/fixture-marketplace.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-resale-rehearsal-'));
const hour = 3600000;
const start = Date.UTC(2030, 0, 15, 12);
let now = start,
  db;
const clock = () => now,
  stamp = (n) => new Date(start + n * hour).toISOString();
const recipient = new Store(path.join(dir, 'recipient.sqlite'), clock);
try {
  const file = path.join(dir, 'shop.sqlite');
  db = new Store(file, clock);
  const owner = initialize(db);
  const change = (command, input) =>
    resaleCommand(db, owner, command, {
      eventId: 'sample-' + command,
      ...input
    });
  change('intake', {
    id: 'sample-item',
    title: 'Practice binoculars',
    matchKey: 'sample-model',
    quantity: 1,
    ownership: 'owned',
    condition: 'good'
  });
  change('review', {
    itemId: 'sample-item',
    reviewRef: 'vault:sample-inspection',
    rightsRef: 'vault:sample-rights',
    photoRefs: ['vault:sample-photo'],
    provenanceRef: 'vault:sample-provenance'
  });
  const draft = change('draft', {
    id: 'sample-offer',
    itemId: 'sample-item',
    currency: 'USD',
    comparables: [2000, 2200, 2400].map((amountMinor, i) => ({
      sourceRef: 'vault:sample-comparable-' + i,
      observedAt: stamp(-i - 1),
      kind: 'sold',
      matchKey: 'sample-model',
      condition: 'good',
      amountMinor,
      currency: 'USD'
    }))
  });
  const publish = {
    operationId: 'sample-publish',
    listingId: draft.id,
    verb: 'publish'
  };
  approveOperation(db, owner, {
    ...publish,
    expectedDigest: resaleCommand(db, owner, 'preview-write', publish).digest,
    expiresAt: stamp(1)
  });
  const lost = await submitOperation(
    db,
    owner,
    publish,
    new FixtureMarketplace(recipient, { loseReply: true })
  );
  db.close();
  db = null;
  db = new Store(file, clock);
  const recovered = await reconcileOperation(
    db,
    owner,
    publish.operationId,
    new FixtureMarketplace(recipient)
  );
  now += hour;
  const order = change('order', {
    id: 'sample-order',
    orderedAt: stamp(1),
    shipBy: stamp(24),
    currency: 'USD',
    evidenceRef: 'vault:sample-paid',
    lines: [
      {
        lineId: 'sample-line',
        marketplaceListingId: 'fixture-sample-offer',
        quantity: 1,
        grossMinor: 2200
      }
    ]
  });
  change('ship', {
    orderId: order.id,
    trackingRef: 'vault:sample-postage-acceptance',
    shippedAt: stamp(1)
  });
  const end = { operationId: 'sample-end', listingId: draft.id, verb: 'end' };
  approveOperation(db, owner, {
    ...end,
    expectedDigest: resaleCommand(db, owner, 'preview-write', end).digest,
    expiresAt: stamp(2)
  });
  await submitOperation(db, owner, end, new FixtureMarketplace(recipient));
  change('payout', {
    id: 'sample-payout',
    currency: 'USD',
    netMinor: 1760,
    observedAt: stamp(1),
    evidenceRef: 'vault:sample-statement'
  });
  for (const [kind, amountMinor] of [
    ['sale', 2200],
    ['fee', 240],
    ['refund', 200]
  ]) {
    change('settlement-line', {
      eventId: 'sample-' + kind,
      id: kind,
      payoutId: 'sample-payout',
      orderId: order.id,
      kind,
      amountMinor,
      observedAt: stamp(1),
      currency: 'USD',
      evidenceRef: 'vault:sample-' + kind
    });
  }
  change('bank-observation', {
    id: 'sample-bank',
    payoutId: 'sample-payout',
    amountMinor: 1760,
    currency: 'USD',
    observedAt: stamp(1),
    evidenceRef: 'vault:sample-bank-entry',
    matchRef: 'vault:sample-payout-reference'
  });
  const status = resaleCommand(db, owner, 'status');
  console.log(
    JSON.stringify(
      {
        mode: 'synthetic rehearsal',
        range: draft.range,
        lostReply: lost.status,
        recovered: recovered.status,
        recipientWrites: recipient.read().testMarketplace.length,
        listing: status.listings[0].status,
        order: status.orders[0].status,
        payout: status.payouts[0],
        openHandoffs: status.ownerQueue.length
      },
      null,
      2
    )
  );
} finally {
  db?.close();
  recipient.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
