/**
 * Fawaterak — online payment, alongside cash on delivery.
 *
 * Everything here is OFF unless the owner turns `payments.fawaterak_enabled`
 * on in Settings → الدفع الإلكتروني and pastes in the two credentials from his
 * own Fawaterak dashboard (Integration section): an API key, used as the
 * Bearer token on every call this file makes, and a vendor key, used only to
 * verify that a webhook really came from Fawaterak. Neither key is ever sent
 * anywhere but Fawaterak itself, never logged, and never included in the
 * storefront's public config — see `StorefrontService#config`, which exposes
 * the enabled flag and nothing else.
 *
 * Two things this file does, matching the two directions money moves:
 *
 *  - `createInvoice()` — called once, right after `WebOrderService#place`
 *    commits an online order and reserves its stock, from OUTSIDE that
 *    transaction (an HTTP call has no business holding a database lock).
 *    Builds a hosted-checkout link on Fawaterak's side and hands back its URL,
 *    which the storefront redirects the customer to. Fawaterak decides which
 *    payment methods to show there — cards, Fawry, wallets, whatever the
 *    owner has enabled on his own account — none of that is this file's
 *    concern.
 *
 *  - `verifyWebhookSignature()` — called from the public webhook route (see
 *    `api/routes/shopOrders.js`) the moment Fawaterak tells us an invoice's
 *    status changed. HMAC-SHA256 over the fields THEY specify, keyed by the
 *    vendor key, compared to the `hashKey` they sent — this is the one thing
 *    standing between "our own database says this order is paid" and
 *    "anybody on the internet who can guess an order number says so". A
 *    webhook that fails this check is never acted on.
 *
 * API reference: https://fawaterak-api.readme.io/reference (V2). Two base
 * URLs — `https://app.fawaterk.com/api/v2` (live) and
 * `https://staging.fawaterk.com/api/v2` (staging, for the owner to try before
 * he risks a real customer's money) — chosen by `payments.fawaterak_mode`.
 */
import crypto from 'node:crypto';
import repositories from '../infrastructure/repositories/index.js';
import { BusinessRuleError, ServiceUnavailableError } from '../shared/errors.js';

const BASE_URLS = {
  live: 'https://app.fawaterk.com/api/v2',
  staging: 'https://staging.fawaterk.com/api/v2',
};

/** [name, price, quantity] rows Fawaterak itemises on its own hosted page. */
function cartItemsFor(lines, taxAmount) {
  const items = lines.map((line) => ({
    name: line.description.slice(0, 200),
    price: round2(line.unit_price),
    quantity: line.quantity,
  }));
  // Folded in as its own line rather than a `taxData` percentage: tax here can
  // differ per line (see `calculateLine`), and there is no single rate this
  // invoice could honestly quote. This keeps cartItems + shipping reconciling
  // exactly to cartTotal without pretending to a rate that does not exist.
  if (taxAmount > 0) items.push({ name: 'Tax', price: round2(taxAmount), quantity: 1 });
  return items;
}

