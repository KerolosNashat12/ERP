/**
 * The whole templating layer, in one file.
 *
 * Everything on this site is built from `el()` rather than from HTML strings,
 * because half the text on the page is a product name typed by a member of
 * staff and the other half is a search term typed by a stranger. With
 * `innerHTML` that is one missed escape away from script injection on a public
 * page; with `textContent` it cannot happen at all, and nobody has to remember.
 */

/**
 * @param {string} tag  tag name, optionally with `#id` and `.class.names`
 * @param {object|string|Node|Array} [props] attributes, or the children
 * @param {...(Node|string|null|false)} children
 */
export function el(tag, props, ...children) {
  const [selector, ...classes] = tag.split('.');
  const [name, id] = selector.split('#');
  const node = document.createElement(name || 'div');
  if (id) node.id = id;
  if (classes.length) node.className = classes.join(' ');

  if (props && (typeof props === 'string' || props instanceof Node || Array.isArray(props))) {
    children.unshift(props);
  } else if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') node.className = [node.className, value].filter(Boolean).join(' ');
      else if (key === 'text') node.textContent = String(value);
      else if (key === 'html') node.innerHTML = value; // only ever called with our own markup
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
      else if (key in node && key !== 'list' && key !== 'form') node[key] = value;
      else node.setAttribute(key, value === true ? '' : String(value));
    }
  }

  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false || child === '') continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** Replace a node's children in one go. */
export function fill(node, ...children) {
  node.replaceChildren(...children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false && c !== ''));
  return node;
}

export const $ = (selector, scope = document) => scope.querySelector(selector);
export const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];

/** An inline SVG icon from a path string. Icons are drawn, never downloaded. */
export function icon(path, { size = 20, fill = 'none' } = {}) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('icon');
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  node.setAttribute('d', path);
  node.setAttribute('fill', fill);
  if (fill === 'none') {
    node.setAttribute('stroke', 'currentColor');
    node.setAttribute('stroke-width', '1.6');
    node.setAttribute('stroke-linecap', 'round');
    node.setAttribute('stroke-linejoin', 'round');
  }
  svg.append(node);
  return svg;
}

/**
 * A chevron that means "onward". It carries `.icon-dir` so the stylesheet can
 * mirror it in Arabic — the arrow is the one glyph on the site whose meaning
 * depends on which way the line runs.
 */
export function chevron(size = 16) {
  const node = icon(ICONS.chevron, { size });
  node.classList.add('icon-dir');
  return node;
}

export const ICONS = {
  search: 'M11 19a8 8 0 1 1 0-16 8 8 0 0 1 0 16Zm10 2-4.35-4.35',
  bag: 'M6 8h12l-1 12H7L6 8Zm3 0V6a3 3 0 0 1 6 0v2',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm-9-9h18M12 3c2.5 2.6 3.7 5.6 3.7 9S14.5 18.4 12 21c-2.5-2.6-3.7-5.6-3.7-9S9.5 5.6 12 3Z',
  truck: 'M3 7h11v9H3V7Zm11 3h4l3 3v3h-7v-6ZM7 19.5a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2Zm10 0a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2Z',
  check: 'm5 13 4 4 10-10',
  chevron: 'm9 6 6 6-6 6',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  trash: 'M4 7h16M9 7V5h6v2m-8 0 1 13h8l1-13',
  whatsapp: 'M12 3a9 9 0 0 0-7.7 13.6L3 21l4.6-1.2A9 9 0 1 0 12 3Zm4.3 12.2c-.2.6-1.1 1.1-1.6 1.1-.4 0-.9.1-3-.8a11 11 0 0 1-4.4-4c-.3-.5-.8-1.4-.8-2.3 0-.9.5-1.4.7-1.6.2-.2.4-.3.6-.3h.5c.2 0 .4 0 .5.4l.7 1.7c.1.2 0 .4-.1.5l-.3.4c-.1.2-.3.3-.1.6.5.9 1 1.5 1.7 2 .3.2.6.4.9.5.2.1.4.1.5-.1l.6-.7c.2-.2.3-.2.5-.1l1.6.8c.2.1.4.2.4.3.1.2.1.7 0 1Z',
};
