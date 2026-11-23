import { check, digest, id, number, ref } from './records.mjs';
import { canUseAccount } from '../local/connections.mjs';
import { record } from '../local/store.mjs';

const root = 'https://api.sandbox.ebay.com/sell/inventory/v1';
const conditionMap = {
  NEW: 'new',
  LIKE_NEW: 'like-new',
  USED_EXCELLENT: 'like-new',
  USED_VERY_GOOD: 'good',
  USED_GOOD: 'good',
  USED_ACCEPTABLE: 'fair',
  FOR_PARTS_OR_NOT_WORKING: 'parts'
};
function amount(price) {
  check(
    ['USD', 'GBP', 'EUR', 'CAD', 'AUD'].includes(price?.currency) &&
      typeof price.value === 'string' &&
      /^(0|[1-9][0-9]{0,9})(\.[0-9]{1,2})?$/.test(price.value),
    'Unsupported eBay currency or price'
  );
  const [whole, decimal = ''] = price.value.split('.');
  return number(
    Number(whole) * 100 + Number(decimal.padEnd(2, '0')),
    'eBay minor amount'
  );
}
function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sorted(value[k])])
    );
  return value;
}
export class EbaySandboxOffers {
  constructor({
    store,
    owner,
    account,
    resolveAccessToken,
    fetchImpl = fetch
  }) {
    this.platform = 'ebay-sandbox';
    this.account = id(account, 'seller account ID');
    this.owner = owner;
    this.store = store;
    check(
      record(store.read(), account, 'account', owner).platform ===
        this.platform,
      'Choose a registered eBay sandbox connection'
    );
    check(
      typeof resolveAccessToken === 'function',
      'Supply a sandbox user-token resolver'
    );
    this.resolveAccessToken = resolveAccessToken;
    this.fetch = fetchImpl;
  }
  access(scope) {
    const state = this.store.read(),
      account = record(state, this.account, 'account', this.owner);
    check(
      !state.pauses.some((k) => ['*', this.owner, this.account].includes(k)) &&
        canUseAccount(state, account, scope, this.store.clock()),
      'Sandbox connection unavailable'
    );
    return account;
  }
  async request(
    suffix,
    method,
    signal,
    scope = 'ebay.read',
    revision = this.access(scope).accessRevision ?? 0
  ) {
    try {
      const account = this.access(scope);
      check(
        (account.accessRevision ?? 0) === revision,
        'Sandbox grant changed'
      );
      const token = await this.resolveAccessToken(account.secretRef, signal);
      check(typeof token === 'string' && token, 'Missing sandbox access');
      const current = this.access(scope);
      check(
        current.secretRef === account.secretRef &&
          (current.accessRevision ?? 0) === revision &&
          !signal.aborted,
        'Sandbox grant changed'
      );
      const response = await this.fetch(root + suffix, {
        method,
        redirect: 'error',
        signal,
        headers: {
          Accept: 'application/json',
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json'
        }
      });
      if (response.ok) {
        const body = await response.json();
        const final = this.access(scope);
        check(
          final.secretRef === account.secretRef &&
            (final.accessRevision ?? 0) === revision &&
            !signal.aborted,
          'Sandbox grant changed'
        );
        return body;
      }
      await response.body?.cancel();
      throw Error('Sandbox request failed');
    } catch {
      throw Error('eBay sandbox request did not produce a usable receipt');
    }
  }
  async inspect(offerId, signal = AbortSignal.timeout(15000)) {
    id(offerId, 'eBay offer ID');
    const revision = this.access('ebay.read').accessRevision ?? 0;
    const offer = await this.request(
      '/offer/' + offerId,
      'GET',
      signal,
      'ebay.read',
      revision
    );
    check(
      offer.offerId === offerId &&
        typeof offer.sku === 'string' &&
        offer.sku.length > 0 &&
        offer.sku.length <= 50,
      'Offer identity mismatch'
    );
    const inventory = await this.request(
      '/inventory_item/' + encodeURIComponent(offer.sku),
      'GET',
      signal,
      'ebay.read',
      revision
    );
    check(
      inventory.sku === offer.sku &&
        !inventory.groupIds?.length &&
        !inventory.inventoryItemGroupKeys?.length &&
        offer.format === 'FIXED_PRICE',
      'Supply an existing single-SKU fixed-price offer'
    );
    const { status, listing, ...terms } = offer;
    // Bind every seller-controlled offer and inventory field displayed for review.
    // Only marketplace lifecycle fields change when publishing or withdrawing.
    const snapshotDigest = digest(sorted([terms, inventory]));
    return {
      offerId,
      digest: snapshotDigest,
      status,
      listingId: listing?.listingId ?? null,
      title: inventory.product?.title,
      sku: offer.sku,
      condition: conditionMap[inventory.condition] ?? null,
      quantity: offer.availableQuantity,
      currency: offer.pricingSummary?.price?.currency,
      priceMinor: amount(offer.pricingSummary?.price),
      terms,
      inventory
    };
  }
  async send(
    payload,
    { account, accessRevision, signal = AbortSignal.timeout(15000) }
  ) {
    check(account === this.account, 'Seller account mismatch');
    const scope = 'ebay.' + payload.verb,
      revision = this.access(scope).accessRevision ?? 0;
    check(
      revision === accessRevision,
      'Seller authority changed after approval'
    );
    const offer = payload.ebayOffer;
    check(offer, 'Supply a reviewed eBay sandbox offer');
    const current = await this.inspect(offer.offerId, signal);
    if (payload.verb === 'publish') {
      check(
        current.status === 'UNPUBLISHED' &&
          current.digest === offer.digest &&
          current.title === payload.title &&
          current.condition === payload.condition &&
          current.quantity === payload.quantity &&
          current.currency === payload.currency &&
          current.priceMinor === payload.unitPriceMinor,
        'Sandbox offer changed; review it again'
      );
    } else
      check(
        payload.verb === 'end' &&
          current.status === 'PUBLISHED' &&
          current.listingId === payload.marketplaceListingId,
        'Current marketplace listing differs'
      );
    const action = payload.verb === 'publish' ? 'publish' : 'withdraw';
    const receipt = await this.request(
      '/offer/' + offer.offerId + '/' + action,
      'POST',
      signal,
      scope,
      revision
    );
    const external = id(receipt.listingId, 'eBay listing ID');
    return {
      outcome: 'applied',
      marketplaceListingId: external,
      evidenceRef: 'vault:ebay-' + digest([offer.offerId, action, external])
    };
  }
  async lookup(payload, { account, signal = AbortSignal.timeout(15000) }) {
    check(account === this.account, 'Seller account mismatch');
    const current = await this.inspect(payload.ebayOffer.offerId, signal);
    const published =
      payload.verb === 'publish' &&
      current.status === 'PUBLISHED' &&
      current.digest === payload.ebayOffer.digest &&
      current.listingId;
    const ended =
      payload.verb === 'end' &&
      current.status === 'UNPUBLISHED' &&
      (!current.listingId ||
        current.listingId === payload.marketplaceListingId);
    if (!published && !ended) return { outcome: 'unknown' };
    const external = id(
      published ? current.listingId : payload.marketplaceListingId
    );
    return {
      outcome: 'applied',
      marketplaceListingId: external,
      evidenceRef:
        'vault:ebay-' + digest([current.offerId, current.status, external])
    };
  }
}

