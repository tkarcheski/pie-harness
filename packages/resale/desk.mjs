import {
  check,
  deskOf,
  digest,
  fields,
  get,
  id,
  ownerQueue
} from './records.mjs';
import { intakeCommand, listingView, previewOperation } from './listings.mjs';
import { fulfillment } from './fulfillment.mjs';
import { readEbayOrder } from './ebay.mjs';
import { orderBalance, payoutView, settlement } from './settlement.mjs';

export { initialize, bindResaleDesk } from './records.mjs';
export {
  approveOperation,
  reconcileOperation,
  submitOperation
} from './listings.mjs';

const handlers = new Map([
  ...['intake', 'review', 'draft'].map((k) => [k, intakeCommand]),
  ...['order', 'ship', 'exception', 'close-exception', 'ack-late'].map((k) => [
    k,
    fulfillment
  ]),
  ...['payout', 'settlement-line', 'bank-observation'].map((k) => [
    k,
    settlement
  ])
]);
function inventoryView(d, item) {
  const ids = new Set(
    d.listings.filter((l) => l.itemId === item.id).map((l) => l.id)
  );
  let awaitingShipment = 0,
    shipped = 0;
  for (const order of d.orders)
    for (const line of order.lines) {
      if (!ids.has(line.listingId)) continue;
      if (order.status === 'shipped') shipped += line.quantity;
      else awaitingShipment += line.quantity;
    }
  const { id, title, quantity, ownership, condition, reviewedAt } = item;
  return {
    id,
    title,
    received: quantity,
    onHand: quantity - shipped,
    awaitingShipment,
    shipped,
    available: quantity - shipped - awaitingShipment,
    ownership,
    condition,
    reviewedAt
  };
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical(value[k])])
    );
  return value;
}
export function resaleCommand(store, owner, command, input = {}) {
  if (command === 'order-from-ebay') {
    fields(input, ['eventId', 'evidenceRef', 'order']);
    return resaleCommand(
      store,
      owner,
      'order',
      readEbayOrder(input.order, {
        eventId: input.eventId,
        evidenceRef: input.evidenceRef
      })
    );
  }
  const handler = handlers.get(command);
  if (handler) {
    return store.change((s, now) => {
      const d = deskOf(s, owner),
        eventId = id(input.eventId, 'event ID'),
        hash = digest([command, canonical(input)]);
      const prior = d.events.find((e) => e.id === eventId);
      if (prior) {
        check(prior.digest === hash, 'Conflicting event ID');
        return prior.result;
      }
      const result = handler(s, d, command, input, now);
      // Keep the original response stable when the item is later reviewed, shipped or settled.
      d.events.push({
        id: eventId,
        command,
        digest: hash,
        at: now,
        result: structuredClone(result)
      });
      return result;
    });
  }
  const state = store.read(),
    d = deskOf(state, owner),
    now = store.clock();
  switch (command) {
    case 'preview-write':
      return previewOperation(d, input, now);
    case 'listing':
      fields(input, ['listingId']);
      return listingView(d, get(d.listings, input.listingId, 'listing'), now);
    case 'payout-report':
      fields(input, ['payoutId']);
      return payoutView(d, get(d.payouts, input.payoutId, 'payout'));
    case 'order-report': {
      fields(input, ['orderId']);
      const order = get(d.orders, input.orderId, 'order');
      return { ...order, settlement: orderBalance(d, order) };
    }
    case 'queue':
      fields(input, []);
      return ownerQueue(state, owner, now);
    case 'status':
      fields(input, []);
      return {
        owner,
        classification: 'liquidity',
        items: d.items.map((i) => inventoryView(d, i)),
        listings: d.listings.map((l) => ({
          id: l.id,
          status: l.status,
          pending: l.pending,
          marketplaceListingId: l.marketplaceListingId
        })),
        orders: d.orders.map((o) => ({
          id: o.id,
          shipBy: o.shipBy,
          status: o.status,
          ...orderBalance(d, o)
        })),
        payouts: d.payouts.map((p) => payoutView(d, p)),
        ownerQueue: ownerQueue(state, owner, now)
      };
    default:
      throw Error('Unknown resale command');
  }
}
