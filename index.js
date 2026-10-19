/**
 * dsh-terminal-button — Host half (static bundle).
 *
 * An extension of DeepSeek Harness's official terminal (DSH >= 0.2.1), not a
 * second terminal implementation. It does not spawn a PTY and serves no
 * WebSocket: the official `@deepseek-ai/dsh-api-terminal-controller` owns the
 * terminal processes and the official sidebar-terminal client owns the screen.
 * What this half adds:
 *
 *  - Desktop "open terminal" redirection. Tray, settings-page and titlebar
 *    entry points funnel through the Desktop runtime's `openTerminal`, so one
 *    method patch covers them all: in the 'bottom' placement it broadcasts an
 *    SSE `open` frame to connected clients (the client half reveals the
 *    bottom panel), and in the 'external' placement it falls through to the
 *    original system-terminal window. `/dsh-terminal/open-native` is the
 *    explicit escape hatch.
 *  - The `dsh` CLI shim. Desktop has no `dsh` executable on PATH (the CLI
 *    lives inside `app.asar`), and the official terminal only forwards
 *    `DSH_SESSION_ID` in the spawn env. Patching `subprocess.spawnTerminal`
 *    once — rather than owning a PTY — puts the shim directory on PATH for
 *    every official terminal, sidebar and bottom panel alike, without
 *    re-injecting any `DSH_*` variable.
 *
 * Routes: `GET /dsh-terminal/events` (SSE open intents),
 * `POST /dsh-terminal/open-native` (system window), `GET /dsh-terminal/health`.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, sep } from 'node:path'

// Resolved from the DSH install anchor at runtime; absent in bare test
// environments, where settings registration is simply skipped.
const Schema = await import('@deepseek-ai/schemastery').then((m) => m.default ?? m, () => null)

export const name = 'dsh-terminal-button'

export const inject = ['webServer', 'subprocess']

const SETTINGS_NAMESPACE = 'dsh-terminal-button'

/**
 * Mark a schema field volatile so DSH settings.describe() serves it and
 * Loader hot-commits writes. Prefer `.volatile()` (schemastery >= 3.18.4).
 * Older copies used to ship with this plugin had `.extra()` but no
 * `.volatile()`, which left `position` as ordinary config: the Plugins
 * page never listed the entry, and the placement control disappeared.
 */
const markVolatile = (schema) => {
  if (!schema) return schema
  if (typeof schema.volatile === 'function') {
    try {
      return schema.volatile()
    } catch {
      return schema
    }
  }
  if (typeof schema.extra === 'function') return schema.extra('volatile', true)
  if (schema.meta) schema.meta.volatile = true
  return schema
}

/**
 * Stored placements. `sidebar` is accepted for profiles written by <= 0.3.x
 * (this plugin's own sidebar tab); the official sidebar terminal now owns
 * that surface, so it normalizes to the bottom panel.
 */
const positions = ['sidebar', 'bottom', 'external']
const positionSchema = Schema
  ? markVolatile(Schema.union(positions).default('bottom'))
  : undefined

const SettingsSchema = Schema?.object({
  // 'bottom' renders the official terminal in the in-app bottom panel;
  // 'external' lets the Desktop-native system terminal window open instead.
  position: positionSchema,
})

/**
 * Cordis Config for this plugin's loader entry (DSH >= 0.1.6). The settings
 * service no longer accepts imperative namespace registration there; the
 * volatile `position` field is the same setting, served to the Plugins page
 * form and hot-committed into this fiber on every write.
 */
export const Config = SettingsSchema
  ? Schema.object({ position: positionSchema })
  : undefined

/** SSE channel pushing "open panel" intents to connected clients. */
const EVENTS_PATH = '/dsh-terminal/events'
/** Explicit escape hatch: always spawn the Desktop system terminal window. */
const OPEN_NATIVE_PATH = '/dsh-terminal/open-native'
/** Liveness probe so a browser request confirms the Host half loaded. */
const HEALTH_PATH = '/dsh-terminal/health'

// ---------------------------------------------------------------------------
// `dsh` CLI shim
// ---------------------------------------------------------------------------

