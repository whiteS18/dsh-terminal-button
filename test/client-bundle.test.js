import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const bundle = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

/** Minimal React surface: apply() must not render anything. */
const ReactStub = {
  useState: () => [undefined, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useSyncExternalStore: () => undefined,
  createElement: () => null,
  Fragment: {},
}

/** Minimal snapshot store used by the dock store. */
function createSnapshotStore(initial) {
  let snapshot = initial
  const listeners = new Set()
  return {
    getSnapshot: () => snapshot,
    set(next) {
      snapshot = next
      for (const listener of listeners) listener(snapshot)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

/** Run the built bundle and return its exports plus the registration capture. */
function loadClient() {
  let registration
  const window = {
    __ModuleLoader__: { load: (value) => { registration = value } },
    addEventListener() {},
    removeEventListener() {},
  }
  const document = {
    body: {},
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ setAttribute() {}, append() {}, textContent: '', style: {} }),
    head: { append() {} },
  }
  class FakeEventSource {
    close() {}
  }
  class FakeMutationObserver {
    observe() {}
    disconnect() {}
  }
  const execute = new Function(
    'window', 'document', 'EventSource', 'MutationObserver', 'fetch',
    bundle,
  )
  execute(window, document, FakeEventSource, FakeMutationObserver, () => Promise.resolve())
  assert.ok(registration, 'bundle must register with the client module loader')
  assert.equal(registration.id, 'dsh-terminal-button')
  const require = (specifier) => {
    if (specifier === 'react') return ReactStub
    if (specifier === '@deepseek-ai/dsh-client-store') return { createSnapshotStore }
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return { Menu: () => null }
    throw new Error(`unexpected require: ${specifier}`)
  }
  return registration.factory(require)
}

test('the slim bundle no longer carries an xterm renderer', () => {
  assert.ok(bundle.length < 100_000, `bundle is ${bundle.length} bytes`)
  assert.equal(bundle.includes('xterm-cursor'), false)
})

test('apply registers bottom-panel slots and the window-hold bridge', () => {
  const client = loadClient()
  assert.deepEqual(client.inject, ['slots', 'webTerminals'])
  assert.equal(client.name, 'dsh-terminal-button')

  const registered = []
  const injected = []
  const disposers = []
  const holdCalls = []
  const webTerminals = {
    retainTabs(tabs) {
      holdCalls.push(tabs)
    },
  }
  const ctx = {
    webTerminals,
    effect(fn) {
      const disposer = typeof fn === 'function' ? fn() : undefined
      if (typeof disposer === 'function') disposers.push(disposer)
      return disposer
    },
    on() {
      return () => {}
    },
    get() {
      return undefined
    },
    slots: {
      inject(name, callback) {
        injected.push(name)
        return callback()
      },
      register(descriptor) {
        registered.push(descriptor)
        return () => {}
      },
    },
  }

  client.apply(ctx)
  const names = registered.map((item) => item.name)
  assert.ok(names.includes('conversation.composer.dock'))
  assert.ok(names.includes('conversation.session.header.actions'))
  assert.ok(names.includes('plugins.bundle.config'))
  assert.ok(injected.includes('conversation.composer.dock'))
  // The bridge wraps the official retainTabs method.
  assert.notEqual(webTerminals.retainTabs.name, 'retainTabs')
  for (const dispose of disposers) dispose()
  assert.equal(webTerminals.retainTabs.name, 'retainTabs')
})
