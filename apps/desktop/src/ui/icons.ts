/**
 * The tool icons: one monochrome mark per tool id, drawn on a 16 × 16 grid with a 1.5 px
 * round stroke in `currentColor`, so an icon takes the colour of the row or box it sits
 * in. No letters and no fills beyond small dots: at 16 px only the silhouette reads, so
 * each mark is a single simple shape. The rail shows them at 16 px; the tool header puts
 * the same mark in its 24 px box.
 */

const dot = (x: number, y: number, r = 1): string =>
  `<circle cx="${x}" cy="${y}" r="${r}" fill="currentColor" stroke="none"/>`;
const cell = (x: number, y: number, size = 1.5): string =>
  `<rect x="${x}" y="${y}" width="${size}" height="${size}" fill="currentColor" stroke="none"/>`;

/** A document with its corner folded, for tools the table does not know yet. */
const GENERIC = '<path d="M9.5 1.5H4.5a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1v-9z"/><path d="M9.5 1.5v3h3M6 8.5h4M6 11h4"/>';

const ICONS: Record<string, string> = {
  // WORKSPACE
  "editor.text": '<path d="M10.5 2.5l3 3L6 13H3v-3z"/><path d="M8.5 4.5l3 3"/>',
  // FORMAT
  "format.css": '<path d="M14 2L8.75 7.25"/><path d="M7.5 6.5l2 2"/><path d="M7 8.5c-1.7-.4-3 .6-3.2 2.1-.1 1.1-.6 1.9-1.8 2.3 3 1 6.3.2 6.3-2.6"/>',
  "structured.csv": '<rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M2 6.25h12M2 9.75h12M6.25 6.25v7.25"/>',
  "format.html": '<path d="M5.5 4L1.75 8l3.75 4M10.5 4l3.75 4-3.75 4"/>',
  "format.js": '<path d="M9 1.5L3.5 9H8l-1 5.5L12.5 7H8z"/>',
  "structured.json": '<path d="M6 2.5c-1.5 0-2 .6-2 1.8v1.9c0 .9-.5 1.5-1.5 1.8 1 .3 1.5.9 1.5 1.8v1.9c0 1.2.5 1.8 2 1.8M10 2.5c1.5 0 2 .6 2 1.8v1.9c0 .9.5 1.5 1.5 1.8-1 .3-1.5.9-1.5 1.8v1.9c0 1.2-.5 1.8-2 1.8"/>',
  "preview.documents": '<rect x="2.5" y="1.5" width="11" height="13" rx="1.5"/><path d="M4.5 8.5s1.3-2.25 3.5-2.25 3.5 2.25 3.5 2.25-1.3 2.25-3.5 2.25-3.5-2.25-3.5-2.25z"/>' + dot(8, 8.5, 0.9),
  "format.sql": '<ellipse cx="8" cy="3.75" rx="5.5" ry="2"/><path d="M2.5 3.75v8.5c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2v-8.5M2.5 8c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2"/>',
  "format.xml": '<path d="M4.75 4.5L1.5 8l3.25 3.5M11.25 4.5L14.5 8l-3.25 3.5M9.25 3l-2.5 10"/>',
  // CONVERT
  "web.curl-code": '<rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M4.5 6.25L6.75 8 4.5 9.75M8.5 10.25h3"/>',
  "convert.jsx": '<path d="M4.5 4.5L1.5 8l3 3.5M7 8h7M11.5 5.5L14 8l-2.5 2.5"/>',
  "number.base": dot(3, 5) + '<path d="M6 5h4"/>' + dot(13, 5) + '<path d="M2 11h4"/>' + dot(8, 11) + '<path d="M10 11h4"/>',
  "text.case": '<path d="M3 2.5h1.5c.8 0 1.5.7 1.5 1.5v8c0 .8-.7 1.5-1.5 1.5H3M9 2.5H7.5C6.7 2.5 6 3.2 6 4M9 13.5H7.5c-.8 0-1.5-.7-1.5-1.5"/><path d="M12.5 3v10M10.75 4.75L12.5 3l1.75 1.75M10.75 11.25L12.5 13l1.75-1.75"/>',
  "time.unix": '<circle cx="8" cy="8" r="6"/><path d="M8 4.75V8l2.25 1.5"/>',
  "convert.yaml": '<path d="M9.5 1.5H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5z"/><path d="M5.5 7h5M9 5.5L10.5 7 9 8.5M10.5 11h-5M7 9.5L5.5 11 7 12.5"/>',
  // ENCODE
  "text.backslash": '<rect x="1.5" y="1.5" width="13" height="13" rx="2"/><path d="M5.75 4.5l4.5 7"/>',
  "encoding.base64-text": '<rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="9" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="2.5" y="9" width="4.5" height="4.5" rx="1"/><rect x="9" y="9" width="4.5" height="4.5" rx="1"/>',
  "encoding.base64-image": '<path d="M1 8h3.5M3 6.5L4.5 8 3 9.5"/><rect x="6" y="3" width="8.5" height="10" rx="1.5"/><path d="M6 11l2.75-2.75L11.5 11"/>' + dot(11.5, 6, 0.9),
  "encoding.hash": '<path d="M6.5 2.5l-1.5 11M11 2.5l-1.5 11M2.75 5.75h11M2.25 10.25h11"/>',
  "encoding.hex": '<path d="M8 1.75l5.4 3.13v6.24L8 14.25l-5.4-3.13V4.88z"/>',
  "text.html": '<path d="M13 13.5L5.8 6.3c-1-1-1-2.5.1-3.3 1-.7 2.6-.2 2.6 1.3 0 1.2-1.1 2-2.6 2.9C4.3 8 3 9 3 10.7c0 1.6 1.3 2.8 3.1 2.8 2.3 0 3.9-1.7 5.2-4.2"/>',
  "encoding.image-base64": '<rect x="1.5" y="3" width="8.5" height="10" rx="1.5"/><path d="M1.5 11l2.75-2.75L7 11"/>' + dot(7, 6, 0.9) + '<path d="M11.5 8H15M13.5 6.5L15 8l-1.5 1.5"/>',
  "text.json-string": dot(4.5, 5.75, 1.75) + dot(11, 5.75, 1.75) + '<path d="M6.25 5.75c0 2.7-1.3 4.6-3.5 5.5M12.75 5.75c0 2.7-1.3 4.6-3.5 5.5"/>',
  "text.unicode": '<circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c1.7 1.7 2.6 3.7 2.6 6S9.7 12.3 8 14c-1.7-1.7-2.6-3.7-2.6-6S6.3 3.7 8 2z"/>',
  "text.url": '<g transform="rotate(-45 8 8)"><rect x="1" y="6" width="7.5" height="4" rx="2"/><rect x="7.5" y="6" width="7.5" height="4" rx="2"/></g>',
  // TEXT
  "text.find-replace": '<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/>',
  "text.lines": '<path d="M2 3.5h7M2 8h5M2 12.5h3M12 3v10M10 11l2 2 2-2"/>',
  "text.regex": '<path d="M11 2v6M8.4 3.5l5.2 3M8.4 6.5l5.2-3"/>' + dot(4.25, 11.75, 1.25),
  "text.compare": '<path d="M2 2.5v11M14 2.5v11M5 6h6M9.5 4.5L11 6 9.5 7.5M11 10H5M6.5 8.5L5 10l1.5 1.5"/>',
  "text.inspect": '<path d="M9 13.5V2.5M12 13.5V2.5M13.5 2.5H7a3 3 0 0 0 0 6h2"/>',
  // WEB & SECURITY
  "security.jwt": '<circle cx="5" cy="11" r="3"/><path d="M7.25 8.75L13.5 2.5M11.25 4.75l2 2M9.5 6.5l1.5 1.5"/>',
  "web.url-parser": '<g transform="rotate(-45 5.5 10.5)"><rect x="1" y="8.75" width="5" height="3.5" rx="1.75"/><rect x="5" y="8.75" width="5" height="3.5" rx="1.75"/></g><path d="M10 3.25a2 2 0 1 1 2.75 1.85c-.45.2-.75.6-.75 1.1v.3"/>' + dot(12, 9, 0.9),
  // GENERATE
  "generate.examples": '<path d="M2.5 3h11v8H8.5l-3 2.5V11h-3z"/>' + dot(5.5, 7, 0.9) + dot(8, 7, 0.9) + dot(10.5, 7, 0.9),
  "media.qr": '<rect x="2" y="2" width="4.5" height="4.5" rx=".75"/><rect x="9.5" y="2" width="4.5" height="4.5" rx=".75"/><rect x="2" y="9.5" width="4.5" height="4.5" rx=".75"/>' + cell(9.25, 9.25) + cell(12.25, 9.25) + cell(10.75, 10.75) + cell(9.25, 12.25) + cell(12.25, 12.25),
  "media.qr-reader": '<path d="M1.5 5V2.5a1 1 0 0 1 1-1H5M11 1.5h2.5a1 1 0 0 1 1 1V5M14.5 11v2.5a1 1 0 0 1-1 1H11M5 14.5H2.5a1 1 0 0 1-1-1V11"/>' + cell(4.5, 4.5, 2.5) + cell(9, 4.5, 2.5) + cell(4.5, 9, 2.5) + cell(9.5, 9.5, 1.5),
  "identity.uuid": '<rect x="1.5" y="3" width="13" height="10" rx="1.5"/><circle cx="5.5" cy="7" r="1.5"/><path d="M3.5 10.5c.4-.9 1.1-1.4 2-1.4s1.6.5 2 1.4M9.5 6.5h3M9.5 9.5h3"/>',
};

const svg = (body: string): string =>
  `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;

/** Whether this tool has a drawn mark of its own (otherwise it gets the generic document). */
export const hasToolIcon = (id: string | undefined): boolean => !!id && Object.hasOwn(ICONS, id);

/** The tool's icon as inline SVG markup; an unknown id gets the generic document. */
export const toolIcon = (id: string | undefined): string => svg(hasToolIcon(id) ? ICONS[id!]! : GENERIC);

/** Every tool id with a drawn mark, for tests and previews. */
export const toolIconIds = (): string[] => Object.keys(ICONS);