/**
 * How to invoke the `dsh` CLI from a shell that no longer has `DSH_*`.
 *
 * A normal install exposes `dsh` on PATH. Desktop does not: the GUI is
 * Electron, and the CLI entry (`@deepseek-ai/dsh/lib/bin.js`) lives inside
 * `app.asar`. The Host reaches it as `process.argv[1]`, which is
 * `…/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js`.
 * `scrubbedParentEnv` then strips `DSH_EXECUTABLE` and
 * `DSH_DESKTOP_NODE_EXECUTABLE`, so neither the CLI nor the `node.cmd` shim
 * in `resources/runtime/bin` survives into the PTY. Re-forwarding those
 * variables would undo the scrub, so the wrapper bakes the two absolute
 * paths in instead.
 *
 * @returns {{ command: string, prefix: string[] } | undefined}
 */
function dshInvocation() {
  const executable = process.env.DSH_EXECUTABLE
  if (typeof executable === 'string' && executable && existsSync(executable)) {
    return { command: executable, prefix: [] }
  }
  const entry = process.argv[1]
  const marker = `${sep}app.asar${sep}`
  const index = typeof entry === 'string' ? entry.indexOf(marker) : -1
  if (index < 0) return undefined
  // The CLI entry is a virtual file inside the asar. Electron executes it,
  // but Node's existsSync only sees the archive itself.
  const archive = entry.slice(0, index) + `${sep}app.asar`
  const node = process.execPath
  if (!existsSync(archive) || !existsSync(node)) return undefined
  const cli = join(archive, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  return { command: node, prefix: ['--expose-internals', cli] }
}

/** Cached shim directory, including a cached "unavailable" result. */
let shimDirCache

/**
 * Directory containing a `dsh` the PTY can run after `DSH_*` is stripped.
 * @returns {string | undefined}
 */
function dshShimDir() {
  if (shimDirCache !== undefined) return shimDirCache || undefined
  const invocation = dshInvocation()
  if (!invocation) {
    shimDirCache = ''
    return undefined
  }
  const dir = join(tmpdir(), 'dsh-terminal-bin')
  const quote = (value) => `"${value}"`
  try {
    mkdirSync(dir, { recursive: true })
    if (process.platform === 'win32') {
      const args = [...invocation.prefix.map(quote), '%*'].join(' ')
      writeFileSync(
        join(dir, 'dsh.cmd'),
        `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n${quote(invocation.command)} ${args}\r\n`,
      )
    } else {
      const args = [...invocation.prefix.map(quote), '"$@"'].join(' ')
      writeFileSync(
        join(dir, 'dsh'),
        `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexec ${quote(invocation.command)} ${args}\n`,
        { mode: 0o755 },
      )
    }
    shimDirCache = dir
    return dir
  } catch {
    shimDirCache = ''
    return undefined
  }
}

let loginPathResolved = false
let cachedLoginPath

/**
 * Ask the login shell which PATH the user actually has. The Host process is
 * an Electron utility process: its PATH is the bare system PATH and never
 * sees user-profile additions (mise shims, nvm, cargo, …). POSIX login
 * shells source those profiles; Windows does not, so the PTY shell is
 * started as a login shell there instead.
 */
function loginPath() {
  if (loginPathResolved) return cachedLoginPath
  loginPathResolved = true
  if (process.platform === 'win32') return undefined
  const shell = process.env.SHELL || '/bin/bash'
  try {
    const result = spawnSync(shell, ['-lc', 'printf %s "$PATH"'], {
      encoding: 'utf8',
      timeout: 4000,
      windowsHide: true,
    })
    const path = result.stdout?.trim()
    if (result.status === 0 && path) cachedLoginPath = path
  } catch { /* login shell unavailable; keep the inherited PATH */ }
  return cachedLoginPath
}

let terminalPathCache

/** PATH pieces used for every terminal spawn, resolved once per Host run. */
function terminalPathParts() {
  if (terminalPathCache !== undefined) return terminalPathCache
  const shimDir = dshShimDir()
  const fallbackPath = process.platform === 'win32'
    ? (process.env.Path ?? process.env.PATH ?? '')
    : (loginPath() ?? process.env.PATH ?? '')
  terminalPathCache = { shimDir: shimDir ?? '', fallbackPath }
  return terminalPathCache
}

/**
 * Put the `dsh` shim directory first on a terminal spawn environment.
 *
 * A caller-provided PATH is kept (the shim is only prepended); otherwise the
 * login/user PATH is used so version-manager shims still resolve. PATH is the
 * only lever: the subprocess service merges this explicit env over the
 * scrubbed parent environment, so no `DSH_*` fact is forwarded.
 *
 * @param {unknown} env - caller-provided terminal environment.
 * @param {{ shimDir?: string, fallbackPath?: string }} parts - PATH sources.
 * @param {string} [platform] - target platform (injectable for tests).
 * @returns {Record<string, string | undefined>} the patched environment.
 */
export function withTerminalPath(env, parts = {}, platform = process.platform) {
  const base = env !== null && typeof env === 'object' ? { ...env } : {}
  const shimDir = typeof parts.shimDir === 'string' ? parts.shimDir : ''
  if (shimDir === '') return base
  const existingKey = Object.keys(base).find((key) => key.toUpperCase() === 'PATH')
  const existing = existingKey === undefined ? undefined : base[existingKey]
  for (const key of Object.keys(base)) if (key.toUpperCase() === 'PATH') delete base[key]
  const rest = typeof existing === 'string' && existing !== ''
    ? existing
    : (typeof parts.fallbackPath === 'string' ? parts.fallbackPath : '')
  base[platform === 'win32' ? 'Path' : 'PATH'] = rest === '' ? shimDir : `${shimDir}${delimiter}${rest}`
  return base
}

/**
 * Add the `dsh` shim to every Host terminal through the one spawn primitive
 * the official terminal controller uses. Patched once per Host run and
 * restored when this fiber unloads.
 */
function installTerminalPath(ctx) {
  ctx.effect(() => {
    const service = ctx.subprocess
    const original = service?.spawnTerminal
    if (typeof original !== 'function' || original.__dshTerminalButtonPatched) return undefined
    const patched = function patchedSpawnTerminal(spec) {
      if (spec === null || typeof spec !== 'object') return original.apply(this, arguments)
      const parts = terminalPathParts()
      if (parts.shimDir === '') return original.apply(this, arguments)
      const env = withTerminalPath(spec.env, parts)
      return original.apply(this, [{ ...spec, env }])
    }
    patched.__dshTerminalButtonPatched = true
    service.spawnTerminal = patched
    return () => {
      if (service.spawnTerminal === patched) service.spawnTerminal = original
    }
  }, 'dsh-terminal-button: terminal PATH')
}

// ---------------------------------------------------------------------------
// Desktop openTerminal interception + client notification (SSE)
// ---------------------------------------------------------------------------

/** Live SSE response objects, one per connected browser client. */
const sseClients = new Set()

/** Tell every connected client to reveal the in-app terminal panel. */
function broadcastOpen() {
  for (const res of [...sseClients]) {
    try {
      res.write('data: open\n\n')
    } catch {
      sseClients.delete(res)
    }
  }
}

/** Owner scope of this plugin's settings namespace (DSH <= 0.1.5); null otherwise. */
let settingsScope = null

/** The Desktop runtime's original openTerminal + its owner, once patched. */
let nativeOpenTerminal = null

/** This fiber's loader config (DSH >= 0.1.6 carries the volatile position box). */
let liveConfig = undefined

/**
 * Unwrap one config field that may be a live Volatile reference (DSH >= 0.1.6
 * hot-commits volatile writes into the box) or a plain value.
 */
function unwrapVolatile(value) {
  if (value && typeof value === 'object' && typeof value.get === 'function') {
    try { return value.get() } catch { return undefined }
  }
  return value
}

/** Normalized placement: only 'external' changes the Host behavior. */
function currentPosition() {
  try {
    const value = settingsScope
      ? settingsScope.get()?.position
      : unwrapVolatile(liveConfig?.position)
    return value === 'external' ? 'external' : 'bottom'
  } catch {
    return 'bottom'
  }
}

/**
 * Redirect every Desktop "open terminal" entry point (titlebar chrome IPC,
 * tray item, settings page, /api/desktop/terminal/open) into the in-app
 * panel. All of them funnel through the same host-side `desktopRuntime`
 * service object, so one method patch covers the whole surface. With
 * position = 'external' the call falls through to the original behavior.
 * Dormant in a plain `dsh web` boot, where desktopRuntime never appears.
 */
function installDesktopInterception(ctx) {
  ctx.inject(['desktopRuntime'], (desktopCtx) => {
    desktopCtx.effect(() => {
      const runtime = desktopCtx.desktopRuntime
      const original = runtime.openTerminal
      if (typeof original !== 'function' || original.__dshTerminalPatched) return undefined
      const patched = function patchedOpenTerminal(...args) {
        if (currentPosition() === 'external') return original.apply(runtime, args)
        broadcastOpen()
        return undefined
      }
      patched.__dshTerminalPatched = true
      runtime.openTerminal = patched
      nativeOpenTerminal = () => original.apply(runtime)
      return () => {
        if (runtime.openTerminal === patched) runtime.openTerminal = original
        nativeOpenTerminal = null
      }
    }, 'dsh-terminal-button: intercept desktopRuntime.openTerminal')
  })
}

// ---------------------------------------------------------------------------
// Cordis entry
// ---------------------------------------------------------------------------

export function apply(ctx, config) {
  liveConfig = config
  // DSH <= 0.1.5: register the settings namespace so `settings.yaml` sections
  // and the client-side settingsScope mirror can resolve `position`. The owner
  // scope also feeds the host-side interception gate.
  // DSH >= 0.1.6 removed `settings.register`: the volatile Config field above
  // carries `position`, and currentPosition() reads its live box.
  if (SettingsSchema) {
    ctx.inject(['settings'], (settingsCtx) => {
      if (typeof settingsCtx.settings?.register !== 'function') return undefined
      settingsScope = settingsCtx.settings.register(SETTINGS_NAMESPACE, SettingsSchema)
      return () => {
        settingsScope = null
      }
    })
  }

  installDesktopInterception(ctx)
  installTerminalPath(ctx)

  // SSE channel: the patched desktopRuntime.openTerminal broadcasts 'open'
  // here; the client bundle listens and reveals the panel.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: EVENTS_PATH,
    handler: (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD' })
        res.end('method not allowed')
        return
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      res.write(': connected\n\n')
      sseClients.add(res)
      const heartbeat = setInterval(() => {
        try {
          res.write(': ping\n\n')
        } catch { /* closed */ }
      }, 30000)
      req.on('close', () => {
        clearInterval(heartbeat)
        sseClients.delete(res)
      })
    },
  }))
  ctx.effect(() => () => {
    for (const res of [...sseClients]) {
      sseClients.delete(res)
      try {
        res.end()
      } catch { /* already closed */ }
    }
  })

  // Escape hatch for the plugin's own controls in 'external' mode: always
  // spawns the Desktop system terminal window, bypassing the interception.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: OPEN_NATIVE_PATH,
    handler: (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' })
        res.end('method not allowed')
        return
      }
      res.setHeader('content-type', 'application/json; charset=utf-8')
      if (!nativeOpenTerminal) {
        res.writeHead(404)
        res.end(JSON.stringify({ ok: false, error: 'desktop runtime unavailable' }))
        return
      }
      try {
        nativeOpenTerminal()
        res.writeHead(200)
        res.end(JSON.stringify({ ok: true }))
      } catch (error) {
        res.writeHead(500)
        res.end(JSON.stringify({ ok: false, error: String(error?.message ?? error) }))
      }
    },
  }))

  // Liveness probe so `curl http://127.0.0.1:<port>/dsh-terminal/health`
  // (or a browser fetch) confirms the plugin made it into the bundle.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: HEALTH_PATH,
    handler: async (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, name }))
    },
  }))
}
