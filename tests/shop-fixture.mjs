/**
 * Seeds the storefront with products whose photos are DELIBERATELY different
 * shapes (tall, wide, square, tiny) plus one product with no photo at all, so
 * the card grid can be measured for raggedness. Development aid.
 *   node tests/shop-fixture.mjs
 */
import zlib from 'node:zlib';

const BASE = process.env.MM_TEST_URL || 'http://127.0.0.1:4000';

// --------------------------------------------------------------- tiny PNGs
function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let i = 0; i < 8; i += 1) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** A solid-colour RGB PNG of any dimensions — enough to prove a shape. */
function png(width, height, [r, g, b]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) {
    row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b;
  }
  const raw = Buffer.concat(Array.from({ length: height }, (_, y) => {
    const line = Buffer.from(row);
    // A visible band so a squashed image is obvious in a screenshot.
    if (y % 40 < 6) for (let x = 0; x < width; x += 1) line[1 + x * 3] = 255 - r;
    return line;
  }));

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const dataUrl = (w, h, rgb) => `data:image/png;base64,${png(w, h, rgb).toString('base64')}`;

// ------------------------------------------------------------------ client
let cookie = '';
async function call(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const text = await res.text();
  const payload = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 300)}`);
  return payload;
}

await call('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } });

const warehouseId = (await call('/api/location')).id;

/**
 * Names of very different lengths on purpose: a one-word name next to a name
 * that wraps to three lines is what made the grid ragged.
 */
const FIXTURES = [
  {
    sku: 'FIXTALL', name_en: 'Tall portrait clutch', name_ar: 'كلتش طولي',
    photos: [[300, 900, [180, 60, 60]], [900, 300, [60, 90, 180]]], stock: 7,
  },
  {
    sku: 'FIXWIDE',
    name_en: 'Extra wide panoramic leather travel wallet with a very long name indeed',
    name_ar: 'محفظة سفر جلد عريضة جدًا باسم طويل جدًا للاختبار',
    photos: [[1200, 300, [40, 120, 90]], [400, 400, [200, 150, 40]]], stock: 3,
  },
  {
    sku: 'FIXSQ', name_en: 'Square', name_ar: 'مربع',
    photos: [[600, 600, [120, 80, 160]]], stock: 25,
  },
  {
    sku: 'FIXNONE', name_en: 'No photo at all — placeholder card', name_ar: 'من غير صورة خالص',
    photos: [], stock: 12,
  },
  {
    sku: 'FIXTHIN', name_en: 'Very tall thin strip', name_ar: 'شريط رفيع طويل',
    photos: [[120, 1000, [200, 90, 30]]], stock: 1,
  },
  {
    sku: 'FIXOUT', name_en: 'Sold out piece', name_ar: 'قطعة خلصت',
    photos: [[800, 500, [90, 90, 90]]], stock: 0,
  },
  {
    sku: 'FIXFREE', name_en: 'Untracked service item', name_ar: 'خدمة من غير مخزون',
    photos: [[500, 800, [30, 140, 160]]], stock: 0, track: false,
  },
];

const made = [];
for (const fixture of FIXTURES) {
  const product = await call('/api/products', {
    method: 'POST',
    body: {
      sku_prefix: fixture.sku,
      name_en: fixture.name_en,
      name_ar: fixture.name_ar,
      description_en: 'A fixture product used to measure the card grid.',
      description_ar: 'منتج للاختبار.',
      unit: 'piece',
      tax_rate: 14,
      base_cost: 100,
      base_price: 250,
      track_inventory: fixture.track !== false,
      is_active: true,
      is_published: true,
      attribute_ids: [],
      variants: [{ variant_label: '', cost_price: 100, selling_price: 250, is_active: true }],
    },
  });

  for (const [w, h, rgb] of fixture.photos) {
    await call(`/api/products/${product.id}/images`, {
      method: 'POST',
      body: { dataUrl: dataUrl(w, h, rgb), altEn: `${w}x${h}`, altAr: `${w}x${h}` },
    });
  }

  const full = await call(`/api/products/${product.id}`);
  const variantId = full.variants[0].id;
  if (fixture.track !== false) {
    await call('/api/inventory/quick-adjust', {
      method: 'POST',
      body: { variantId, warehouseId, newQuantity: fixture.stock, reason: 'stock_take' },
    });
  }
  made.push({ id: product.id, variantId, sku: fixture.sku, stock: fixture.stock });
}

console.log(JSON.stringify(made, null, 2));
