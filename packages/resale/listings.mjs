import { isDeepStrictEqual } from 'node:util';
import { authorize, OwnerPolicy, payloadDigest } from '../local/authority.mjs';
import {
  check,
  choice,
  date,
  deskOf,
  fields,
  get,
  id,
  moneyCode,
  number,
  queue,
  ref,
  resolve,
  word
} from './records.mjs';

const day = 86400000;
const conditions = [
  'new',
  'like-new',
  'good',
  'fair',
  'poor',
  'parts',
  'unknown'
];
const evidenceKeys = [
  'ownership',
  'condition',
  'provenanceRef',
  'photoRefs',
  'rightsRef'
];
function evidence(input) {
  const photoRefs = input.photoRefs ?? [];
  check(
    Array.isArray(photoRefs) && photoRefs.length <= 12,
    'Supply up to twelve photo references'
  );
  return {
    ownership: choice(
      input.ownership,
      ['owned', 'uncertain', 'third-party'],
      'ownership'
    ),
    condition: choice(input.condition, conditions, 'condition'),
    provenanceRef:
      input.provenanceRef == null ? null : ref(input.provenanceRef),
    photoRefs: [...new Set(photoRefs.map(ref))],
    rightsRef: input.rightsRef == null ? null : ref(input.rightsRef)
  };
}
function missing(item) {
  const flags = [];
  if (item.ownership !== 'owned') flags.push('ownership');
  if (item.condition === 'unknown') flags.push('condition');
  if (!item.provenanceRef) flags.push('provenance');
  if (!item.photoRefs.length) flags.push('photos');
  if (!item.rightsRef) flags.push('rights');
  if (!item.reviewRef) flags.push('human-review');
  return flags;
}
function priceRange(listing, item, now) {
  const eligible = listing.comparables.filter(
    (c) =>
      c.kind === 'sold' &&
      c.condition === item.condition &&
      c.matchKey === item.matchKey &&
      c.currency === listing.currency &&
      c.observedAt >= now - 90 * day &&
      c.observedAt <= now
  );
  const prices = eligible.map((c) => c.amountMinor).sort((a, b) => a - b);
  return {
    sample: prices.length,
    lowMinor: prices[0] ?? null,
    highMinor: prices.at(-1) ?? null,
    medianMinor: prices.length
      ? Math.round(
          (prices[Math.floor((prices.length - 1) / 2)] +
            prices[Math.floor(prices.length / 2)]) /
            2
        )
      : null,
    confidence:
      prices.length >= 3
        ? 'corroborated'
        : prices.length
          ? 'limited'
          : 'unpriced',
    sourceRefs: eligible.map((c) => c.sourceRef)
  };
}
export function listingView(d, l, now) {
  const item = get(d.items, l.itemId, 'item'),
    range = priceRange(l, item, now),
    flags = missing(item);
  if (!range.sample) flags.push('dated-completed-sale');
  if (item.version !== l.itemVersion) flags.push('stale-draft');
  return { ...l, range, flags };
}
export function intakeCommand(s, d, command, x, now) {
  if (command === 'intake') {
    fields(x, [
      'eventId',
      'id',
      'title',
      'matchKey',
      'quantity',
      ...evidenceKeys
    ]);
    id(x.id);
    check(!d.items.some((i) => i.id === x.id), 'Item already received');
    const item = {
      id: x.id,
      title: word(x.title, 'item title', 80),
      matchKey: id(x.matchKey, 'comparable item key'),
      quantity: number(x.quantity, 'quantity', 1, 100000),
      ...evidence(x),
      reviewRef: null,
      version: 1,
      classification: 'liquidity',
      receivedAt: now
    };
    d.items.push(item);
    queue(
      s,
      d.owner,
      'item:' + item.id,
      'review-ownership-condition-rights',
      now,
      now
    );
    return item;
  }
  if (command === 'review') {
    fields(x, ['eventId', 'itemId', 'reviewRef', ...evidenceKeys]);
    const item = get(d.items, x.itemId, 'item');
    check(
      !d.listings.some(
        (l) => l.itemId === item.id && (l.pending || l.status === 'active')
      ),
      'End or reconcile the listing before changing its evidence'
    );
    const review = {
      ...item,
      ...evidence({ ...item, ...x }),
      reviewRef: ref(x.reviewRef)
    };
    Object.assign(item, review, { version: item.version + 1, reviewedAt: now });
    if (missing(item).length)
      queue(
        s,
        d.owner,
        'item:' + item.id,
        'review-ownership-condition-rights',
        now,
        now
      );
    else
      resolve(
        s,
        d.owner,
        'item:' + item.id,
        'review-ownership-condition-rights',
        now
      );
    return { ...item, flags: missing(item) };
  }
  fields(x, [
    'eventId',
    'id',
    'itemId',
    'currency',
    'priceMinor',
    'comparables',
    'ebayOffer'
  ]);
  const item = get(d.items, x.itemId, 'item'),
    listingId = id(x.id, 'listing ID');
  const current = d.listings.find(
    (l) => l.itemId === item.id || l.id === listingId
  );
  if (current)
    check(
      current.id === listingId &&
        current.itemId === item.id &&
        current.status === 'draft' &&
        !current.pending,
      'A physical lot can have only one draft; active or ended listings are immutable'
    );
  check(
    Array.isArray(x.comparables) && x.comparables.length <= 100,
    'Supply comparable observations'
  );
  const seen = new Set();
  const comparables = x.comparables.map((c) => {
    fields(c, [
      'sourceRef',
      'observedAt',
      'kind',
      'matchKey',
      'condition',
      'amountMinor',
      'currency'
    ]);
    const sourceRef = ref(c.sourceRef);
    check(!seen.has(sourceRef), 'Duplicate comparable sale or quote');
    seen.add(sourceRef);
    return {
      sourceRef,
      observedAt: date(c.observedAt, now),
      kind: choice(c.kind, ['sold', 'ask'], 'comparable type'),
      matchKey: id(c.matchKey),
      condition: choice(c.condition, conditions, 'comparable condition'),
      currency: moneyCode(c.currency),
      amountMinor: number(c.amountMinor, 'comparable price', 1)
    };
  });
  const listing = {
    id: listingId,
    itemId: item.id,
    itemVersion: item.version,
    version: (current?.version ?? 0) + 1,
    comparables,
    currency: moneyCode(x.currency),
    status: 'draft',
    quantity: item.quantity,
    pending: null,
    marketplaceListingId: null
  };
  const range = priceRange(listing, item, now);
  if (x.ebayOffer) {
    fields(x.ebayOffer, ['offerId', 'digest']);
    check(
      /^[a-f0-9]{64}$/.test(x.ebayOffer.digest),
      'Review the eBay offer snapshot first'
    );
    listing.ebayOffer = {
      offerId: id(x.ebayOffer.offerId),
      digest: x.ebayOffer.digest
    };
  } else listing.ebayOffer = null;
  listing.priceMinor =
    x.priceMinor == null
      ? range.medianMinor
      : number(x.priceMinor, 'proposed price', 1);
  if (current) Object.assign(current, listing);
  else d.listings.push(listing);
  return listingView(d, listing, now);
}
function proposal(d, l, verb, operationId, now) {
  const item = get(d.items, l.itemId, 'item');
  choice(verb, ['publish', 'end'], 'listing operation');
  check(!l.pending, 'Reconcile the outstanding listing operation');
  check(
    (verb === 'publish' && l.status === 'draft') ||
      (verb === 'end' && l.status === 'active'),
    'Invalid listing transition'
  );
  if (verb === 'publish') {
    const { flags } = listingView(d, l, now);
    check(!flags.length, 'Review listing evidence: ' + flags.join(', '));
    check(l.priceMinor > 0, 'Set a sale price');
  }
  const payload = {
    verb,
    operationId: id(operationId, 'operation ID'),
    listingId: l.id,
    itemId: item.id,
    version: l.version,
    marketplaceListingId: l.marketplaceListingId,
    ebayOffer: l.ebayOffer,
    title: item.title,
    condition: item.condition,
    quantity: l.quantity,
    unitPriceMinor: l.priceMinor,
    currency: l.currency
  };
  const bytes = JSON.stringify([d.actor, d.account, payload]);
  return {
    payload,
    request: {
      actor: d.actor,
      account: d.account,
      action: 'ebay.' + verb,
      object: l.id,
      digest: payloadDigest(bytes),
      amountMinor: 0,
      currency: l.currency,
      policyVersion: 1
    }
  };
}
export function previewOperation(d, x, now) {
  fields(x, ['operationId', 'listingId', 'verb']);
  const l = get(d.listings, x.listingId, 'listing');
  const { request, payload } = proposal(d, l, x.verb, x.operationId, now);
  return {
    actor: request.actor,
    account: request.account,
    digest: request.digest,
    payload
  };
}
export function approveOperation(store, owner, x) {
  fields(x, [
    'operationId',
    'listingId',
    'verb',
    'expiresAt',
    'expectedDigest'
  ]);
  const d = deskOf(store.read(), owner),
    l = get(d.listings, x.listingId, 'listing');
  const { request } = proposal(d, l, x.verb, x.operationId, store.clock());
  check(
    request.digest === x.expectedDigest,
    'The owner must preview and confirm the current listing proposal'
  );
  const expiry = date(x.expiresAt);
  new OwnerPolicy(store).approve(owner, request, expiry);
  return {
    listingId: l.id,
    operationId: x.operationId,
    operation: x.verb,
    digest: request.digest,
    expiresAt: expiry
  };
}

