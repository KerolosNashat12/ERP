/**
 * A ZIP writer, written here rather than installed.
 *
 * This repository has no build step and no native dependencies — that is the
 * property that lets the same code run on a shop counter PC and on a serverless
 * function — so a backup that arrives as a `.zip` needs one of two things: a new
 * dependency, or about a hundred lines. This is the hundred lines. Everything it
 * uses is in `node:zlib`.
 *
 * ── Why entries are buffered one at a time ───────────────────────────────────
 * The classic ZIP layout wants each entry's CRC and its two sizes written in
 * the header *before* the bytes. A writer that streams an entry it has not seen
 * the end of has to use a "data descriptor" (general-purpose bit 3) and put
 * those three numbers after the payload instead. That is legal, and some
 * readers are still bad at it — including archive tools of the kind a shop
 * owner in Egypt actually has installed.
 *
 * So each entry is deflated whole, then written with real sizes and no
 * descriptor. That bounds memory at ONE ENTRY, not one archive, which is why
 * the snapshot inside a backup is split into many small parts rather than
 * written as one enormous file: see `platform/snapshot.js`. The archive itself
 * is streamed to the sink as it is built and is never held in memory.
 *
 * ── What is deliberately not implemented ─────────────────────────────────────
 * ZIP64. It is not needed below 4 GB, 65 535 entries and 4 GB per entry, and a
 * backup anywhere near any of those limits has already been refused by the size
 * ceiling in `BackupService`. `finish()` throws rather than writing an archive
 * that would silently truncate.
 */
import zlib from 'node:zlib';

/* CRC-32 (IEEE 802.3), table-driven. Built once, on first use. */
let CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  CRC_TABLE = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    CRC_TABLE[n] = c;
  }
  return CRC_TABLE;
}

export function crc32(buffer) {
  const table = crcTable();
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = (crc >>> 8) ^ table[(crc ^ buffer[i]) & 0xFF];
  }
  return (crc ^ -1) >>> 0;
}

/** MS-DOS packed date/time, which is the only clock a ZIP header has. */
function dosStamp(date) {
  const year = Math.max(1980, date.getUTCFullYear());
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

const MAX_ENTRIES = 65_535;
const MAX_OFFSET = 0xFFFFFFFF;

/**
 * `write` is called with a Buffer for every piece of the archive, in order. It
 * may return a promise (an HTTP response that has applied back-pressure), and
 * every one is awaited — a serverless function that ignores back-pressure is a
 * serverless function that buffers the whole file in the socket instead.
 */
export class ZipWriter {
  #write;

  #offset = 0;

  #entries = [];

  #closed = false;

  constructor(write) {
    this.#write = write;
  }

  async #put(buffer) {
    await this.#write(buffer);
    this.#offset += buffer.length;
  }

  /**
   * One file in the archive. `data` is a Buffer or a string (encoded UTF-8).
   *
   * `store: true` skips deflate, for bytes that are already compressed — a
   * photograph inside a snapshot part gains nothing from a second pass and
   * costs real CPU on a function with a time limit.
   */
  async add(name, data, { store = false, modifiedAt = new Date() } = {}) {
    if (this.#closed) throw new Error('This archive has already been finished');
    if (this.#entries.length >= MAX_ENTRIES) {
      throw new Error(`A ZIP archive cannot hold more than ${MAX_ENTRIES} files`);
    }

    const body = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(body);
    const payload = store ? body : zlib.deflateRawSync(body, { level: 6 });
    // Deflate can make small or already-compressed input bigger. Storing it is
    // both smaller and faster to read back.
    const deflated = !store && payload.length < body.length;
    const bytes = deflated ? payload : body;
    const stamp = dosStamp(modifiedAt);
    const offset = this.#offset;

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034B50, 0);
    header.writeUInt16LE(20, 4); // version needed: 2.0 (deflate)
    header.writeUInt16LE(0x0800, 6); // bit 11: the name is UTF-8
    header.writeUInt16LE(deflated ? 8 : 0, 8);
    header.writeUInt16LE(stamp.time, 10);
    header.writeUInt16LE(stamp.date, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(bytes.length, 18);
    header.writeUInt32LE(body.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    header.writeUInt16LE(0, 28);

    await this.#put(header);
    await this.#put(nameBytes);
    await this.#put(bytes);

    this.#entries.push({
      nameBytes, crc, compressed: bytes.length, raw: body.length, offset, stamp, deflated,
    });
    return { name, raw: body.length, compressed: bytes.length };
  }

  /** The central directory, and the end-of-archive record. Call exactly once. */
  async finish() {
    if (this.#closed) throw new Error('This archive has already been finished');
    this.#closed = true;

    const start = this.#offset;
    for (const entry of this.#entries) {
      if (entry.offset > MAX_OFFSET) {
        throw new Error('This archive is larger than 4 GB, which needs ZIP64');
      }
      const record = Buffer.alloc(46);
      record.writeUInt32LE(0x02014B50, 0);
      record.writeUInt16LE(0x031E, 4); // made by: UNIX, 3.0
      record.writeUInt16LE(20, 6);
      record.writeUInt16LE(0x0800, 8);
      record.writeUInt16LE(entry.deflated ? 8 : 0, 10);
      record.writeUInt16LE(entry.stamp.time, 12);
      record.writeUInt16LE(entry.stamp.date, 14);
      record.writeUInt32LE(entry.crc, 16);
      record.writeUInt32LE(entry.compressed, 20);
      record.writeUInt32LE(entry.raw, 24);
      record.writeUInt16LE(entry.nameBytes.length, 28);
      record.writeUInt16LE(0, 30); // extra
      record.writeUInt16LE(0, 32); // comment
      record.writeUInt16LE(0, 34); // disk
      record.writeUInt16LE(0, 36); // internal attributes
      record.writeUInt32LE(0o644 << 16, 38); // external: rw-r--r--
      record.writeUInt32LE(entry.offset, 42);
      await this.#put(record);
      await this.#put(entry.nameBytes);
    }

    const size = this.#offset - start;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054B50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(this.#entries.length, 8);
    end.writeUInt16LE(this.#entries.length, 10);
    end.writeUInt32LE(size, 12);
    end.writeUInt32LE(start, 16);
    end.writeUInt16LE(0, 20);
    await this.#put(end);
    return this.#offset;
  }

  get bytesWritten() {
    return this.#offset;
  }

  get entryCount() {
    return this.#entries.length;
  }
}

/** The same writer, collecting into one Buffer. Used for the workbooks. */
export async function zipToBuffer(build) {
  const parts = [];
  const writer = new ZipWriter((chunk) => { parts.push(chunk); });
  await build(writer);
  await writer.finish();
  return Buffer.concat(parts);
}

export default { ZipWriter, zipToBuffer, crc32 };
