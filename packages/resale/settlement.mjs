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
  resolve,
  unique
} from './records.mjs';

function sum(entries, select) {
  let total = 0;
  for (const entry of entries) {
    total += select(entry);
    check(Number.isSafeInteger(total), 'Settlement exceeds safe integer range');
  }
  return total;
}
export function payoutView(d, payout) {
  const lines = d.lines.filter((l) => l.payoutId === payout.id);
  const deposits = d.bank.filter((b) => b.payoutId === payout.id);
  const total = (kind) =>
    sum(
      lines.filter((l) => l.kind === kind),
      (l) => l.amountMinor
    );
  const grossMinor = total('sale'),
    feeMinor = total('fee'),
    refundMinor = total('refund');
  const settlementMinor = sum(lines, (l) =>
    l.kind === 'sale' ? l.amountMinor : -l.amountMinor
  );
  const bankMinor = sum(deposits, (b) => b.amountMinor);
  const discrepancyMinor = payout.netMinor - settlementMinor,
    bankDifferenceMinor = bankMinor - payout.netMinor;
  check(
    Number.isSafeInteger(discrepancyMinor) &&
      Number.isSafeInteger(bankDifferenceMinor),
    'Settlement differences exceed safe integer range'
  );
  const gaps = [];
  if (!lines.length) gaps.push('missing-settlement-lines');
  if (discrepancyMinor !== 0) gaps.push('settlement-differs-from-payout');
  if (!deposits.length) gaps.push('awaiting-bank-observation');
  else if (bankDifferenceMinor !== 0) gaps.push('bank-differs-from-payout');
  return {
    id: payout.id,
    currency: payout.currency,
    classification: 'liquidity',
    reportedPayoutMinor: payout.netMinor,
    grossMinor,
    feeMinor,
    refundMinor,
    settlementMinor,
    observedBankMinor: deposits.length ? bankMinor : null,
    settlementDifferenceMinor: discrepancyMinor,
    bankDifferenceMinor: deposits.length ? bankDifferenceMinor : null,
    status: gaps.length ? 'unreconciled' : 'matched',
    gaps,
    settlementLineIds: lines.map((l) => l.id),
    observationIds: deposits.map((b) => b.id)
  };
}
export function orderBalance(d, order) {
  const entries = d.lines.filter((l) => l.orderId === order.id);
  const grossMinor = sum(order.lines, (l) => l.grossMinor);
  const bookedGrossMinor = sum(
    entries.filter((l) => l.kind === 'sale'),
    (l) => l.amountMinor
  );
  return {
    orderId: order.id,
    currency: order.currency,
    grossMinor,
    bookedGrossMinor,
    unbookedGrossMinor: grossMinor - bookedGrossMinor,
    feeMinor: sum(
      entries.filter((l) => l.kind === 'fee'),
      (l) => l.amountMinor
    ),
    refundMinor: sum(
      entries.filter((l) => l.kind === 'refund'),
      (l) => l.amountMinor
    )
  };
}
export function settlement(s, d, command, x, now) {
  if (command === 'payout') {
    fields(x, [
      'eventId',
      'id',
      'currency',
      'netMinor',
      'observedAt',
      'evidenceRef'
    ]);
    const payout = unique(d.payouts, {
      id: id(x.id, 'payout ID'),
      currency: moneyCode(x.currency),
      netMinor: number(x.netMinor, 'reported net payout', -1000000000000),
      observedAt: date(x.observedAt, now),
      evidenceRef: ref(x.evidenceRef)
    });
    if (payoutView(d, payout).status !== 'matched')
      queue(s, d.owner, 'payout:' + payout.id, 'review-payout', now, now);
    return payout;
  }
  const payout = get(d.payouts, x.payoutId, 'payout');
  check(moneyCode(x.currency) === payout.currency, 'Payout currency mismatch');
  if (command === 'settlement-line') {
    fields(x, [
      'eventId',
      'id',
      'payoutId',
      'orderId',
      'kind',
      'amountMinor',
      'currency',
      'observedAt',
      'evidenceRef'
    ]);
    const order = get(d.orders, x.orderId, 'order');
    check(order.currency === payout.currency, 'Order currency mismatch');
    const observedAt = date(x.observedAt, now);
    check(observedAt >= order.orderedAt, 'Settlement precedes its order');
    unique(d.lines, {
      id: id(x.id, 'marketplace transaction line ID'),
      orderId: order.id,
      payoutId: payout.id,
      kind: choice(x.kind, ['sale', 'fee', 'refund'], 'settlement type'),
      amountMinor: number(x.amountMinor, 'settlement amount', 1),
      currency: order.currency,
      observedAt,
      evidenceRef: ref(x.evidenceRef)
    });
    const balance = orderBalance(d, order);
    check(
      balance.unbookedGrossMinor >= 0,
      'Recorded proceeds exceed the order gross'
    );
    check(
      balance.refundMinor <= balance.grossMinor,
      'Cumulative refunds exceed the order gross'
    );
  } else if (command === 'bank-observation') {
    fields(x, [
      'eventId',
      'id',
      'payoutId',
      'amountMinor',
      'currency',
      'observedAt',
      'evidenceRef',
      'matchRef'
    ]);
    unique(d.bank, {
      id: id(x.id, 'bank transaction ID'),
      payoutId: payout.id,
      currency: payout.currency,
      amountMinor: number(x.amountMinor, 'observed deposit', -1000000000000),
      observedAt: date(x.observedAt, now),
      evidenceRef: ref(x.evidenceRef),
      matchRef: ref(x.matchRef)
    });
  } else throw Error('Unknown settlement command');
  const report = payoutView(d, payout),
    subject = 'payout:' + payout.id;
  if (report.status === 'matched')
    resolve(s, d.owner, subject, 'review-payout', now);
  else queue(s, d.owner, subject, 'review-payout', now, now);
  return report;
}
