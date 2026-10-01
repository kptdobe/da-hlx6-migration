// Mirrors @adobe/helix-shared-string sanitizeName, used by helix-api-service for source keys.
export function sanitizeName(name) {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Splits a file name into basename and extension (extension includes the dot).
 * @param {string} name
 */
export function splitExt(name) {
  const idx = name.lastIndexOf('.');
  if (idx <= 0) return { base: name, ext: '' };
  return { base: name.slice(0, idx), ext: name.slice(idx) };
}

/**
 * Maps a da document path (e.g. `/My Folder/Hello_World.html`) to the path hlx6 stores.
 * Every folder segment and the basename are sanitized; the extension is lowercased.
 * @param {string} path absolute path starting with `/`
 * @returns {string}
 */
export function toHlx6Path(path) {
  const segments = path.split('/').slice(1);
  const file = segments.pop();
  const folders = segments.map(sanitizeName);
  const { base, ext } = splitExt(file);
  return `/${[...folders, `${sanitizeName(base)}${ext.toLowerCase()}`].join('/')}`;
}
