/**
 * dsh-terminal-button — Host half (static bundle).
 *
 * Replaces DSH's "open a system terminal window" affordance with an in-app
 * terminal: the browser client bundle mounts an xterm.js panel in the right
 * sidebar and talks to this host over a same-origin WebSocket registered on
 * the DSH web server (`registerUpgrade`, path `/dsh-terminal/pty`).
 *
 * Wire protocol (per connection):
 *   client -> host  text JSON:  { type: 'input', data } | { type: 'resize', cols, rows }
 *   host  -> client binary:     raw PTY output chunks (UTF-8)
 *   host  -> client text JSON:  { type: 'ready', cwd, shell, pid }
 *                               { type: 'exit', exitCode, signal }
 *                               { type: 'error', message }
 *
 * The PTY is spawned through DSH's own `subprocess` service
 * (`ctx.subprocess.spawnTerminal`, backed by node-pty/ConPTY), so no native
 * dependency is bundled with this plugin. The shell's cwd is resolved
 * server-side from the connecting session id — the session workspace root,
 * never the DSH profile directory: live in-memory session first, then the
 * persisted session log via `sessionQuery`, then the client-supplied hint,
 * then the sandbox workspace root, and finally process.cwd().
 *
 * Deliberately dependency-free: the WebSocket framing is implemented on top
 * of the raw upgrade socket with only node:crypto, mirroring
 * dsh-handoff-button's "no runtime deps" stance so the bundle profile needs
 * nothing beyond this package.
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, sep } from 'node:path'
import { encodeFrame, FrameParser } from './frames.js'

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

const positionSchema = Schema
  ? markVolatile(Schema.union(['sidebar', 'bottom', 'external']).default('sidebar'))
  : undefined

/** Client placement setting; user layer lives in $DSH_HOME/settings.yaml (<= 0.1.5). */
const SettingsSchema = Schema?.object({
  // Where "open terminal" goes: an in-app panel ('sidebar' | 'bottom') or
  // the Desktop-native system terminal window ('external'). The host half
  // reads this to gate its desktopRuntime.openTerminal interception.
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

const UPGRADE_PATH = '/dsh-terminal/pty'
const HEALTH_PATH = '/dsh-terminal/health'
/** SSE channel pushing "open panel" intents to connected clients. */
const EVENTS_PATH = '/dsh-terminal/events'
/** Explicit escape hatch: always spawn the Desktop system terminal window. */
const OPEN_NATIVE_PATH = '/dsh-terminal/open-native'
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
/** Reject absurd terminal geometries from a confused client. */
const MAX_COLS = 500
const MAX_ROWS = 200
/**
 * PSReadLine disables its ListView prediction and warns at every prompt when
 * the console window is smaller than 50x5. The client floors its geometry at
 * this minimum; enforce it host-side too so a stale/foreign client can never
 * spawn or shrink a PTY below it.
 */
const MIN_COLS = 50
const MIN_ROWS = 5

// ---------------------------------------------------------------------------
// Minimal RFC 6455 framing (server side: accepts masked client frames,
// emits unmasked server frames, assembles fragmented messages).
// ---------------------------------------------------------------------------

function acceptKey(key) {
  return createHash('sha1').update(key + WS_GUID).digest('base64')
}

// ---------------------------------------------------------------------------
// Shell / cwd resolution
// ---------------------------------------------------------------------------

function clampDimension(value, max, fallback) {
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1 || n > max) return fallback
  return n
}

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

/**
 * Directory containing a `dsh` the PTY can run after `DSH_*` is stripped.
 * @returns {string | undefined}
 */
function dshShimDir() {
  const invocation = dshInvocation()
  if (!invocation) return undefined
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
    return dir
  } catch {
    return undefined
  }
}

/**
 * Ask the login shell which PATH the user actually has. The Host process is
 * an Electron utility process: its PATH is the bare system PATH and never
 * sees user-profile additions (mise shims, nvm, cargo, …). POSIX login
 * shells source those profiles; Windows does not, so the PTY shell is
 * started as a login shell there instead.
 */
