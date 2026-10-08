export function sanitizeName(name) {
  const normalized = name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9_]+/g, '-')
    .replace(/^-|-$/g, '');
  return name.startsWith('.') && normalized ? `.${normalized}` : normalized;
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
 * Leading dots and underscores are preserved; other characters are normalized and extensions lowercased.
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
