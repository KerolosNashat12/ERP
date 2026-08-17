/**
 * QR / barcode label generation.
 *
 * Codes are rendered server-side as SVG data URIs so label sheets print
 * identically on any machine with no internet access and no client-side
 * library. The payload is the variant barcode (defaults to the SKU), which is
 * exactly what a hardware scanner emits back into the POS search box.
 */
import QRCode from 'qrcode';
import repositories from '../infrastructure/repositories/index.js';
import { NotFoundError, ValidationError } from '../shared/errors.js';
import auditService from './AuditService.js';

export class LabelService {
  constructor(deps = {}) {
    this.variants = deps.variants || repositories.variants;
    this.settings = deps.settings || repositories.settings;
    this.audit = deps.audit || auditService;
  }

  async renderQr(payload, { size = 128, margin = 1 } = {}) {
    return QRCode.toString(String(payload), {
      type: 'svg',
      margin,
      width: size,
      errorCorrectionLevel: 'M',
    });
  }

  async qrDataUri(payload, options = {}) {
    // The QR library throws a bare "No input text" on empty input, which reaches
    // the client as a 500. An empty payload is a bad request, and saying so is
    // the difference between a usable error at the counter and a mystery.
    const text = String(payload ?? '').trim();
    if (!text) throw new ValidationError('Nothing to encode — a QR code needs a payload');

    return QRCode.toDataURL(text, {
      margin: options.margin ?? 1,
      width: options.size ?? 160,
      errorCorrectionLevel: 'M',
    });
  }

  /**
   * Build a print-ready label batch.
   * @param {Array<{variant_id:number, copies:number}>} items
   */
  async buildBatch(items = [], options = {}, context = {}) {
    if (!items.length) throw new ValidationError('Select at least one item to print');
    const company = {
      name: await this.settings.get('company.name', 'M&M Accessories'),
      nameAr: await this.settings.get('company.name_ar', 'إم آند إم للإكسسوارات'),
    };
    const currency = await this.settings.get('company.currency', 'EGP');
    const labels = [];

    for (const item of items) {
      const variant = await this.variants.details(item.variant_id);
      if (!variant) throw new NotFoundError('Variant', item.variant_id);
      const payload = variant.barcode || variant.sku;
      const qr = await this.qrDataUri(payload, { size: options.qrSize || 180 });
      const copies = Math.min(Math.max(Number(item.copies) || 1, 1), 200);
      for (let i = 0; i < copies; i += 1) {
        labels.push({
          sku: variant.sku,
          barcode: payload,
          qr,
          productNameEn: variant.product_name_en,
          productNameAr: variant.product_name_ar,
          variantLabel: variant.variant_label,
          brandEn: variant.brand_name_en,
          price: variant.selling_price,
          currency,
          company,
        });
      }
    }

    await this.audit.record({
      action: 'PRINT', module: 'labels', entityType: 'label_batch',
      entityLabel: `${labels.length} labels`,
      after: { items: items.length, labels: labels.length, size: options.labelSize || '40x30' },
      actor: context.actor, request: context.request,
    });

    return { labels, labelSize: options.labelSize || '40x30', generatedAt: new Date().toISOString() };
  }

  /** QR for a document (invoice / PO) so it can be pulled up by scanning. */
  async documentQr(type, number) {
    return this.qrDataUri(`${type.toUpperCase()}:${number}`, { size: 140 });
  }
}

export const labelService = new LabelService();
export default labelService;