function loginPath() {
  if (process.platform === 'win32') return undefined
  const shell = process.env.SHELL || '/bin/bash'
  try {
    const result = spawnSync(shell, ['-lc', 'printf %s "$PATH"'], {
      encoding: 'utf8',
      timeout: 4000,
      windowsHide: true,
    })
    const path = result.stdout?.trim()
    if (result.status === 0 && path) return path
  } catch { /* login shell unavailable; keep the inherited PATH */ }
  return undefined
}

/**
 * Environment for the interactive shell.
 *
 * `scrubbedParentEnv` drops `DSH_*` (so harness secrets never leak) but that
 * also drops `DSH_EXECUTABLE`, which is how `dsh` finds itself. Put that
 * launcher back on PATH. On POSIX, also replace PATH with the login shell's
 * PATH so version managers installed in the user profile resolve.
 */
function shellEnv() {
  const env = { ...process.env, TERM: 'xterm-256color', DSH_TERMINAL: '1' }
  const shimDir = dshShimDir()
  if (shimDir) {
    const inherited = env.PATH || env.Path || ''
    const dirs = inherited.split(delimiter).filter((dir) => dir && dir !== shimDir)
    env.PATH = [shimDir, ...dirs].join(delimiter)
    if (process.platform === 'win32') env.Path = env.PATH
  }
  if (process.platform !== 'win32') {
    const path = loginPath()
    if (path) {
      env.PATH = shimDir ? [shimDir, path].join(delimiter) : path
    }
  }
  return env
}

function pickShell(query) {
  const override = query.get('shell') || process.env.DSH_TERMINAL_SHELL
  if (override) {
    const named = {
      powershell: { argv: ['powershell.exe', '-NoLogo'] },
      pwsh: { argv: ['pwsh.exe', '-NoLogo'] },
      cmd: { argv: ['cmd.exe'] },
      bash: { argv: ['bash', '-l'] },
    }
    const hit = named[override.toLowerCase()]
    if (hit) return hit
    return { argv: [override] }
  }
  if (process.platform === 'win32') {
    // Windows PowerShell 5.1 is what prints the user's PS5 profile banner
    // ("ep=enable | dp=disable | pstat=status") and lacks the PS7 profile's
    // PATH additions. Prefer PowerShell 7 when it is installed.
    const pwsh = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe')
    if (existsSync(pwsh)) return { argv: [pwsh, '-NoLogo'] }
    return { argv: ['pwsh.exe', '-NoLogo'] }
  }
  return { argv: [process.env.SHELL || '/bin/bash', '-l'] }
}

async function resolveCwd(ctx, sessionId, hint) {
  if (sessionId) {
    try {
      const sessions = ctx.get('sessions')
      const session = sessions?.get?.(sessionId)
      const cwd = session?.header?.cwd ?? session?.cwd
      if (typeof cwd === 'string' && cwd) return cwd
    } catch { /* service absent or session not live */ }
    try {
      const sessionQuery = ctx.get('sessionQuery')
      const log = await sessionQuery?.readSession?.(sessionId)
      const cwd = log?.session?.cwd ?? log?.session?.header?.cwd ?? log?.header?.cwd
      if (typeof cwd === 'string' && cwd) return cwd
    } catch { /* no persisted log */ }
  }
  if (typeof hint === 'string' && hint) return hint
  try {
    const sandboxPolicy = ctx.get('sandboxPolicy')
    if (typeof sandboxPolicy?.workspaceRoot === 'string' && sandboxPolicy.workspaceRoot) {
      return sandboxPolicy.workspaceRoot
    }
  } catch { /* fall through */ }
  return process.cwd()
}

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------

function sendJson(socket, message) {
  if (socket.destroyed) return
  socket.write(encodeFrame(0x1, Buffer.from(JSON.stringify(message), 'utf8')))
}

function sendBinary(socket, chunk) {
  if (socket.destroyed) return false
  return socket.write(encodeFrame(0x2, chunk))
}

