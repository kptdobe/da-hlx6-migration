export function sanitizeName(name) {
  return name;
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
 * Reuses the source path exactly, without renaming folders or files.
 * @param {string} path absolute path starting with `/`
 * @returns {string}
 */
export function toHlx6Path(path) {
  return path;
}