function finalize(s, d, op, answer, now) {
  check(
    answer && typeof answer === 'object',
    'Recipient did not supply evidence'
  );
  const outcome = choice(
    answer.outcome,
    ['applied', 'absent', 'unknown'],
    'recipient outcome'
  );
  if (op.status !== 'pending' || outcome === 'unknown') return { ...op };
  const l = get(d.listings, op.listingId, 'listing');
  check(l.pending === op.id, 'Outstanding operation changed');
  const evidenceRef = ref(answer.evidenceRef);
  if (outcome === 'applied') {
    const external = id(answer.marketplaceListingId, 'marketplace listing ID');
    if (op.verb === 'end')
      check(external === l.marketplaceListingId, 'Wrong marketplace listing');
    check(
      !d.listings.some(
        (other) => other !== l && other.marketplaceListingId === external
      ),
      'Marketplace listing already assigned'
    );
    l.marketplaceListingId = external;
    l.status = op.verb === 'publish' ? 'active' : 'ended';
    // A buyer may have paid between a successful remote publish and the
    // recovery of its receipt. The exact remote listing ID identifies that order.
    if (op.verb === 'publish') {
      l.publishRequestedAt = op.createdAt;
      l.publishedAt = now;
    } else l.endedAt = now;
  }
  op.status = outcome;
  op.evidenceRef = evidenceRef;
  op.resolvedAt = now;
  l.pending = null;
  resolve(s, d.owner, 'operation:' + op.id, 'reconcile-marketplace', now);
  return { ...op };
}
// A pending intent is durable before handing bytes to any connector. A timeout
// or crash leaves that same intent available for recipient readback.
export async function submitOperation(store, owner, x, connector) {
  fields(x, ['operationId', 'listingId', 'verb']);
  id(x.operationId, 'operation ID');
  id(x.listingId, 'listing ID');
  choice(x.verb, ['publish', 'end'], 'operation');
  check(typeof connector?.send === 'function', 'Supply a recipient connector');
  const duration = number(
    connector.timeoutMs ?? 15000,
    'connector time limit',
    1,
    15 * 60 * 1000
  );
  const start = store.change((s, now) => {
    const d = deskOf(s, owner),
      prior = d.operations.find((o) => o.id === x.operationId);
    if (connector.platform)
      check(
        s.records[d.account].platform === connector.platform,
        'Wrong marketplace transport for the registered account'
      );
    if (prior) {
      check(
        prior.listingId === x.listingId && prior.verb === x.verb,
        'Conflicting operation ID'
      );
      return { prior };
    }
    const l = get(d.listings, x.listingId, 'listing'),
      { payload, request } = proposal(d, l, x.verb, x.operationId, now);
    const approved = s.approvals.some(
      (a) =>
        a.owner === owner &&
        !a.used &&
        now < a.expiresAt &&
        (a.revision ?? 0) === (s.records[d.account].accessRevision ?? 0) &&
        isDeepStrictEqual(a.request, request)
    );
    if (!approved)
      return {
        prior: { status: 'denied', reason: 'Exact owner approval required' }
      };
    const decision = authorize(s, now, owner, request);
    if (decision.decision !== 'allow')
      return { prior: { status: 'denied', reason: decision.reason } };
    const op = {
      id: x.operationId,
      listingId: l.id,
      verb: x.verb,
      payload,
      digest: request.digest,
      account: d.account,
      accessRevision: s.records[d.account].accessRevision ?? 0,
      status: 'pending',
      createdAt: now,
      sendDeadline: now + duration
    };
    d.operations.push(op);
    l.pending = op.id;
    queue(s, owner, 'operation:' + op.id, 'reconcile-marketplace', now, now);
    return { op };
  });
  if (start.prior) return start.prior;
  try {
    const answer = await bounded(connector, 'send', start.op);
    return store.change((s, now) => {
      const d = deskOf(s, owner);
      return finalize(
        s,
        d,
        get(d.operations, start.op.id, 'operation'),
        answer,
        now
      );
    });
  } catch {
    // Connector exceptions and malformed receipts may contain customer details.
    return get(
      deskOf(store.read(), owner).operations,
      start.op.id,
      'operation'
    );
  }
}
export async function reconcileOperation(store, owner, operationId, connector) {
  const state = store.read(),
    desk = deskOf(state, owner);
  if (connector?.platform)
    check(
      state.records[desk.account].platform === connector.platform,
      'Wrong marketplace transport for the registered account'
    );
  const op = get(desk.operations, operationId, 'operation');
  if (op.status !== 'pending') return op;
  check(typeof connector?.lookup === 'function', 'Supply recipient readback');
  const started = store.clock();
  let answer;
  try {
    answer = await bounded(connector, 'lookup', op);
  } catch {
    return op;
  }
  return store.change((s, now) => {
    const d = deskOf(s, owner),
      current = get(d.operations, op.id, 'operation');
    // A second process may read the recipient before the first one's send arrives.
    // Keep the original reservation until the send window and a later readback.
    if (answer?.outcome === 'absent' && started < (current.sendDeadline ?? 0))
      return current;
    return finalize(s, d, current, answer, now);
  });
}

async function bounded(connector, method, op) {
  const duration = number(
    connector.timeoutMs ?? 15000,
    'connector time limit',
    1,
    15 * 60 * 1000
  );
  const controller = new AbortController();
  let timer;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(Error('Recipient deadline reached'));
      }, duration);
    });
    const send = Promise.resolve().then(() =>
      connector[method](structuredClone(op.payload), {
        idempotencyKey: op.id,
        account: op.account,
        accessRevision: op.accessRevision,
        signal: controller.signal
      })
    );
    return await Promise.race([send, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
