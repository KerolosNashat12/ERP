/**
 * THE SEARCH INDEX — one row per product, holding what that product can be
 * found by.
 *
 * ── Why the text is stored rather than computed in the query ────────────────
 * The whole point of `shared/searchText.js` is that «أحمر» and «احمر» reduce to
 * the same key. SQL cannot run that reduction: SQLite has no Unicode-aware
 * `lower()`, no way to strip tashkeel, and nothing that folds a hamza. So the
 * reduction happens in JavaScript when a product is SAVED, its result is
 * stored, and the term a person types is put through the identical function
 * before it is compared. One function, both ends.
 *
 * That is also the failure mode to watch for: if this table drifts from the
 * products it describes, search stops finding things that plainly exist, and
 * nothing else breaks to tell anybody. Three defences —
 *   · every write path that changes searchable text calls `reindexProduct`;
 *   · renaming a BRAND or a CATEGORY reindexes the products under it, because
 *     their names are in the index too;
 *   · `reindexAll()` rebuilds the lot, and is what the migration runs and what
 *     a shop can be told to run if it is ever doubted.
 *
 * ── Its own table, not a column on `products` ───────────────────────────────
 * `products` is read on every till screen and every storefront page. Widening
 * it with two long text columns costs every one of those reads. A side table
 * is read only when somebody searches, can be rebuilt with one DELETE and one
 * INSERT without touching a product row, and — the reason that matters most
 * here — `schema.js` is applied BEFORE the migrations, so a new column on
 * `products` could not be named by `v_variant_details` without breaking boot.
 */
import { getDb } from '../infrastructure/database/connection.js';
import { indexText, indexBones } from '../../public/shared/searchText.js';

/**
 * Everything a product should be findable by.
 *
 * Deliberately NOT the description: it is a paragraph of adjectives, and
 * putting it in makes every product match "the", "with" and "original". A
 * search box that answers most queries with most of the catalogue is not a
 * search box.
 *
 * Deliberately INCLUDED: the brand and the category. «ديور» has to find Dior's
 * products, and a shop owner typing a brand name expects the products, not a
 * lecture about using the filter dropdown.
 */
const PRODUCT_TEXT_SQL = `
  SELECT
    p.id                                   AS product_id,
    p.sku_prefix                           AS code,
    p.name_en                              AS name_en,
    p.name_ar                              AS name_ar,
    b.name_en                              AS brand_en,
    b.name_ar                              AS brand_ar,
    c.name_en                              AS category_en,
    c.name_ar                              AS category_ar,
    (SELECT GROUP_CONCAT(v.sku, ' ')
       FROM product_variants v WHERE v.product_id = p.id)           AS skus,
    (SELECT GROUP_CONCAT(v.barcode, ' ')
       FROM product_variants v WHERE v.product_id = p.id
        AND v.barcode IS NOT NULL AND TRIM(v.barcode) <> '')        AS barcodes,
    (SELECT GROUP_CONCAT(v.variant_label, ' ')
       FROM product_variants v WHERE v.product_id = p.id
        AND v.variant_label IS NOT NULL AND TRIM(v.variant_label) <> '') AS labels
  FROM products p
  LEFT JOIN brands b     ON b.id = p.brand_id
  LEFT JOIN categories c ON c.id = p.category_id
`;

/** The two stored strings for one gathered row. */
export function rowsToIndex(row) {
  const parts = [
    row.code, row.name_en, row.name_ar,
    row.brand_en, row.brand_ar, row.category_en, row.category_ar,
    row.skus, row.barcodes, row.labels,
  ];
  return {
    search_key: indexText(...parts),
    /*
     * Only the NAMES get skeletons. A code and a barcode are not words in any
     * script, and vowel-stripping `LX08` would produce a shape that collides
     * with other codes for no benefit — nobody types a product code in the
     * wrong alphabet.
     */
    bones: indexBones(row.name_en, row.name_ar, row.brand_en, row.brand_ar),
  };
}

const UPSERT = `
  INSERT INTO product_search (product_id, search_key, bones)
  VALUES (?, ?, ?)
  ON CONFLICT(product_id) DO UPDATE SET
    search_key = excluded.search_key,
    bones      = excluded.bones
`;

/**
 * Re-read one product and rewrite its index row.
 *
 * Never throws into a caller: a product that saved correctly must not be
 * rolled back because its search text could not be rebuilt. The product is the
 * record; the index is a convenience over it, and `reindexAll()` can always
 * repair it. The failure is reported to the log so it is not silent.
 */
export async function reindexProduct(productId, db = null) {
  try {
    const handle = db || getDb();
    const row = await handle.prepare(`${PRODUCT_TEXT_SQL} WHERE p.id = ?`).get(productId);
    if (!row) {
      await handle.prepare('DELETE FROM product_search WHERE product_id = ?').run(productId);
      return false;
    }
    const { search_key: key, bones } = rowsToIndex(row);
    await handle.prepare(UPSERT).run(productId, key, bones);
    return true;
  } catch (error) {
    console.error('[search] could not index product', productId, error.message);
    return false;
  }
}

/** Every product under a brand or a category — for a rename. */
export async function reindexWhere(column, value, db = null) {
  if (!['brand_id', 'category_id'].includes(column)) return 0;
  try {
    const handle = db || getDb();
    const rows = await handle
      .prepare(`SELECT id FROM products WHERE ${column} = ?`)
      .all(value);
    for (const row of rows) {
      // eslint-disable-next-line no-await-in-loop -- one statement per product.
      await reindexProduct(row.id, handle);
    }
    return rows.length;
  } catch (error) {
    console.error('[search] could not reindex by', column, error.message);
    return 0;
  }
}

export async function removeFromIndex(productId, db = null) {
  try {
    await (db || getDb()).prepare('DELETE FROM product_search WHERE product_id = ?').run(productId);
  } catch (error) {
    console.error('[search] could not un-index product', productId, error.message);
  }
}

/**
 * Rebuild the whole index. Run by the migration that creates the table, and
 * available to a shop that has reason to doubt it.
 *
 * Reads every product in ONE query and writes one row each, rather than
 * calling `reindexProduct` per product — on a hosted database that is the
 * difference between one round trip and six hundred.
 */
export async function reindexAll(db = null) {
  const handle = db || getDb();
  const rows = await handle.prepare(PRODUCT_TEXT_SQL).all();
  const upsert = handle.prepare(UPSERT);
  for (const row of rows) {
    const { search_key: key, bones } = rowsToIndex(row);
    // eslint-disable-next-line no-await-in-loop -- the driver serialises anyway.
    await upsert.run(row.product_id, key, bones);
  }
  // A product deleted while the index was stale would otherwise stay findable.
  await handle.prepare(`
    DELETE FROM product_search
    WHERE product_id NOT IN (SELECT id FROM products)
  `).run();
  return rows.length;
}

export default { reindexProduct, reindexWhere, removeFromIndex, reindexAll, rowsToIndex };
