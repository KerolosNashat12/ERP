/**
 * The console's icons, as inline SVG strings.
 *
 * Not a font, not a sprite sheet, not a CDN: a handful of 24-grid strokes that
 * inherit `currentColor` and scale with the button they sit in. Emoji were the
 * alternative and they are the wrong texture for an operations console — they
 * render differently on every machine and carry colour nobody chose.
 */
const svg = (body, { stroke = true } = {}) => `<svg viewBox="0 0 24 24" fill="${stroke ? 'none' : 'currentColor'}" `
  + `stroke="${stroke ? 'currentColor' : 'none'}" stroke-width="1.8" stroke-linecap="round" `
  + `stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;

export const icons = {
  copy: svg('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>'),
  check: svg('<path d="M20 6 9 17l-5-5"/>'),
  external: svg('<path d="M14 4h6v6"/><path d="M20 4 11 13"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>'),
  refresh: svg('<path d="M20 11a8 8 0 1 0-2.3 6"/><path d="M20 4v7h-7"/>'),
  chevron: svg('<path d="m9 5 7 7-7 7"/>'),
  search: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/>'),
  shop: svg('<path d="M4 9h16l-1 11H5L4 9Z"/><path d="M8 9V6a4 4 0 0 1 8 0v3"/>'),
  chart: svg('<path d="M4 20V10"/><path d="M10 20V4"/><path d="M16 20v-7"/><path d="M22 20H2"/>'),
  alert: svg('<path d="M12 3 2 20h20L12 3Z"/><path d="M12 10v4"/><path d="M12 17h.01"/>'),
  offline: svg('<path d="M3 3l18 18"/><path d="M8.5 16.5a5 5 0 0 1 7 0"/><path d="M5 13a10 10 0 0 1 3.5-2.3"/><path d="M19 13a10 10 0 0 0-6.5-2.9"/><path d="M2 9a15 15 0 0 1 5-3.2"/><path d="M22 9a15 15 0 0 0-9.5-3.9"/><path d="M12 20h.01"/>'),
  users: svg('<circle cx="9" cy="8" r="3.2"/><path d="M3 20a6 6 0 0 1 12 0"/><path d="M16 5.5a3.2 3.2 0 0 1 0 5"/><path d="M17.5 14.6A6 6 0 0 1 21 20"/>'),
  box: svg('<path d="M12 3 3 7.5v9L12 21l9-4.5v-9L12 3Z"/><path d="M3 7.5 12 12l9-4.5"/><path d="M12 12v9"/>'),
  clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.2 2"/>'),
  sliders: svg('<path d="M4 6h10"/><path d="M18 6h2"/><path d="M4 12h4"/><path d="M12 12h8"/><path d="M4 18h10"/><path d="M18 18h2"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="16" cy="18" r="2"/>'),
  arrows: svg('<path d="M7 3v14"/><path d="m3 13 4 4 4-4"/><path d="M17 21V7"/><path d="m13 11 4-4 4 4"/>'),
  /* The rail's own three: the way out, the way in on a phone, and the way back. */
  signout: svg('<path d="M15 17l5-5-5-5"/><path d="M20 12H9"/><path d="M12 4H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h5"/>'),
  menu: svg('<path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h16"/>'),
  close: svg('<path d="M6 6l12 12"/><path d="M18 6 6 18"/>'),
};

export default icons;
