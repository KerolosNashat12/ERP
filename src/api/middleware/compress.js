/**
 * Compression, written here rather than pulled in as a dependency.
 *
 * The shop was sending 423KB of raw CSS and JavaScript to every phone that
 * opened it, with no content-encoding at all - on Egyptian mobile data that is
 * the difference between a shop that appears and a white screen somebody backs
 * out of. The same bytes gzip down to well under a fifth of that.
 *
 * Why not `npm install compression`: this project deliberately has no build
 * step and runs on a shop PC that is often offline, so every new dependency is
 * something that has to be installed again on a machine that may not be able
 * to reach the registry. `zlib` is in Node itself.
 *
 * What it does NOT do, on purpose:
 *   - it never compresses images, PDFs, zips or fonts - already compressed, and
 *     running them through gzip spends CPU to make them very slightly bigger;
 *   - it leaves small bodies alone: below about a kilobyte the headers and the
 *     compressor cost more than the saving;
 *   - it never touches a response that already has a content-encoding, so a
 *     CDN or a proxy that got there first is not double-encoded;
 *   - it declines when the client did not ask, which includes old scanners and
 *     anything speaking HTTP/1.0.
 *
 * Brotli is preferred when the client offers it (roughly 15-20% smaller than
 * gzip on this kind of text) at a quality setting chosen so a cold serverless
 * invocation does not spend its budget compressing: quality 5, not the default
 * 11, which is for files compressed once and served a million times.
 */
import zlib from 'node:zlib';

const COMPRESSIBLE = /^(?:text\/|application\/(?:json|javascript|xml|manifest|x-javascript)|image\/svg\+xml)/i;
const THRESHOLD = 1024;
/*
 * Compressing means holding the whole body in memory first. That is nothing for
 * a stylesheet and dangerous for a data export - a shop with a long history can
 * ask for a CSV of every sale it has ever made, and this runs in a function with
 * a fixed memory allowance. Past this size the response gives up on compression
 * and streams the rest as it was, which is slower on the wire and survivable,
 * where running out of memory is not.
 */
const MAX_BUFFERED = 8 * 1024 * 1024;

/*
 * The same stylesheet is compressed for every visitor otherwise. Static files
 * carry an ETag that changes when the file does, so it is a safe cache key -
 * and this keeps a serverless invocation from spending its first 11ms
 * squeezing bytes it squeezed for the previous visitor. Bounded on purpose:
 * this is a shop PC and a Hobby function, not a CDN.
 */
const MEMO_MAX_ENTRIES = 64;
const MEMO_MAX_BYTES = 4 * 1024 * 1024;
const memo = new Map();

function memoGet(key) {
  const hit = memo.get(key);
  if (!hit) return null;
  // Least-recently-used, cheaply: re-inserting moves it to the end.
  memo.delete(key);
  memo.set(key, hit);
  return hit;
}

function memoPut(key, buffer) {
  if (!key || buffer.length > MEMO_MAX_BYTES) return;
  memo.set(key, buffer);
  while (memo.size > MEMO_MAX_ENTRIES) memo.delete(memo.keys().next().value);
}

const BROTLI_OPTIONS = {
  params: {
    [zlib.constants.BROTLI_PARAM_QUALITY]: 5,
    [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
  },
};

/** What the client will accept, best first, or null for none. */
function chosenEncoding(header = '') {
  const accepted = String(header).toLowerCase();
  if (/\bbr\b/.test(accepted)) return 'br';
  if (/\bgzip\b/.test(accepted)) return 'gzip';
  if (/\bdeflate\b/.test(accepted)) return 'deflate';
  return null;
}

function compressorFor(encoding) {
  if (encoding === 'br') return (buffer) => zlib.brotliCompressSync(buffer, BROTLI_OPTIONS);
  if (encoding === 'gzip') return (buffer) => zlib.gzipSync(buffer);
  return (buffer) => zlib.deflateSync(buffer);
}

export default function compress() {
  return function compressMiddleware(req, res, next) {
    const encoding = chosenEncoding(req.headers['accept-encoding']);
    if (!encoding || req.method === 'HEAD') return next();

    const { write, end } = res;
    const chunks = [];
    let length = 0;
    let passthrough = false;

    /** Once we have decided not to compress, everything buffered goes out as it was. */
    const release = () => {
      passthrough = true;
      res.write = write;
      res.end = end;
      for (const chunk of chunks) write.call(res, chunk);
      chunks.length = 0;
    };

    const shouldCompress = () => {
      if (res.getHeader('Content-Encoding')) return false;
      if (res.statusCode === 204 || res.statusCode === 304) return false;
      if (String(res.getHeader('Cache-Control') || '').includes('no-transform')) return false;
      return COMPRESSIBLE.test(String(res.getHeader('Content-Type') || ''));
    };

    const collect = (chunk) => {
      if (!chunk) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(buffer);
      length += buffer.length;
    };

    res.write = function compressedWrite(chunk, encodingArg, callback) {
      if (passthrough) return write.call(res, chunk, encodingArg, callback);
      if (!shouldCompress()) { release(); return write.call(res, chunk, encodingArg, callback); }
      collect(typeof encodingArg === 'string' && chunk ? Buffer.from(chunk, encodingArg) : chunk);
      if (length > MAX_BUFFERED) {
        release();
        if (typeof encodingArg === 'function') encodingArg();
        else if (typeof callback === 'function') callback();
        return true;
      }
      if (typeof encodingArg === 'function') encodingArg();
      else if (typeof callback === 'function') callback();
      return true;
    };

    res.end = function compressedEnd(chunk, encodingArg, callback) {
      if (passthrough) return end.call(res, chunk, encodingArg, callback);
      if (typeof chunk === 'function') return end.call(res, chunk);
      if (chunk) collect(typeof encodingArg === 'string' ? Buffer.from(chunk, encodingArg) : chunk);

      res.write = write;
      res.end = end;

      const body = Buffer.concat(chunks);
      if (!shouldCompress() || length < THRESHOLD) return end.call(res, body, callback);

      const etagNow = res.getHeader('ETag');
      const memoKey = req.method === 'GET' && res.statusCode === 200 && typeof etagNow === 'string'
        ? `${encoding} ${etagNow} ${req.originalUrl || req.url}`
        : null;

      let squeezed = memoKey ? memoGet(memoKey) : null;
      if (!squeezed) {
        try {
          squeezed = compressorFor(encoding)(body);
        } catch {
          // A compressor that refuses is not a reason to fail the request.
          return end.call(res, body, callback);
        }
        if (memoKey) memoPut(memoKey, squeezed);
      }

      res.setHeader('Content-Encoding', encoding);
      res.setHeader('Content-Length', String(squeezed.length));
      /*
       * The same URL now has two shapes on the wire, so a shared cache must key
       * on what the client asked for or it will hand brotli to something that
       * cannot read it.
       */
      const vary = String(res.getHeader('Vary') || '');
      if (!/accept-encoding/i.test(vary)) {
        res.setHeader('Vary', vary ? `${vary}, Accept-Encoding` : 'Accept-Encoding');
      }
      // A weak ETag survives re-encoding; a strong one would now be a lie.
      const etag = res.getHeader('ETag');
      if (etag && typeof etag === 'string' && !etag.startsWith('W/')) res.setHeader('ETag', `W/${etag}`);

      return end.call(res, squeezed, callback);
    };

    return next();
  };
}
