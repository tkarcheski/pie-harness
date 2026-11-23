import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../packages/local/store.mjs';
import { Accounts, OwnerPolicy } from '../packages/local/authority.mjs';
import {
  initialize,
  bindResaleDesk,
  resaleCommand,
  approveOperation,
  submitOperation,
  reconcileOperation
} from '../packages/resale/desk.mjs';
import { FixtureMarketplace } from '../packages/resale/fixture-marketplace.mjs';
import { EbaySandboxOffers } from '../packages/resale/ebay.mjs';
import { changeIncident } from '../packages/local/connections.mjs';

const at = Date.parse('2030-06-15T14:00:00Z'),
  stamp = (offset) => new Date(at + offset).toISOString();
test('malformed owner input does not expose raw buyer data in CLI diagnostics', () => {
  const cli = fileURLToPath(new URL('../apps/resale/cli.mjs', import.meta.url));
  const contact = 'synthetic-buyer@example.invalid';
  const result = spawnSync(
    process.execPath,
    [cli, os.tmpdir(), 'order-from-ebay', '-'],
    {
      encoding: 'utf8',
      input: contact
    }
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^Invalid resale input JSON\r?$/m);
  assert.equal((result.stdout + result.stderr).includes(contact), false);
});
const owned = {
  ownership: 'owned',
  condition: 'good',
  photoRefs: ['vault:photo-a'],
  provenanceRef: 'vault:receipt',
  rightsRef: 'vault:photo-rights'
};
function inputs() {
  const item = {
    id: 'binoculars',
    title: 'Synthetic binoculars',
    matchKey: 'synthetic-8x40',
    quantity: 2,
    ownership: 'uncertain',
    condition: 'unknown'
  };
  const comp = (n, price, fields = {}) => ({
    sourceRef: 'vault:sale-' + n,
    observedAt: stamp(-n * 86400000),
    kind: 'sold',
    matchKey: item.matchKey,
    condition: 'good',
    amountMinor: price,
    currency: 'USD',
    ...fields
  });
  const draft = {
    id: 'offer-a',
    itemId: item.id,
    currency: 'USD',
    comparables: [
      comp(1, 1200),
      comp(2, 1000),
      comp(3, 1400),
      comp(4, 99999, { kind: 'ask' }),
      comp(5, 1, { condition: 'parts' }),
      comp(120, 2)
    ]
  };
  return { item, draft };
}
function env(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resale-'));
  const file = path.join(dir, 'desk.sqlite'),
    recipient = new Store(path.join(dir, 'remote.sqlite'));
  const env = { now: at, seq: 0, recipient };
  env.store = new Store(file, () => env.now);
  env.owner = initialize(env.store);
  env.remote = new FixtureMarketplace(recipient);
  env.reopen = () => {
    env.store.close();
    env.store = new Store(file, () => env.now);
  };
  env.cmd = (cmd, input) => resaleCommand(env.store, env.owner, cmd, input);
  env.change = (cmd, x) =>
    env.cmd(cmd, { eventId: 'event-' + ++env.seq, ...x });
  env.ready = () => {
    const { item, draft } = inputs();
    env.change('intake', item);
    env.change('review', {
      itemId: item.id,
      ...owned,
      reviewRef: 'vault:review'
    });
    return env.change('draft', draft);
  };
  env.approve = (verb = 'publish', operationId = verb) =>
    approveOperation(env.store, env.owner, {
      listingId: 'offer-a',
      verb,
      operationId,
      expectedDigest: env.cmd('preview-write', {
        listingId: 'offer-a',
        verb,
        operationId
      }).digest,
      expiresAt: stamp(3600000)
    });
  env.send = (verb = 'publish', operationId = verb, connector = env.remote) =>
    submitOperation(
      env.store,
      env.owner,
      { listingId: 'offer-a', verb, operationId },
      connector
    );
  env.order = () =>
    env.change('order', {
      id: 'sale-1',
      orderedAt: stamp(0),
      shipBy: stamp(86400000),
      currency: 'USD',
      evidenceRef: 'vault:paid-order',
      lines: [
        {
          lineId: 'line-1',
          marketplaceListingId: 'fixture-offer-a',
          quantity: 1,
          grossMinor: 1200
        }
      ]
    });
  t.after(() => {
    env.store.close();
    recipient.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return env;
}
test('PIE-013 and PIE-014 tie a reviewed draft to human evidence and dated like-for-like sold prices', async (t) => {
  const e = env(t),
    { item, draft } = inputs();
  const received = e.change('intake', item);
  assert.equal(received.classification, 'liquidity');
  assert.deepEqual(
    e.cmd('queue').map((x) => x.code),
    ['review-ownership-condition-rights']
  );
  let offer = e.change('draft', draft);
  assert.ok(offer.flags.includes('condition'));
  assert.ok(offer.flags.includes('rights'));
  assert.equal(offer.range.confidence, 'unpriced');
  assert.throws(() => e.approve(), /Review listing evidence/);
  e.change('review', {
    itemId: item.id,
    ...owned,
    reviewRef: 'vault:owner-review'
  });
  assert.equal(e.cmd('queue').length, 0);
  assert.ok(
    e.cmd('listing', { listingId: offer.id }).flags.includes('stale-draft')
  );
  offer = e.change('draft', draft);
  assert.equal(offer.priceMinor, 1200);
  assert.deepEqual(
    [
      offer.range.lowMinor,
      offer.range.highMinor,
      offer.range.sample,
      offer.range.confidence
    ],
    [1000, 1400, 3, 'corroborated']
  );
  assert.equal((await e.send()).status, 'denied');
  e.approve();
  e.change('draft', { ...draft, priceMinor: 1150 });
  const stale = e.cmd('preview-write', {
    listingId: 'offer-a',
    verb: 'publish',
    operationId: 'publish'
  });
  e.change('draft', { ...draft, priceMinor: 1140 });
  assert.throws(
    () =>
      approveOperation(e.store, e.owner, {
        listingId: 'offer-a',
        verb: 'publish',
        operationId: 'publish',
        expectedDigest: stale.digest,
        expiresAt: stamp(3600000)
      }),
    /current listing proposal/
  );
  assert.equal(
    (await e.send()).status,
    'denied',
    'revised amount needs a new owner approval'
  );
  const scope = e.store.read().resaleDesks[0];
  new OwnerPolicy(e.store).grant(e.owner, {
    actor: scope.actor,
    account: scope.account,
    action: 'ebay.publish',
    currency: 'USD',
    limitMinor: 0,
    validFrom: at,
    expiresAt: at + 90000
  });
  assert.equal(
    (await e.send()).status,
    'denied',
    'standing scope alone cannot publish'
  );
  e.approve();
  new Accounts(e.store).rotate(
    e.owner,
    scope.account,
    'secret-ref:rotated-seller'
  );
  assert.equal(
    (await e.send()).status,
    'denied',
    'standing grant cannot rescue an exact approval from a previous credential revision'
  );
  e.approve();
  new Accounts(e.store).revoke(e.owner, scope.account);
  assert.equal((await e.send()).status, 'denied');
  assert.equal(e.recipient.read().testMarketplace, undefined);
  e.now += 91 * 86400000;
  assert.equal(e.cmd('listing', { listingId: offer.id }).range.sample, 0);
});
test('PIE-015 durable publish and end recover lost replies, fence concurrent sends and require recipient readback', async (t) => {
  const e = env(t);
  e.ready();
  e.approve();
  const failAfter = new FixtureMarketplace(e.recipient, { loseReply: true });
  const pending = await e.send('publish', 'publish', failAfter);
  assert.equal(pending.status, 'pending');
  assert.equal((await e.send('publish', 'publish')).status, 'pending');
  assert.equal(e.recipient.read().testMarketplace.length, 1);
  e.reopen();
  assert.throws(() => e.approve('publish', 'another'), /Reconcile/);
  const recovered = await reconcileOperation(
    e.store,
    e.owner,
    pending.id,
    e.remote
  );
  assert.equal(recovered.status, 'applied');
  assert.equal(e.cmd('listing', { listingId: 'offer-a' }).status, 'active');
  e.approve('end');
  const op = await e.send('end', 'end', {
    timeoutMs: 12,
    send: () => new Promise(() => {})
  });
  assert.equal(op.status, 'pending');
  assert.equal(
    (
      await reconcileOperation(e.store, e.owner, op.id, {
        lookup: () => ({ outcome: 'unknown' })
      })
    ).status,
    'pending'
  );
  assert.equal(
    (await reconcileOperation(e.store, e.owner, op.id, e.remote)).status,
    'pending'
  );
  e.now += 13;
  assert.equal(
    (await reconcileOperation(e.store, e.owner, op.id, e.remote)).status,
    'absent'
  );
  assert.equal((await e.send('end', 'end')).status, 'absent');
  assert.equal((await e.send('end', 'end-again')).status, 'denied');
  e.approve('end', 'end-again');
  assert.equal((await e.send('end', 'end-again')).status, 'applied');
  assert.equal(e.cmd('listing', { listingId: 'offer-a' }).status, 'ended');
  assert.equal(e.recipient.read().testMarketplace.length, 2);
  assert.equal(e.cmd('queue').length, 0);
});
test('PIE-016 deduplicates paid orders and sends due shipments and support exceptions to the owner', async (t) => {
  const e = env(t);
  e.ready();
  e.approve();
  await e.send();
  const input = {
    orderId: 'sale-1',
    creationDate: stamp(0),
    orderPaymentStatus: 'PAID',
    buyer: { username: 'sensitive-buyer' },
    buyerCheckoutNotes: 'sensitive note',
    lineItems: [
      {
        lineItemId: 'line-1',
        legacyItemId: 'fixture-offer-a',
        quantity: 1,
        lineItemCost: { currency: 'USD', value: '10.50' },
        deliveryCost: { shippingCost: { currency: 'USD', value: '1.50' } },
        total: { currency: 'USD', value: '12.00' },
        lineItemFulfillmentInstructions: { shipByDate: stamp(86400000) }
      }
    ]
  };
  const first = e.change('order-from-ebay', {
    evidenceRef: 'vault:paid',
    order: input
  });
  assert.equal(first.lines[0].grossMinor, 1200);
  e.change('order-from-ebay', {
    evidenceRef: 'vault:second-retrieval',
    order: input
  });
  assert.equal(e.cmd('status').orders.length, 1);
  assert.equal(e.cmd('queue').length, 1);
  assert.equal(e.cmd('status').items[0].onHand, 2);
  assert.equal(e.cmd('status').items[0].available, 1);
  assert.doesNotMatch(
    JSON.stringify(e.store.read()),
    /sensitive-buyer|sensitive note/
  );
  const bad = structuredClone(input);
  for (const extra of [
    { ebayCollectedCharges: { ebayCollectedCharityContributions: [] } },
    { discountedLineItemCost: { currency: 'USD', value: '10.00' } }
  ]) {
    const unsupported = structuredClone(input);
    Object.assign(unsupported.lineItems[0], extra);
    assert.throws(
      () =>
        e.change('order-from-ebay', {
          evidenceRef: 'vault:complex',
          order: unsupported
        }),
      /normalized order/
    );
  }
  bad.lineItems[0].total.value = '13.00';
  assert.throws(
    () =>
      e.change('order-from-ebay', {
        evidenceRef: 'vault:bad-source',
        order: bad
      }),
    /Unexplained/
  );
  e.now += 2 * 86400000;
  assert.equal(e.cmd('queue')[0].overdue, true);
  const shipped = e.change('ship', {
    orderId: first.id,
    shippedAt: stamp(2 * 86400000),
    trackingRef: 'vault:carrier-scan'
  });
  assert.equal(shipped.late, true);
  assert.equal(e.cmd('queue')[0].code, 'review-late-shipment');
  assert.equal(e.cmd('status').items[0].onHand, 1);
  assert.equal(e.cmd('status').items[0].awaitingShipment, 0);
  e.change('exception', {
    orderId: first.id,
    caseId: 'case-1',
    reason: 'carrier-delay',
    dueAt: stamp(3 * 86400000),
    evidenceRef: 'vault:contact-record'
  });
  assert.equal(e.cmd('queue').length, 2);
  assert.throws(
    () =>
      e.change('ship', {
        orderId: first.id,
        shippedAt: stamp(2 * 86400000),
        trackingRef: 'vault:carrier-scan',
        buyerEmail: 'example'
      }),
    /Unexpected/
  );
  e.change('ack-late', {
    orderId: first.id,
    resolutionRef: 'vault:owner-follow-up'
  });
  e.change('close-exception', {
    orderId: first.id,
    caseId: 'case-1',
    resolutionRef: 'vault:delivered'
  });
  assert.equal(e.cmd('queue').length, 0);
});
test('a concurrent submission observes the first send, and a paid order arriving before readback can still ship', async (t) => {
  const e = env(t);
  e.ready();
  e.approve();
  let finish, enter;
  const entered = new Promise((resolve) => {
    enter = resolve;
  });
  const transport = {
    send: async (payload, context) => {
      const result = await e.remote.send(payload, context);
      enter();
      await new Promise((resolve) => {
        finish = resolve;
      });
      return result;
    }
  };
  const first = e.send('publish', 'publish', transport);
  await entered;
  const duplicate = await e.send();
  assert.equal(duplicate.status, 'pending');
  assert.equal(
    (
      await reconcileOperation(e.store, e.owner, 'publish', {
        lookup: () => ({ outcome: 'absent', evidenceRef: 'vault:premature' })
      })
    ).status,
    'pending'
  );
  assert.equal(e.recipient.read().testMarketplace.length, 1);
  e.now = at + 3000;
  finish();
  assert.equal((await first).status, 'applied');
  assert.equal(e.order().orderedAt, at);
  assert.equal(e.cmd('status').orders.length, 1);
  assert.throws(
    () =>
      e.change('order', {
        id: 'over',
        orderedAt: stamp(0),
        shipBy: stamp(86400000),
        currency: 'USD',
        evidenceRef: 'vault:oversell',
        lines: [
          {
            lineId: 'overline',
            marketplaceListingId: 'fixture-offer-a',
            quantity: 2,
            grossMinor: 2400
          }
        ]
      }),
    /physical inventory/
  );
});
test('PIE-017 reconciles exact source lines, partial refunds, fees, observed deposits and mismatches after reopen', async (t) => {
  const e = env(t);
  e.ready();
  e.approve();
  await e.send();
  e.order();
  e.change('payout', {
    id: 'p1',
    currency: 'USD',
    observedAt: stamp(0),
    netMinor: 800,
    evidenceRef: 'vault:payout'
  });
  const line = (id, kind, amountMinor) => ({
    id,
    kind,
    amountMinor,
    currency: 'USD',
    payoutId: 'p1',
    orderId: 'sale-1',
    observedAt: stamp(0),
    evidenceRef: 'vault:line-' + id
  });
  e.change('settlement-line', line('credit', 'sale', 1200));
  e.change('settlement-line', line('fee', 'fee', 100));
  e.change('settlement-line', line('credit', 'sale', 1200));
  assert.throws(
    () => e.change('settlement-line', line('fee', 'fee', 150)),
    /Conflicting source/
  );
  assert.throws(
    () => e.change('settlement-line', line('another', 'sale', 1)),
    /exceed/
  );
  e.change('settlement-line', line('refund1', 'refund', 150));
  assert.throws(
    () => e.change('settlement-line', line('large-refund', 'refund', 1100)),
    /refunds exceed/
  );
  const bank = {
    id: 'deposit',
    payoutId: 'p1',
    currency: 'USD',
    observedAt: stamp(0),
    amountMinor: 800,
    matchRef: 'vault:remittance',
    evidenceRef: 'vault:bank'
  };
  e.change('bank-observation', bank);
  assert.ok(
    e
      .cmd('payout-report', { payoutId: 'p1' })
      .gaps.includes('settlement-differs-from-payout')
  );
  e.change('settlement-line', line('refund2', 'refund', 150));
  const result = e.cmd('payout-report', { payoutId: 'p1' });
  assert.deepEqual(
    [
      result.status,
      result.observedBankMinor,
      result.refundMinor,
      result.feeMinor
    ],
    ['matched', 800, 300, 100]
  );
  assert.equal(
    e.cmd('queue').filter((t) => t.subject === 'payout:p1').length,
    0
  );
  e.reopen();
  assert.deepEqual(e.cmd('payout-report', { payoutId: 'p1' }), result);
  e.change('payout', {
    id: 'p2',
    currency: 'USD',
    observedAt: stamp(0),
    netMinor: 800,
    evidenceRef: 'vault:other-payout'
  });
  assert.throws(
    () => e.change('bank-observation', { ...bank, payoutId: 'p2' }),
    /Conflicting source/
  );
  assert.equal(
    e.cmd('order-report', { orderId: 'sale-1' }).settlement.unbookedGrossMinor,
    0
  );
  assert.throws(() => e.change('bank-transfer', {}), /Unknown/);
});
test('eBay sandbox adapter binds the reviewed remote terms, maps published and withdrawn offers, and rejects a changed draft', async (t) => {
  const e = env(t);
  let published = false,
    sends = 0,
    actualPrice = '12.00',
    groupIds = [],
    containAfterInventory = false;
  const business = e.store.create('business', e.owner).id,
    actor = e.store.create('agent', e.owner, { business }).id;
  const otherOwner = e.store.create('owner', null).id;
  const otherBusiness = e.store.create('business', otherOwner).id,
    otherActor = e.store.create('agent', otherOwner, {
      business: otherBusiness
    }).id;
  const account = new Accounts(e.store).register(otherOwner, {
    business: otherBusiness,
    recoveryOwner: otherOwner,
    platform: 'ebay-sandbox',
    scopes: ['ebay.read', 'ebay.publish', 'ebay.end'],
    expiresAt: at + 86400000,
    secretRef: 'secret-ref:sample/sandbox'
  }).id;
  assert.throws(
    () =>
      bindResaleDesk(e.store, { owner: otherOwner, business, actor, account }),
    /Cross-owner/
  );
  bindResaleDesk(e.store, {
    owner: otherOwner,
    business: otherBusiness,
    actor: otherActor,
    account
  });
  e.owner = otherOwner;
  const fake = async (url, opts) => {
    const u = new URL(url);
    assert.equal(u.origin, 'https://api.sandbox.ebay.com');
    assert.equal(opts.redirect, 'error');
    if (opts.method === 'GET' && u.pathname.endsWith('/offer/123'))
      return Response.json({
        offerId: '123',
        sku: 'binoculars',
        format: 'FIXED_PRICE',
        status: published ? 'PUBLISHED' : 'UNPUBLISHED',
        availableQuantity: 2,
        pricingSummary: { price: { value: actualPrice, currency: 'USD' } },
        ...(published ? { listing: { listingId: '222' } } : {})
      });
    if (
      opts.method === 'GET' &&
      u.pathname.endsWith('/inventory_item/binoculars')
    ) {
      if (containAfterInventory)
        e.store.change((s, now) =>
          changeIncident(
            s,
            otherOwner,
            'connection-suspend',
            {
              id: 'sample-incident',
              account,
              reason: 'connector-failure',
              evidenceDigest: 'a'.repeat(64)
            },
            now
          )
        );
      return Response.json({
        sku: 'binoculars',
        groupIds,
        product: { title: 'Synthetic binoculars' },
        condition: 'USED_GOOD'
      });
    }
    if (opts.method === 'POST' && u.pathname.endsWith('/offer/123/publish')) {
      published = true;
      sends++;
      return Response.json({ listingId: '222' });
    }
    if (opts.method === 'POST' && u.pathname.endsWith('/offer/123/withdraw')) {
      published = false;
      sends++;
      return Response.json({ listingId: '222' });
    }
    throw Error('Unexpected fixture path');
  };
  const adapter = new EbaySandboxOffers({
    store: e.store,
    owner: otherOwner,
    account,
    resolveAccessToken: () => String(42),
    fetchImpl: fake
  });
  groupIds = ['fixture-variant-group'];
  await assert.rejects(adapter.inspect('123'), /single-SKU/);
  groupIds = [];
  const { digest } = await adapter.inspect('123');
  e.ready();
  const { draft } = inputs();
  e.change('draft', { ...draft, ebayOffer: { offerId: '123', digest } });
  e.approve();
  actualPrice = '88.00';
  assert.equal((await e.send('publish', 'publish', adapter)).status, 'pending');
  assert.equal(sends, 0);
  assert.equal(
    (await reconcileOperation(e.store, e.owner, 'publish', adapter)).status,
    'pending'
  );
  e.now += 15001;
  await reconcileOperation(e.store, e.owner, 'publish', {
    lookup: () => ({
      outcome: 'absent',
      evidenceRef: 'vault:sandbox-verified-absence'
    })
  });
  actualPrice = '12.00';
  e.approve('publish', 'publish-2');
  assert.equal(
    (await e.send('publish', 'publish-2', adapter)).status,
    'applied'
  );
  e.approve('end');
  containAfterInventory = true;
  assert.equal((await e.send('end', 'end', adapter)).status, 'pending');
  assert.equal(
    sends,
    1,
    'containment between reading inventory and POST must prevent the write'
  );
  containAfterInventory = false;
  const incident = {
    id: 'sample-incident',
    account,
    reviewDigest: 'b'.repeat(64)
  };
  e.store.change((s, now) =>
    changeIncident(
      s,
      otherOwner,
      'connection-approve-restore',
      { ...incident, expiresAt: now + 120000 },
      now
    )
  );
  e.store.change((s, now) =>
    changeIncident(s, otherOwner, 'connection-restore', incident, now)
  );
  e.now += 15001;
  await reconcileOperation(e.store, e.owner, 'end', {
    lookup: () => ({ outcome: 'absent', evidenceRef: 'vault:verified-absence' })
  });
  e.approve('end', 'end-restored');
  assert.equal(
    (await e.send('end', 'end-restored', adapter)).status,
    'applied'
  );
  assert.equal(sends, 2);
  // Revocation while fetching the protected inventory must suppress the snapshot.
  const nextAdapter = new EbaySandboxOffers({
    store: e.store,
    owner: otherOwner,
    account,
    resolveAccessToken: () => String(42),
    fetchImpl: async (url, opts) => {
      if (!url.includes('/inventory_item/')) return fake(url, opts);
      return {
        ok: true,
        async json() {
          new Accounts(e.store).revoke(otherOwner, account);
          return {
            sku: 'binoculars',
            product: { title: 'Private inventory' },
            condition: 'USED_GOOD'
          };
        }
      };
    }
  });
  await assert.rejects(nextAdapter.inspect('123'), /usable receipt/);
});
