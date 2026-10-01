const PATTERNS = [
  [/\b[0-9A-HJKMNP-TV-Z]{26}\b/g, '<ulid>'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>'],
  [/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<iso-date>'],
  [/\b1\d{12}\b/g, '<epoch-ms>'],
  [/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '<email>'],
  [/"[0-9a-f]{32}(-\d+)?"/g, '"<etag>"'],
];

/**
 * Replaces volatile values (ULIDs, UUIDs, dates, epochs, emails, ETags) with placeholders
 * so values from both backends can be compared structurally.
 * @param {string} value
 * @returns {string}
 */
export function normalizeValue(value) {
  return PATTERNS.reduce((v, [re, rep]) => v.replace(re, rep), String(value));
}

/**
 * Normalizes every value of a metadata object.
 * @param {Record<string,string>} metadata
 */
export function normalizeMetadata(metadata = {}) {
  return Object.fromEntries(Object.keys(metadata).sort()
    .map((k) => [k, normalizeValue(metadata[k])]));
}

/**
 * Normalizes an HTML string for semantic comparison (whitespace between tags collapsed).
 * @param {string} html
 */
export function normalizeHtml(html) {
  return html.replace(/>\s+</g, '><').replace(/\s+/g, ' ').trim();
}
