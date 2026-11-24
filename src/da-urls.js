const DA_URL = /(?:https?:)?\/\/(?:admin|content)\.da\.live(?::\d+)?\/[^\s"'<>\\]+/gi;
const JSON_STRING = /"(?:[^"\\]|\\[\s\S])*"/g;
const TEXT_TYPES = new Set(['text/html', 'application/json', 'image/svg+xml']);

/**
 * Separates closing markup punctuation from a URL, retaining balanced URL parentheses.
 * @param {string} candidate URL token embedded in text.
 * @returns {{url:string, suffix:string}} URL and untouched surrounding punctuation.
 */
function separatePunctuation(candidate) {
  let url = candidate;
  while (/[)\]},]$/.test(url)) {
    const closing = url.at(-1);
    if (closing === ',') {
      if (url.includes('?')) break;
    } else {
      const opening = { ')': '(', ']': '[', '}': '{' }[closing];
      if (url.split(closing).length <= url.split(opening).length) break;
    }
    url = url.slice(0, -1);
  }
  return { url, suffix: candidate.slice(url.length) };
}

/**
 * Rewrites same-source-site DA references to destination API routes.
 * Other sites/hosts remain unchanged; unmappable admin routes are returned for warnings.
 * @param {string} text Text containing absolute DA URLs.
 * @param {{org:string, daOrg?:string, daSite:string, hlx6Site:string}} scope Migration scope.
 * @returns {{value:string, rewrites:object[], unsupported:object[]}} Text and URL changes.
 */
export function rewriteDaUrls(text, scope) {
  const rewrites = [];
  const unsupported = [];
  const sourceOrg = (scope.daOrg || scope.org).toLowerCase();
  const sourceSite = scope.daSite.toLowerCase();
  const api = `https://api.aem.live/${scope.org}/sites/${scope.hlx6Site}`;
  const value = text.replace(DA_URL, (candidate, offset) => {
    const previous = text[offset - 1];
    const quoted = (previous === '"' || previous === "'") && text[offset + candidate.length] === previous;
    const { url: original, suffix } = candidate === text || quoted
      ? { url: candidate, suffix: '' } : separatePunctuation(candidate);
    const url = new URL(original, 'https://da.live');
    const parts = url.pathname.split('/').slice(1);
    const content = url.hostname === 'content.da.live';
    if (!content && parts[0] === 'api') parts.shift();
    const route = content ? 'content' : parts.shift();
    if (parts[0]?.toLowerCase() !== sourceOrg || parts[1]?.toLowerCase() !== sourceSite) {
      return candidate;
    }
    const path = parts.slice(2).join('/');
    let targetPath;
    if (content) {
      const document = !path || path.endsWith('/') ? `${path}index.html` : path;
      targetPath = `/source/${document.split('/').at(-1).includes('.') ? document : `${document}.html`}`;
    } else if (route === 'source') {
      targetPath = `/source/${path}`;
    } else if (route === 'list') {
      targetPath = `/source/${path}${path && !path.endsWith('/') ? '/' : ''}`;
    } else if (route === 'config' && !path) {
      targetPath = '/config/editor/da.json';
    } else {
      unsupported.push({ url: original, reason: `No URL-only mapping for DA admin route "${route}"` });
      return candidate;
    }
    const targetUrl = `${api}${targetPath}${url.search}${url.hash}`;
    rewrites.push({ url: original, targetUrl });
    return `${targetUrl}${suffix}`;
  });
  return { value, rewrites, unsupported };
}

/**
 * Rewrites HTML, SVG and JSON source bodies without modifying source buffers.
 * JSON string tokens are decoded individually, preserving formatting and numeric precision.
 * Binary media and generated audit records are not processed.
 * @param {{body:Buffer, contentType:string, sourceKey?:string, key:string}} object Planned object.
 * @param {{org:string, daOrg?:string, daSite:string, hlx6Site:string}} scope Migration scope.
 * @returns {{body:Buffer, rewrites:object[], unsupported:object[]}} Body and references.
 * @throws {Error} When a JSON string cannot be decoded.
 */
export function rewriteDaBody(object, scope) {
  const { body, contentType } = object;
  const rewrites = [];
  const unsupported = [];
  if (!TEXT_TYPES.has(contentType)) return { body, rewrites, unsupported };
  const text = body.toString('utf8');
  /**
   * Rewrites decoded text and accumulates its references.
   * @param {string} source Original text or decoded JSON string.
   * @returns {string} Rewritten text.
   */
  const rewrite = (source) => {
    const result = rewriteDaUrls(source, scope);
    rewrites.push(...result.rewrites);
    unsupported.push(...result.unsupported);
    return result.value;
  };
  const value = contentType === 'application/json'
    ? text.replace(JSON_STRING, (token) => {
      let source;
      try {
        source = JSON.parse(token);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        throw new Error(`Invalid JSON string in ${object.sourceKey || object.key}`, { cause: error });
      }
      const target = rewrite(source);
      return target === source ? token : JSON.stringify(target);
    })
    : rewrite(text);
  return { body: value === text ? body : Buffer.from(value, 'utf8'), rewrites, unsupported };
}