// Map a supported paid order snapshot before persistence. Skip names, email,
// addresses, notes and other unnecessary fields in the marketplace response.
export function readEbayOrder(raw, { eventId, evidenceRef }) {
  id(eventId);
  ref(evidenceRef);
  check(
    raw?.orderPaymentStatus === 'PAID' &&
      (!raw.cancelStatus || raw.cancelStatus.cancelState === 'NONE_REQUESTED'),
    'Import an active paid order'
  );
  check(
    Array.isArray(raw.lineItems) && raw.lineItems.length,
    'Missing order lines'
  );
  const currency = raw.lineItems[0].lineItemCost?.currency;
  let earliest = Infinity;
  const lines = raw.lineItems.map((line) => {
    check(
      !line.appliedPromotions?.length &&
        !line.refunds?.length &&
        !line.taxes?.length &&
        !line.ebayCollectAndRemitTaxes?.length &&
        line.ebayCollectedCharges == null &&
        line.discountedLineItemCost == null,
      'Use a reviewed normalized order for discounts, refunds, taxes or marketplace charges'
    );
    const quantity = number(line.quantity, 'quantity', 1, 100000);
    const item = line.lineItemCost,
      shipping = line.deliveryCost?.shippingCost,
      handling = line.deliveryCost?.handlingCost;
    const components = [item, shipping, handling].filter(Boolean);
    check(
      components.every((v) => v.currency === currency) &&
        line.total?.currency === currency,
      'Mixed order currencies'
    );
    const grossMinor = components.reduce((sum, c) => sum + amount(c), 0);
    check(
      grossMinor === amount(line.total),
      'Unexplained eBay line total; review the source statement'
    );
    const deadline = Date.parse(
      line.lineItemFulfillmentInstructions?.shipByDate
    );
    check(Number.isFinite(deadline), 'Missing ship-by');
    earliest = Math.min(earliest, deadline);
    return {
      lineId: id(line.lineItemId),
      marketplaceListingId: id(line.legacyItemId),
      quantity,
      grossMinor
    };
  });
  return {
    eventId,
    id: id(raw.orderId),
    orderedAt: raw.creationDate,
    shipBy: new Date(earliest).toISOString(),
    currency,
    evidenceRef,
    lines
  };
}
