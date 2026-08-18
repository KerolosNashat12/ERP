/**
 * Everything the public storefront needs that the ERP did not already have.
 *
 * Two ideas here:
 *
 *  1. Nothing is public by accident. `is_published` defaults to 0, so an
 *     existing catalogue stays invisible until someone deliberately ticks a
 *     product. The alternative — publishing everything on deploy — would put
 *     draft and discontinued items in front of customers.
 *
 *  2. Photos live in the database, not on a disk. A serverless host has no
 *     durable disk, and the shop PC has to work with the internet down; keeping
 *     the bytes in SQLite means the photo is in the backup, syncs with the data,
 *     and behaves the same in both places.
 */
export default {
  name: '001-web-storefront',

  async up({ addColumn, ddl }) {

    // --- what the website may show
    await addColumn('products', 'is_published', 'INTEGER NOT NULL DEFAULT 0');
    await addColumn('products', 'web_description_en', 'TEXT');
    await addColumn('products', 'web_description_ar', 'TEXT');
    await addColumn('products', 'published_at', 'TEXT');

    await addColumn('categories', 'is_published', 'INTEGER NOT NULL DEFAULT 1');
    await addColumn('categories', 'display_order', 'INTEGER NOT NULL DEFAULT 0');
    await addColumn('brands', 'is_published', 'INTEGER NOT NULL DEFAULT 1');

    // --- photos
    //
    // The bytes sit in `data`, already compressed and resized by the browser
    // before upload. `content_type` and `byte_size` are stored rather than
    // derived so the serving endpoint never has to sniff the payload.
    await ddl(`
      CREATE TABLE IF NOT EXISTS product_images (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id    INTEGER NOT NULL REFERENCES products(id)         ON DELETE CASCADE,
        variant_id    INTEGER          REFERENCES product_variants(id) ON DELETE CASCADE,
        data          BLOB    NOT NULL,
        content_type  TEXT    NOT NULL DEFAULT 'image/jpeg',
        byte_size     INTEGER NOT NULL DEFAULT 0,
        width         INTEGER,
        height        INTEGER,
        alt_en        TEXT,
        alt_ar        TEXT,
        display_order INTEGER NOT NULL DEFAULT 0,
        created_by    INTEGER REFERENCES users(id),
        created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )
    `);
    await ddl('CREATE INDEX IF NOT EXISTS idx_images_product ON product_images(product_id, display_order)');
    await ddl('CREATE INDEX IF NOT EXISTS idx_images_variant ON product_images(variant_id)');

    // Which image represents the product in listings. A plain column rather
    // than "lowest display_order", so staff can choose without reordering.
    //
    // Deliberately no foreign key: products and product_images reference each
    // other, and a circular constraint cannot be expressed in a schema that has
    // to create cleanly from empty. Deleting an image clears this in the
    // service, and every read joins loosely, so a stale id shows no photo
    // rather than breaking the page.
    await addColumn('products', 'primary_image_id', 'INTEGER');
  },
};
