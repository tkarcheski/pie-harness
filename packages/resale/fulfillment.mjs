import { isDeepStrictEqual } from 'node:util';
import {
  check,
  choice,
  date,
  fields,
  get,
  id,
  moneyCode,
  number,
  queue,
  ref,
  resolve
} from './records.mjs';

export function fulfillment(s, d, command, x, now) {
  if (command === 'order') {
    fields(x, [
      'eventId',
      'id',
      'orderedAt',
      'shipBy',
      'evidenceRef',
      'currency',
      'lines'
    ]);
    const orderId = id(x.id, 'marketplace order ID'),
      orderedAt = date(x.orderedAt, now),
      shipBy = date(x.shipBy);
    check(shipBy >= orderedAt, 'Ship-by precedes order time');
    check(
      Array.isArray(x.lines) && x.lines.length > 0 && x.lines.length <= 100,
      'Supply 1 to 100 order lines'
    );
    const currency = moneyCode(x.currency),
      seen = new Set(),
      sold = new Map();
    for (const order of d.orders)
      if (order.id !== orderId)
        for (const row of order.lines)
          sold.set(
            row.listingId,
            (sold.get(row.listingId) ?? 0) + row.quantity
          );
    const lines = x.lines
      .map((raw) => {
        fields(raw, [
          'lineId',
          'marketplaceListingId',
          'quantity',
          'grossMinor'
        ]);
        const lineId = id(raw.lineId, 'line ID'),
          marketplaceListingId = id(
            raw.marketplaceListingId,
            'marketplace listing ID'
          );
        check(!seen.has(lineId), 'Duplicate order line');
        seen.add(lineId);
        const listing = d.listings.find(
          (l) => l.marketplaceListingId === marketplaceListingId
        );
        check(
          listing &&
            listing.currency === currency &&
            (listing.publishRequestedAt ?? listing.publishedAt) <= orderedAt &&
            (listing.endedAt == null || orderedAt <= listing.endedAt),
          'Order must match a listing active at purchase in the same currency'
        );
        const quantity = number(raw.quantity, 'order quantity', 1, 100000),
          total = (sold.get(listing.id) ?? 0) + quantity;
        check(total <= listing.quantity, 'Order exceeds physical inventory');
        sold.set(listing.id, total);
        return {
          lineId,
          listingId: listing.id,
          marketplaceListingId,
          quantity,
          grossMinor: number(raw.grossMinor, 'line gross', 1)
        };
      })
      .sort((a, b) => a.lineId.localeCompare(b.lineId));
    const record = {
      id: orderId,
      currency,
      orderedAt,
      shipBy,
      lines,
      evidenceRef: ref(x.evidenceRef)
    };
    const prior = d.orders.find((o) => o.id === orderId);
    if (prior) {
      // Marketplaces can deliver the same paid order under multiple notification IDs.
      for (const k of ['currency', 'orderedAt', 'shipBy', 'lines'])
        check(
          isDeepStrictEqual(prior[k], record[k]),
          'Conflicting paid-order update; verify the marketplace record'
        );
      return prior;
    }
    const order = {
      ...record,
      classification: 'liquidity',
      status: 'awaiting-shipment',
      exceptions: []
    };
    d.orders.push(order);
    queue(s, d.owner, 'order:' + orderId, 'ship-order', shipBy, now);
    return order;
  }
  const order = get(d.orders, x.orderId, 'order'),
    subject = 'order:' + order.id;
  if (command === 'ack-late') {
    fields(x, ['eventId', 'orderId', 'resolutionRef']);
    check(order.late, 'No late shipment to review');
    const resolutionRef = ref(x.resolutionRef);
    check(
      !order.lateReviewRef || order.lateReviewRef === resolutionRef,
      'Late shipment already reviewed'
    );
    order.lateReviewRef = resolutionRef;
    resolve(s, d.owner, subject, 'review-late-shipment', now);
    return order;
  }
  if (command === 'ship') {
    fields(x, ['eventId', 'orderId', 'trackingRef', 'shippedAt']);
    const trackingRef = ref(x.trackingRef),
      shippedAt = date(x.shippedAt, now);
    check(shippedAt >= order.orderedAt, 'Shipment precedes paid order');
    if (order.status === 'shipped') {
      check(
        trackingRef === order.trackingRef && shippedAt === order.shippedAt,
        'Conflicting shipment record'
      );
      return order;
    }
    Object.assign(order, {
      status: 'shipped',
      trackingRef,
      shippedAt,
      late: shippedAt > order.shipBy
    });
    resolve(s, d.owner, subject, 'ship-order', now);
    if (order.late)
      queue(s, d.owner, subject, 'review-late-shipment', now, now);
    return order;
  }
  if (command === 'exception') {
    fields(x, [
      'eventId',
      'orderId',
      'caseId',
      'reason',
      'evidenceRef',
      'dueAt'
    ]);
    const caseId = id(x.caseId, 'support case ID');
    check(
      !order.exceptions.some((c) => c.id === caseId),
      'Support case ID already recorded'
    );
    const ticket = {
      id: caseId,
      reason: choice(
        x.reason,
        ['late-shipment', 'carrier-delay', 'damage', 'return', 'buyer-inquiry'],
        'support reason'
      ),
      evidenceRef: ref(x.evidenceRef),
      dueAt: date(x.dueAt),
      openedAt: now,
      status: 'needs-owner'
    };
    order.exceptions.push(ticket);
    queue(
      s,
      d.owner,
      subject + ':' + caseId,
      'resolve-support-case',
      ticket.dueAt,
      now
    );
    return ticket;
  }
  if (command === 'close-exception') {
    fields(x, ['eventId', 'orderId', 'caseId', 'resolutionRef']);
    const ticket = get(order.exceptions, x.caseId, 'support case'),
      resolutionRef = ref(x.resolutionRef);
    if (ticket.status === 'closed')
      check(ticket.resolutionRef === resolutionRef, 'Conflicting resolution');
    else
      Object.assign(ticket, { status: 'closed', closedAt: now, resolutionRef });
    resolve(s, d.owner, subject + ':' + ticket.id, 'resolve-support-case', now);
    return ticket;
  }
  throw Error('Unknown fulfillment command');
}
