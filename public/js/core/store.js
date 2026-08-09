/** Session state shared across views: user, permissions, settings, lookups. */
import api from './api.js';

export const session = {
  user: null,
  settings: {},
  /** The single shop location. Kept as a record so documents still reference it. */
  location: null,
  lookups: {},
};

export function can(...codes) {
  if (!session.user) return false;
  return codes.some((code) => session.user.permissions.includes(code));
}

export async function loadSession() {
  const data = await api.get('/api/auth/me');
  session.user = data.user;
  session.settings = data.settings || {};
  session.location = (data.warehouses || [])[0] || null;
  return session;
}

export function clearSession() {
  session.user = null;
  session.settings = {};
  session.location = null;
  session.lookups = {};
}

/** Typed accessors over the flat settings map. */
export const setting = (key, fallback = null) => {
  const value = session.settings[key];
  return value === undefined || value === null || value === '' ? fallback : value;
};
export const settingNumber = (key, fallback = 0) => {
  const value = Number(setting(key, fallback));
  return Number.isFinite(value) ? value : fallback;
};
export const settingBool = (key, fallback = false) => {
  const value = setting(key, fallback);
  return value === true || value === 1 || value === '1' || value === 'true';
};

/** Everything the scanner and the two printers need, in one place. */
export const devices = () => ({
  scanner: {
    enabled: settingBool('scanner.enabled', true),
    maxKeyIntervalMs: settingNumber('scanner.max_key_interval_ms', 60),
    minLength: settingNumber('scanner.min_length', 3),
    stripPrefix: setting('scanner.strip_prefix', '') || '',
    stripSuffix: setting('scanner.strip_suffix', '') || '',
    beep: settingBool('scanner.beep_on_scan', true),
  },
  receipt: {
    width: String(setting('printer.receipt_width', '80')),
    copies: settingNumber('printer.receipt_copies', 1),
    autoPrint: settingBool('printer.auto_print_receipt', false),
    showQr: settingBool('printer.receipt_show_qr', true),
    showTaxLines: settingBool('printer.receipt_show_tax_lines', true),
    fontScale: settingNumber('printer.receipt_font_scale', 100),
  },
  label: {
    widthMm: settingNumber('labels.width_mm', 40),
    heightMm: settingNumber('labels.height_mm', 30),
    gapMm: settingNumber('labels.gap_mm', 2),
    offsetXMm: settingNumber('labels.offset_x_mm', 0),
    offsetYMm: settingNumber('labels.offset_y_mm', 0),
    qrSizeMm: settingNumber('labels.qr_size_mm', 17),
    showProductName: settingBool('labels.show_product_name', true),
    showVariant: settingBool('labels.show_variant', true),
    showPrice: settingBool('labels.show_price', true),
    showSku: settingBool('labels.show_sku', true),
    showShopName: settingBool('labels.show_shop_name', false),
  },
});

/** Cached reference lists (brands, categories, …) — invalidated after writes. */
export async function lookup(name, path) {
  if (session.lookups[name]) return session.lookups[name];
  const data = await api.get(path);
  session.lookups[name] = data.rows || [];
  return session.lookups[name];
}

export function invalidate(...names) {
  if (!names.length) session.lookups = {};
  for (const name of names) delete session.lookups[name];
}
