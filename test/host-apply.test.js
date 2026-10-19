import assert from 'node:assert/strict'
import test from 'node:test'
import { delimiter } from 'node:path'
// The Host resolves the `dsh` shim from DSH_EXECUTABLE (Desktop) or app.asar
// (Electron). A normal Node executable exercises the same shim-writing path.
process.env.DSH_EXECUTABLE = process.execPath
const host = await import('../index.js')

/** Minimal Host context: web routes, effects, services, and inject hooks. */
function fakeContext() {
  const routes = new Map()
  const spawned = []
  const desktopRuntime = {
    opened: 0,
    openTerminal() {
      desktopRuntime.opened += 1
    },
  }
  const subprocess = {
    async spawnTerminal(spec) {
      spawned.push(spec)
      return { pid: 1 }
    },
  }
  const ctx = {
    effect(fn) {
      return typeof fn === 'function' ? fn() : undefined
    },
    inject(deps, callback) {
      if (deps.includes('desktopRuntime')) return callback({ desktopRuntime, effect: ctx.effect })
      return undefined
    },
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    subprocess,
  }
  return { ctx, routes, spawned, desktopRuntime, subprocess }
}

test('the Host half registers its three routes and patches the spawn PATH', async () => {
  const { ctx, routes, spawned, subprocess } = fakeContext()
  host.apply(ctx, { position: 'bottom' })

  assert.ok(routes.has('/dsh-terminal/events'))
  assert.ok(routes.has('/dsh-terminal/open-native'))
  assert.ok(routes.has('/dsh-terminal/health'))

  const patched = subprocess.spawnTerminal
  assert.equal(patched.__dshTerminalButtonPatched, true)
  await patched({ argv: ['pwsh.exe'], env: { DSH_SESSION_ID: 'session' } })
  const spec = spawned.at(-1)
  assert.equal(spec.env.DSH_SESSION_ID, 'session')
  assert.ok(spec.env.Path.startsWith('/') || /^[A-Za-z]:/.test(spec.env.Path))
  assert.ok(spec.env.Path.includes(delimiter))
})

test('the spawn patch is installed only once', async () => {
  const { ctx, subprocess } = fakeContext()
  host.apply(ctx, {})
  const once = subprocess.spawnTerminal
  host.apply(ctx, {})
  assert.equal(subprocess.spawnTerminal, once)
})

test('a bottom placement redirects the Desktop openTerminal', () => {
  const { ctx, desktopRuntime } = fakeContext()
  host.apply(ctx, { position: 'bottom' })
  desktopRuntime.openTerminal()
  // The patched method broadcasts to SSE clients instead of opening the native
  // window; with no connected clients it is a no-op.
  assert.equal(desktopRuntime.opened, 0)
})

test('an external placement lets the native openTerminal through', () => {
  const { ctx, desktopRuntime } = fakeContext()
  host.apply(ctx, { position: 'external' })
  desktopRuntime.openTerminal()
  assert.equal(desktopRuntime.opened, 1)
})
