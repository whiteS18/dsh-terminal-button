/**
 * Where the DSH Host HTTP/WebSocket origin lives, as seen by the client half.
 *
 * The Host always binds loopback, but its port is not fixed: DSH Desktop starts
 * it with `--port 0` (an ephemeral port) as of 0.2. The renderer loads from
 * `dsh-app://app`, whose document origin cannot be used as a WebSocket base, so
 * the Host origin has to come from the boot payload:
 *
 *   - DSH >= 0.2 Desktop: `globalThis.__DSH_TRANSPORT__.streamBaseUrl`, set by
 *     the Web app from `dshDesktopBoot.ready()` before any client plugin is
 *     instantiated. (`window.__DSH_BOOT__` is NOT the app boot payload there —
 *     since 0.2 it is the client module graph and carries no URL.)
 *   - DSH <= 0.1.x Desktop: `window.__DSH_BOOT__.webUrl | url | origin`.
 *   - The IPC boot payload itself, for a shell that only exposes it async.
 *   - 19387 was the fixed Desktop Host port before 0.2. Kept only as the last
 *     resort for a shell that exposes none of the above; never prefer it over
 *     a live payload, or the terminal dials a dead port after a Host restart.
 *
 * Plain `dsh web`/browser tabs are served from the Host origin itself, so
 * `location.origin` is already correct there.
 */

const HTTP_BASE = /^https?:\/\//i

/** @param {unknown} value @returns {string | undefined} a slash-free http(s) base. */
function httpBase(value) {
  if (typeof value !== 'string' || !HTTP_BASE.test(value)) return undefined
  return value.replace(/\/+$/, '')
}

/**
 * Synchronous part of the resolution.
 *
 * @param {any} scope - a Window-like object (`globalThis` in the bundle).
 * @returns {string | undefined} the Host origin, or undefined when the scope
 *   carries none and the async boot payload has to be consulted.
 */
export function loopbackBaseFrom(scope) {
  const location = scope?.location
  if (!location || location.protocol !== 'dsh-app:') {
    // Browser/web: the document origin is the Host origin.
    return httpBase(location?.origin) ?? (location?.origin || undefined)
  }
  const fromTransport = httpBase(scope?.__DSH_TRANSPORT__?.streamBaseUrl)
  if (fromTransport) return fromTransport
  const boot = scope?.__DSH_BOOT__
  return httpBase(boot?.webUrl) ?? httpBase(boot?.url) ?? httpBase(boot?.origin)
}

/**
 * Resolve the Host origin, falling back to the Desktop IPC boot payload.
 *
 * @param {any} scope - a Window-like object.
 * @returns {Promise<string>} the Host origin (never empty).
 */
export async function resolveLoopbackBase(scope) {
  const known = loopbackBaseFrom(scope)
  if (known) return known
  const desktopBoot = scope?.dshDesktopBoot
  if (typeof desktopBoot?.ready === 'function') {
    try {
      const payload = await desktopBoot.ready()
      const fromIpc = httpBase(payload?.streamBaseUrl)
      if (fromIpc) return fromIpc
    } catch { /* older shell without the boot channel */ }
  }
  return 'http://127.0.0.1:19387'
}

/**
 * Turn an http(s) Host base plus a path into an absolute ws(s) URL.
 *
 * @param {string} base - Host origin, with or without a trailing slash.
 * @param {string} path - absolute route (`/dsh-terminal/pty?...`).
 * @returns {string} the WebSocket URL.
 */
export function webSocketUrl(base, path) {
  const origin = httpBase(base)
  if (!origin) throw new Error(`invalid terminal host base: ${String(base)}`)
  return `${origin.replace(/^http/i, 'ws')}${path}`
}
