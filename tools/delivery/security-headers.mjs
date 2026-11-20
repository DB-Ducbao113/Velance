// Baseline for local preview and Ops endpoints. Not equivalent to public TLS,
// WAF, identity authentication or a reviewed browser isolation policy.
import { createHash } from 'node:crypto';

export const BASE_SECURITY_HEADERS = Object.freeze({
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), accelerometer=(), gyroscope=(), magnetometer=()'
});

export function applySecurityHeaders(res) {
  for (const [key, value] of Object.entries(BASE_SECURITY_HEADERS)) res.setHeader(key, value);
}

// Only one inline import map is approved. Other inline executable JS is
// rejected instead of adding unsafe-inline to script-src. A manifest SHA
// verification gate protects the source bytes in immutable delivery.
export function htmlCsp(html) {
  if (!Buffer.isBuffer(html) && typeof html !== 'string') throw new TypeError('HTML_BUFFER_REQUIRED');
  const source = html.toString('utf8');
  const tokens = [];
  let importMaps = 0;
  const matches = [...source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
  for (const [, attrs, content] of matches) {
    if (/\bsrc\s*=/i.test(attrs)) {
      if (content.trim()) throw new Error('SCRIPT_TAG_HAS_INLINE_BODY');
      continue;
    }
    const kind = /\btype\s*=\s*(['"])importmap\1/i.test(attrs);
    if (!kind || ++importMaps > 1 || !content.trim()) throw new Error('UNAPPROVED_INLINE_SCRIPT');
    tokens.push("'sha256-" + createHash('sha256').update(content).digest('base64') + "'");
  }
  // style-src unsafe-inline is currently required by GSAP styling, colour
  // swatches and third-party demo CSS; script-src remains hash-only.
  return [
    "default-src 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
    // WebAssembly.compile for vendored meshopt needs wasm-unsafe-eval, not
    // unsafe-eval (which would permit arbitrary JavaScript evaluation).
    ["script-src 'self' 'wasm-unsafe-eval'", ...tokens].join(' '),
    "style-src 'self' 'unsafe-inline'",
    "font-src 'none'",
    "img-src 'self' data: blob:",
    // GLTFLoader creates local blob URLs for embedded GLB textures and fetches
    // them through ImageBitmapLoader. Keep remote connections and blob scripts denied.
    "connect-src 'self' blob:",
    "worker-src 'self' blob:",
    "media-src 'self'",
    "manifest-src 'self'"
  ].join('; ');
}
