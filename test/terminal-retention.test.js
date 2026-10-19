import assert from 'node:assert/strict'
import test from 'node:test'
import { createRetentionBridge } from '../src/terminal-retention.js'

/** Minimal stand-in for the official webTerminals service. */
function fakeTerminals() {
  const calls = []
  const service = {
    retainTabs(tabs) {
      calls.push(tabs)
    },
  }
  return { service, calls }
}

const sidebarTab = { tabId: 'sidebar-tab', sessionId: 'session-b', contentId: 'content-b' }

test('a missing service yields an inert bridge', () => {
  const bridge = createRetentionBridge(undefined)
  assert.doesNotThrow(() => {
    bridge.register('session-a', 'tab', 'content')
    bridge.unregister('session-a')
    bridge.refresh()
    bridge.dispose()
  })
})

test('official retainTabs calls keep the bottom-panel virtual tab', () => {
  const { service, calls } = fakeTerminals()
  const bridge = createRetentionBridge(service)
  bridge.register('session-a', 'bottom-tab', 'bottom-content')
  service.retainTabs([sidebarTab])
  const latest = calls.at(-1)
  assert.deepEqual(latest.map((tab) => tab.tabId), ['sidebar-tab', 'bottom-tab'])
  bridge.dispose()
})

test('unregistering a session drops only that virtual tab', () => {
  const { service, calls } = fakeTerminals()
  const bridge = createRetentionBridge(service)
  bridge.register('session-a', 'bottom-a', 'content-a')
  bridge.register('session-b', 'bottom-b', 'content-b')
  bridge.unregister('session-a')
  service.retainTabs([])
  assert.deepEqual(calls.at(-1).map((tab) => tab.tabId), ['bottom-b'])
  bridge.dispose()
})

test('dispose restores the original method and reconciles the official tabs', () => {
  const { service, calls } = fakeTerminals()
  const original = service.retainTabs
  const bridge = createRetentionBridge(service)
  bridge.register('session-a', 'bottom-tab', 'bottom-content')
  service.retainTabs([sidebarTab])
  bridge.dispose()
  assert.equal(service.retainTabs, original)
  assert.deepEqual(calls.at(-1), [sidebarTab])
  bridge.dispose() // idempotent
  assert.equal(service.retainTabs, original)
})