async function handleConnection(ctx, req, socket, head) {
  const key = req.headers['sec-websocket-key']
  if (!key || String(req.headers.upgrade).toLowerCase() !== 'websocket') {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
    socket.destroy()
    return
  }
  // The SPA is same-origin with this server; refuse cross-site hijacking
  // attempts that present a foreign Origin header.
  const origin = req.headers.origin
  if (origin) {
    try {
      if (new URL(origin).host !== req.headers.host) throw new Error('origin mismatch')
    } catch {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
  }

  const url = new URL(req.url, 'http://dsh.internal')
  const query = url.searchParams
  const sessionId = query.get('sessionId') || ''
  const cwd = await resolveCwd(ctx, sessionId, query.get('cwd'))
  const { argv } = pickShell(query)
  const cols = Math.max(MIN_COLS, clampDimension(query.get('cols'), MAX_COLS, 80))
  const rows = Math.max(MIN_ROWS, clampDimension(query.get('rows'), MAX_ROWS, 24))

  let handle
  try {
    handle = await ctx.subprocess.spawnTerminal({
      argv,
      cwd,
      cols,
      rows,
      // DSH >= 0.1.6 requires terminalType; older runtimes ignore it.
      terminalType: 'xterm-256color',
      env: shellEnv(),
    })
  } catch (error) {
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
    )
    sendJson(socket, { type: 'error', message: `failed to spawn shell: ${error?.message ?? error}` })
    socket.end(encodeFrame(0x8, Buffer.alloc(0)))
    return
  }

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
  )

  const parser = new FrameParser()
  if (head?.length) parser.push(head) // normally empty
  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    handle.output.removeAllListeners('data')
    handle.terminate().catch(() => {})
    if (!socket.destroyed) socket.destroy()
  }

  handle.output.on('data', (chunk) => {
    const flushed = sendBinary(socket, chunk)
    if (!flushed) {
      handle.output.pause()
      socket.once('drain', () => handle.output.resume())
    }
  })
  handle.done.then(
    ({ exitCode, signal }) => {
      if (!socket.destroyed) {
        sendJson(socket, { type: 'exit', exitCode, signal })
        socket.end(encodeFrame(0x8, Buffer.alloc(0)))
      }
      cleaned = true
    },
    () => {},
  )

  sendJson(socket, { type: 'ready', cwd, shell: argv[0], pid: handle.pid })

  socket.on('data', (chunk) => {
    let messages
    try {
      messages = parser.push(chunk)
    } catch {
      cleanup()
      return
    }
    for (const message of messages) {
      if (message.opcode === 0x8) {
        cleanup()
        return
      }
      if (message.opcode === 0x9) {
        if (!socket.destroyed) socket.write(encodeFrame(0xA, message.payload))
        continue
      }
      if (message.opcode !== 0x1 && message.opcode !== 0x2) continue
      let decoded
      try {
        decoded = JSON.parse(message.payload.toString('utf8'))
      } catch {
        continue
      }
      if (decoded?.type === 'input' && typeof decoded.data === 'string') {
        handle.write(decoded.data).catch(() => {})
      } else if (decoded?.type === 'resize') {
        const nextCols = Math.max(MIN_COLS, clampDimension(decoded.cols, MAX_COLS, cols))
        const nextRows = Math.max(MIN_ROWS, clampDimension(decoded.rows, MAX_ROWS, rows))
        // DSH <= 0.1.5 nested the pty on handle.terminal; 0.1.7 exposes resize
        // directly on the terminal handle.
        const resize = typeof handle.resize === 'function'
          ? handle.resize.bind(handle)
          : handle.terminal?.resize?.bind(handle.terminal)
        if (!resize) continue
        Promise.resolve(resize(nextCols, nextRows)).catch(() => { /* pty already gone */ })
      }
    }
  })
  socket.on('error', cleanup)
  socket.on('close', cleanup)
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

function currentPosition() {
  try {
    if (settingsScope) return settingsScope.get()?.position ?? 'sidebar'
    return unwrapVolatile(liveConfig?.position) ?? 'sidebar'
  } catch {
    return 'sidebar'
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
  // carries `position` instead, and currentPosition() reads its live box.
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

  // Escape hatch for the plugin's own buttons in 'external' mode: always
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

  ctx.effect(() => ctx.webServer.registerUpgrade({
    path: UPGRADE_PATH,
    handler: (req, socket, head) => {
      handleConnection(ctx, req, socket, head).catch((error) => {
        console.error('[dsh-terminal] connection failed:', error)
        socket.destroy()
      })
    },
  }))
}

export { encodeFrame, FrameParser } from './frames.js'

