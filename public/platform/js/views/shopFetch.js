/**
 * Reading inside one shop, and saying so when it cannot be done.
 *
 * Every tab on the shop-detail screen reads that shop's own database through
 * the platform API, and every one of them can meet the same wall: the control
 * plane knows the shop, the shop's database does not answer. The server has
 * nothing better to say about that than a 500 — it deliberately does not quote
 * a driver's message back, because a driver's message can contain the database
 * URL, and a URL is half of a credential.
 *
 * So the sentence is written here, in the reader's own language, and it says
 * the one thing that matters: the numbers are missing, not zero.
 */
import { t } from '../core/i18n.js';

export function readShop(promise) {
  return promise.catch((error) => {
    if (error?.status >= 500) {
      const unreachable = new Error(t('shopUnreachableBody'));
      unreachable.status = error.status;
      unreachable.code = 'shop-unreachable';
      throw unreachable;
    }
    throw error;
  });
}

export default readShop;
