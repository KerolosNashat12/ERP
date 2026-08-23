/**
 * Reading one file out of a ZIP, without holding the ZIP.
 *
 * A restore needs the snapshot parts out of a backup that is megabytes long and
 * stored as a few hundred rows in another database. Reassembling the whole
 * archive in memory to pull one 4 MB part out of it would put the entire backup
 * in a serverless function's heap — the exact thing the chunked layout exists to
 * avoid.
 *
 * So this reads the archive the way the format was designed to be read: the
 * end-of-central-directory record at the tail, the directory it points at, and
 * then each entry's own bytes by offset. `readRange(start, length)` is supplied
 * by the caller, so the same reader works against the control-plane chunks, a
 * file on disk, or a Buffer.
 */
import zlib from 'node:zlib';

const EOCD_SIGNATURE = 0x06054B50;
const CENTRAL_SIGNATURE = 0x02014B50;
const LOCAL_SIGNATURE = 0x04034B50;

/** The EOCD is 22 bytes plus a comment of up to 64 KB. Nothing here writes one. */
const EOCD_SEARCH = 66 * 1024;

export class ZipReader {
  #readRange;

  #size;

  #entries = null;

  /**
   * @param {(start:number,length:number)=>Promise<Buffer>} readRange
   * @param {number} size total bytes in the archive
   */
  constructor(readRange, size) {
    this.#readRange = readRange;
    this.#size = size;
  }

  async #directory() {
    if (this.#entries) return this.#entries;

    const tailLength = Math.min(this.#size, EOCD_SEARCH);
    const tail = await this.#readRange(this.#size - tailLength, tailLength);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) === EOCD_SIGNATURE) { eocd = i; break; }
    }
    if (eocd === -1) throw new Error('This file is not a ZIP archive (no end-of-directory record)');

    const count = tail.readUInt16LE(eocd + 10);
    const directorySize = tail.readUInt32LE(eocd + 12);
    const directoryOffset = tail.readUInt32LE(eocd + 16);
    const directory = await this.#readRange(directoryOffset, directorySize);

    const entries = new Map();
    let cursor = 0;
    for (let i = 0; i < count; i += 1) {
      if (directory.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
        throw new Error('This ZIP archive\'s directory is damaged');
      }
      const method = directory.readUInt16LE(cursor + 10);
      const crc = directory.readUInt32LE(cursor + 16);
      const compressed = directory.readUInt32LE(cursor + 20);
      const raw = directory.readUInt32LE(cursor + 24);
      const nameLength = directory.readUInt16LE(cursor + 28);
      const extraLength = directory.readUInt16LE(cursor + 30);
      const commentLength = directory.readUInt16LE(cursor + 32);
      const offset = directory.readUInt32LE(cursor + 42);
      const name = directory.toString('utf8', cursor + 46, cursor + 46 + nameLength);
      entries.set(name, {
        name, method, crc, compressed, raw, offset,
      });
      cursor += 46 + nameLength + extraLength + commentLength;
    }
    this.#entries = entries;
    return entries;
  }

  async names() {
    return [...(await this.#directory()).keys()];
  }

  async has(name) {
    return (await this.#directory()).has(name);
  }

  /** The decompressed bytes of one entry. */
  async read(name) {
    const entry = (await this.#directory()).get(name);
    if (!entry) throw new Error(`"${name}" is not in this archive`);

    // The local header repeats the name and may carry a different extra field,
    // so the data offset has to be read from it rather than assumed.
    const header = await this.#readRange(entry.offset, 30);
    if (header.readUInt32LE(0) !== LOCAL_SIGNATURE) {
      throw new Error(`"${name}" does not start where the directory says it does`);
    }
    const start = entry.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
    const bytes = await this.#readRange(start, entry.compressed);
    if (entry.method === 0) return bytes;
    if (entry.method !== 8) throw new Error(`"${name}" uses an unsupported compression method`);
    return zlib.inflateRawSync(bytes, { maxOutputLength: Math.max(entry.raw, 1) });
  }

  async readJson(name) {
    return JSON.parse((await this.read(name)).toString('utf8'));
  }
}

/** The same reader over bytes already in hand — the CLI restores from a file. */
export const zipFromBuffer = (buffer) => new ZipReader(
  async (start, length) => buffer.subarray(start, start + length),
  buffer.length,
);

export default { ZipReader, zipFromBuffer };
