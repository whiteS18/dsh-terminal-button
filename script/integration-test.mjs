/**
 * End-to-end integration test for the host half, run manually:
 *
 *   node script/integration-test.mjs
 *
 * Boots a real HTTP server, mounts the plugin's upgrade handler with a stub
 * cordis ctx whose `subprocess.spawnTerminal` is backed by the node-pty copy
 * shipped inside the DSH Desktop install (N-API prebuild, loads in plain
 * Node), then drives it with Node's built-in WebSocket client:
 *
 *   connect -> expect {ready, cwd} -> send "echo" input -> expect echo in
 *   PTY output -> resize -> close -> expect PTY terminated.
 *
 * Exits 0 on success, 1 on failure.
 */
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'

const DSH_NODE_MODULES = process.env.DSH_NODE_MODULES
  ?? 'D:/DSH Desktop/resources/app/node_modules'
const requireFromDsh = createRequire(`${DSH_NODE_MODULES}/`)
const pty = requireFromDsh('node-pty')

const { default: pluginModule } = await import('../index.js').then((m) => ({ default: m }))
const { apply } = pluginModule

const failures = []
const check = (label, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) failures.push(label)
}

// --- stub cordis ctx -------------------------------------------------------
const upgradeHandlers = new Map()
const spawned = []
const ctx = {
  effect(fn) { const disposer = typeof fn === 'function' ? fn() : fn; return typeof disposer === 'function' ? disposer : () => {} },
  webServer: {
    register() { return () => {} },
    registerUpgrade(route) {
      upgradeHandlers.set(route.path, route.handler)
      return () => upgradeHandlers.delete(route.path)
    },
  },
  subprocess: {
    async spawnTerminal(spec) {
      console.log('spawnTerminal called', spec.argv[0], spec.cwd)
      const proc = pty.spawn(spec.argv[0], spec.argv.slice(1), {
        name: 'xterm-256color',
        cols: spec.cols ?? 80,
        rows: spec.rows ?? 24,
        cwd: spec.cwd,
        env: spec.env,
      })
      let resolveDone
      const done = new Promise((resolve) => { resolveDone = resolve })
      proc.onExit(({ exitCode, signal }) => resolveDone({ exitCode, signal }))
      const { PassThrough } = await import('node:stream')
      const output = new PassThrough()
      proc.onData((data) => output.write(Buffer.from(data, 'utf8')))
      const handle = {
        pid: proc.pid,
        output,
        done,
        terminal: proc,
        async write(data) { proc.write(data) },
        async terminate() { try { proc.kill() } catch { /* already dead */ } },
      }
      spawned.push(handle)
      return handle
    },
  },
  get() { return undefined },
}

apply(ctx)

// --- http server with upgrade wiring ---------------------------------------
const server = createServer((req, res) => {
  res.writeHead(404)
  res.end()
})
server.on('upgrade', (req, socket, head) => {
  const path = new URL(req.url, 'http://localhost').pathname
  const handler = upgradeHandlers.get(path)
  console.log('upgrade hit:', path, 'handler found:', !!handler)
  socket.on('error', (e) => console.log('socket error:', e.message))
  if (!handler) {
    socket.destroy()
    return
  }
  handler(req, socket, head)
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
console.log(`stub server on 127.0.0.1:${port}`)

// --- drive it with a real WebSocket client ----------------------------------
const ws = new WebSocket(
  `ws://127.0.0.1:${port}/dsh-terminal/pty?sessionId=fake-session&cwd=${encodeURIComponent('C:/Users/scw')}&cols=100&rows=30`,
)
ws.binaryType = 'arraybuffer'

let ready = null
let outputText = ''
let exited = null
const decoder = new TextDecoder()

ws.onmessage = (event) => {
  if (typeof event.data === 'string') {
    const control = JSON.parse(event.data)
    if (control.type === 'ready') ready = control
    if (control.type === 'exit') exited = control
    if (control.type === 'error') {
      console.error('host error frame:', control.message)
      process.exit(1)
    }
    return
  }
  outputText += decoder.decode(event.data, { stream: true })
}
ws.onerror = (event) => {
  console.error('ws error', event.message ?? '')
  process.exit(1)
}

await new Promise((resolve, reject) => {
  ws.onopen = resolve
  setTimeout(() => reject(new Error('ws open timeout')), 5000)
})
check('websocket handshake + upgrade route', ws.readyState === WebSocket.OPEN)

for (let i = 0; i < 50 && !ready; i++) await delay(100)
check('ready control frame received', ready !== null)
check('cwd resolved from client hint (no session services)', ready?.cwd?.replace(/\\/g, '/') === 'C:/Users/scw')
check('shell is powershell.exe by default on win32', /powershell\.exe$/i.test(ready?.shell ?? ''))
check('pty pid reported', Number.isInteger(ready?.pid))

ws.send(JSON.stringify({ type: 'input', data: 'echo dsh-terminal-$((40+2))\r' }))
for (let i = 0; i < 50 && !outputText.includes('dsh-terminal-42'); i++) await delay(100)
check('keyboard input reaches shell and output streams back', outputText.includes('dsh-terminal-42'))

ws.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }))
await delay(300)
check('resize message accepted without disconnect', ws.readyState === WebSocket.OPEN)

ws.send(JSON.stringify({ type: 'input', data: 'exit\r' }))
for (let i = 0; i < 50 && !exited; i++) await delay(100)
check('shell exit produces exit control frame', exited !== null)

await delay(300)
ws.close()
server.close()
for (const handle of spawned) await handle.terminate()

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`)
  process.exit(1)
}
console.log('\nall integration checks passed')
process.exit(0)
