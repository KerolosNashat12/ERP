/**
 * The storefront's PAGES — the HTML itself, `robots.txt` and `sitemap.xml`.
 *
 * Separate from `shop.js`, which answers with JSON for a script that is already
 * running. Everything here answers a request made before any script runs at
 * all: a crawler, a WhatsApp link preview, a customer opening a link cold.
 *
 * ── Why these routes have to exist at all ────────────────────────────────────
 * A host that serves `public/` statically answers from its CDN before this
 * application is reached — the comments in `src/server.js` say so in three
 * places, because it has caught this codebase three times. That is exactly what
 * would happen to a storefront page: the CDN would hand out a shell with a
 * placeholder title and no shop in it, and the head this file renders would
 * never be asked for. So the shell is `public/shop/app.html`, NOT
 * `public/shop/index.html`: there is no directory index under `/shop` for a CDN
 * to find, every page request falls through to this router, and the one file
 * that could leak one shop's name into another's pages is not addressable as a
 * page at all.
 *
 * ── Caching ──────────────────────────────────────────────────────────────────
 * The HTML is `no-store`, for the same reason `/api` is: it now carries the
 * shop's prices, its stock verdicts and whether the shop is open, both in the
 * head and in the boot payload underneath it. A page that was only true when it
 * was sent must not be kept. `robots.txt` and the sitemaps take five minutes,
 * because they contain nothing that is not already on a public page and a
 * crawler re-reading them is not a customer waiting for a price.
 */
import path from 'node:path';
import storefront from '../../services/StorefrontService.js';
import { renderPage } from '../../services/StorefrontSeo.js';
import {
  sitemapIndex, pagesSitemap, taxonomySitemap, productsSitemap, shardFor, robotsTxt, CACHE_CONTROL,
} from '../../services/SitemapService.js';
import { publicBaseUrl } from '../../platform/links.js';
import { asyncHandler } from '../middleware/index.js';
import { currentTenant } from '../../infrastructure/database/connection.js';
import config from '../../config/index.js';
import { routeSegments } from '../../../public/shared/shopUrls.js';

/** Sent as-is if a render ever fails; it names no shop and says `noindex`. */
const SHELL = path.join(config.paths.public, 'shop', 'app.html');

/**
 * Is there anything here a crawler should be told about?
 *
 * Two switches, and both have to be on. `websiteEnabled` is the owner's console
 * switch and means the shop is not on the internet at all — the routes that
 * matter are already 404 behind `websiteGate`, and this covers the one route
 * (the root `robots.txt`) that must keep answering either way. `shopEnabled` is
 * the ERP's own switch: the storefront still loads and shows one closed notice
 * on every page, which is `noindex` (see StorefrontSeo) and gets no sitemap —
 * leading a crawler to five thousand addresses that all say "we are closed
 * right now" is worse than leading it to none.
 */
async function openForCrawlers() {
  if (currentTenant() && !currentTenant().websiteEnabled) return false;
  const { shopEnabled } = await storefront.config();
  return Boolean(shopEnabled);
}

const xmlResponse = (res, body) => {
  res.type('application/xml');
  res.setHeader('Cache-Control', CACHE_CONTROL);
  res.send(body);
};

/**
 * Every page of the storefront, rendered.
 *
 * A failure to render is answered with the shell exactly as it is on disk
 * rather than with a 500: the head is what a crawler needs, and a customer
 * standing in front of a shop needs the shop. The page still works — the script
 * fetches everything it needs, as it did before any of this existed — it just
 * arrives without a title. That is the correct direction to fail in, and it is
 * why the raw shell says `noindex` on its own.
 */
export function pageHandler(prefixOf = () => '') {
  return async function handler(req, res) {
    const prefix = prefixOf(req);
    const root = `${prefix}/shop`;
    res.setHeader('Cache-Control', 'no-store');
    try {
      const { status, html } = await renderPage({
        req, root, prefix, segments: routeSegments(req.path, root), query: req.query,
      });
      res.status(status);
      res.type('html');
      res.send(html);
    } catch (error) {
      console.error(`Could not render ${req.path}: ${error.message}`);
      res.type('html');
      res.sendFile(SHELL);
    }
  };
}

/**
 * `robots.txt`, `sitemap.xml` and the shards.
 *
 * Three handlers rather than a mounted router, because `server.js` registers
 * them at two different depths — `/robots.txt` and `/t/:slug/robots.txt` — and
 * a router mounted at a path would have that path stripped off before its own
 * routes were matched. `prefixOf` is a function of the request for the same
 * reason: on a fleet the prefix is the slug in the address, and on the root of
 * a fleet it is the default shop's, which is not in the address at all.
 */
export function seoRoutes({ prefixOf = () => '', prefixesOf = null, hasSitemap = true } = {}) {
  const robots = async (req, res) => {
    const prefix = prefixOf(req);
    const base = publicBaseUrl(req);
    // A deployment with no shop at this address has no catalogue to point at,
    // and asking a database that belongs to nobody whether it is open would be
    // a question with no meaning. The refusal above it still stands.
    const open = hasSitemap && await openForCrawlers();
    res.type('text/plain');
    res.setHeader('Cache-Control', CACHE_CONTROL);
    res.send(robotsTxt({
      prefixes: prefixesOf ? prefixesOf(req) : [prefix],
      sitemapUrl: open ? new URL(`${prefix}/sitemap.xml`, base).href : '',
    }));
  };

  const sitemap = async (req, res) => {
    if (!await openForCrawlers()) return res.status(404).end();
    const root = `${prefixOf(req)}/shop`;
    return xmlResponse(res, await sitemapIndex({ base: publicBaseUrl(req), root }));
  };

  const shard = async (req, res) => {
    if (!await openForCrawlers()) return res.status(404).end();
    const which = shardFor(String(req.params.shard || '').replace(/\.xml$/, ''));
    if (!which) return res.status(404).end();
    const prefix = prefixOf(req);
    const root = `${prefix}/shop`;
    const base = publicBaseUrl(req);
    if (which.kind === 'pages') return xmlResponse(res, await pagesSitemap({ base, root }));
    if (which.kind === 'taxonomy') return xmlResponse(res, await taxonomySitemap({ base, root }));
    return xmlResponse(res, await productsSitemap({
      base, root, prefix, shard: which.shard,
    }));
  };

  return {
    robots: asyncHandler(robots),
    sitemap: asyncHandler(sitemap),
    shard: asyncHandler(shard),
  };
}

export default { pageHandler, seoRoutes };