function round2(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

/** "Kerolos Nashat" -> { first_name: 'Kerolos', last_name: 'Nashat' } — Fawaterak wants both. */
function splitName(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  return {
    first_name: (parts[0] || 'Customer').slice(0, 60),
    last_name: (parts.slice(1).join(' ') || '-').slice(0, 60),
  };
}

export class FawaterakService {
  constructor(deps = {}) {
    this.settings = deps.settings || repositories.settings;
    this.fetchImpl = deps.fetch || fetch;
  }

  async #config() {
    const [enabled, apiKey, vendorKey, mode] = await Promise.all([
      this.settings.get('payments.fawaterak_enabled', false),
      this.settings.get('payments.fawaterak_api_key', ''),
      this.settings.get('payments.fawaterak_vendor_key', ''),
      this.settings.get('payments.fawaterak_mode', 'live'),
    ]);
    return {
      enabled: Boolean(enabled),
      apiKey: String(apiKey || '').trim(),
      vendorKey: String(vendorKey || '').trim(),
      baseUrl: BASE_URLS[mode] || BASE_URLS.live,
    };
  }

  /** Whether the owner has switched this on AND actually filled in a key. */
  async isAvailable() {
    const { enabled, apiKey } = await this.#config();
    return enabled && apiKey.length > 0;
  }

  /**
   * Create a hosted invoice for one web order and return its payment URL.
   *
   * `order` is the freshly-placed web order (already committed, stock already
   * reserved) — `order_no`, `total_amount`, `subtotal`, `tax_amount`,
   * `delivery_fee`, `customer_name`, `customer_email`, `customer_phone`,
   * `lines` (each `{ description, unit_price, quantity }`), `language`, and
   * `returnUrl` (the storefront page Fawaterak sends the customer back to,
   * whatever the outcome — see checkout.js for why one URL covers all three).
   */
  async createInvoice(order) {
    const { enabled, apiKey, baseUrl } = await this.#config();
    if (!enabled || !apiKey) {
      throw new BusinessRuleError(
        'Online payment is not set up for this shop yet. Please choose cash on delivery instead.',
      );
    }

    const { first_name, last_name } = splitName(order.customer_name);
    const body = {
      customer: {
        first_name,
        last_name,
        customer_unique_id: `web-${order.order_no}`,
        email: order.customer_email || undefined,
        phone: order.customer_phone ? Number(String(order.customer_phone).replace(/\D/g, '')) || undefined : undefined,
      },
      cartItems: cartItemsFor(order.lines, Number(order.tax_amount || 0)),
      shipping: round2(order.delivery_fee),
      cartTotal: round2(order.total_amount),
      currency: 'EGP',
      payLoad: { order_no: order.order_no },
      redirectionUrls: {
        successUrl: order.returnUrl,
        failUrl: `${order.returnUrl}${order.returnUrl.includes('?') ? '&' : '?'}payment=failed`,
        pendingUrl: `${order.returnUrl}${order.returnUrl.includes('?') ? '&' : '?'}payment=pending`,
        webhookUrl: order.webhookUrl,
      },
    };

    let response;
    try {
      response = await this.fetchImpl(`${baseUrl}/createInvoiceLink`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (error) {
      // No network, Fawaterak unreachable. Nothing is wrong with the order
      // itself — the shop should tell the customer to try again shortly,
      // exactly the way `platform/turso.js` treats the same class of failure.
      throw new ServiceUnavailableError(
        `Could not reach the online payment provider (${error.message}). Please try again in a moment.`,
        { retryAfter: 10, code: 'PAYMENT_GATEWAY_UNREACHABLE' },
      );
    }

    let payload = null;
    try {
      payload = await response.json();
    } catch { /* handled by the !response.ok / missing-data checks below */ }

    if (!response.ok || payload?.status !== 'success' || !payload?.data?.url) {
      const reason = payload?.message || payload?.data?.message || `HTTP ${response.status}`;
      throw new BusinessRuleError(
        `The payment provider refused this order (${reason}). Please try again, or choose cash on delivery.`,
        { code: 'PAYMENT_GATEWAY_REFUSED' },
      );
    }

    return {
      url: payload.data.url,
      invoiceId: String(payload.data.invoiceId),
      invoiceKey: String(payload.data.invoiceKey),
    };
  }

  /**
   * Verify a webhook really came from Fawaterak.
   *
   * Their spec: HMAC-SHA256 of `InvoiceId={id}&InvoiceKey={key}&PaymentMethod=
   * {method}`, keyed by the vendor key, must equal the `hashKey` field they
   * sent. `crypto.timingSafeEqual` rather than `===`: a plain string compare
   * leaks how many leading bytes matched through response timing, which is
   * exactly the kind of oracle `tests/pentest.test.js` exists to catch
   * elsewhere in this codebase — there is no reason this webhook should be
   * the one place that shortcut is taken.
   */
  async verifyWebhookSignature({ invoiceId, invoiceKey, paymentMethod, hashKey }) {
    const { vendorKey } = await this.#config();
    if (!vendorKey) return false;
    if (!invoiceId || !invoiceKey || !hashKey) return false;

    const data = `InvoiceId=${invoiceId}&InvoiceKey=${invoiceKey}&PaymentMethod=${paymentMethod || ''}`;
    const expected = crypto.createHmac('sha256', vendorKey).update(data).digest('hex');
    return safeEqualHex(expected, String(hashKey));
  }
}

function safeEqualHex(a, b) {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  try {
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

export const fawaterakService = new FawaterakService();
export default fawaterakService;
