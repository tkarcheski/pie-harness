import { check, digest, id } from './records.mjs';

// Independent storage represents the remote system. A test can interrupt the
// caller after this database commits and reconcile against it after restart.
export class FixtureMarketplace {
  constructor(store, { loseReply = false } = {}) {
    this.store = store;
    this.loseReply = loseReply;
    this.platform = 'ebay-simulation';
  }
  async send(payload, { idempotencyKey, account }) {
    id(idempotencyKey);
    id(account);
    const receipt = this.store.change((s) => {
      const effects = (s.testMarketplace ??= []);
      const prior = effects.find(
        (o) => o.id === idempotencyKey && o.account === account
      );
      if (prior) {
        check(
          prior.payload === JSON.stringify(payload),
          'Fixture idempotency mismatch'
        );
        return prior.receipt;
      }
      const external =
        payload.marketplaceListingId ??
        'fixture-' +
          (payload.listingId.length <= 80
            ? payload.listingId
            : digest(payload.listingId));
      const row = {
        outcome: 'applied',
        evidenceRef: 'vault:receipt-' + digest([account, idempotencyKey]),
        marketplaceListingId: external
      };
      effects.push({
        id: idempotencyKey,
        account,
        payload: JSON.stringify(payload),
        receipt: row
      });
      return row;
    });
    if (this.loseReply) throw Error('Simulated loss after recipient commit');
    return receipt;
  }
  async lookup(_payload, { idempotencyKey, account }) {
    const row = (this.store.read().testMarketplace ?? []).find(
      (r) => r.id === idempotencyKey && r.account === account
    );
    return (
      row?.receipt ?? {
        outcome: 'absent',
        evidenceRef: 'vault:absent-' + digest([account, idempotencyKey])
      }
    );
  }
}
