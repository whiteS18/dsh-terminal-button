import assert from 'node:assert/strict'
import test from 'node:test'
import { createPinnedRegistry } from '../src/pinned-terminal.js'

function fakeController() {
  const controller = {
    id: 0,
    disposed: false,
    dispose() {
      controller.disposed = true
    },
  }
  return controller
}

test('acquire reuses the live bottom terminal across session switches', () => {
  const registry = createPinnedRegistry()
  let created = 0
  const factory = () => {
    created += 1
    const controller = fakeController()
    controller.id = created
    return controller
  }
  const first = registry.acquire(factory)
  const second = registry.acquire(factory)
  assert.equal(first, second)
  assert.equal(created, 1)
  assert.equal(registry.generation, 0)
})

test('a disposed controller is not reused', () => {
  const registry = createPinnedRegistry()
  const first = registry.acquire(() => fakeController())
  first.dispose()
  const second = registry.acquire(() => fakeController())
  assert.notEqual(first, second)
  assert.equal(second.disposed, false)
})

test('restart replaces the shell and bumps generation', () => {
  const registry = createPinnedRegistry()
  const seen = []
  registry.subscribe(() => seen.push(registry.generation))
  const first = registry.acquire(() => fakeController())
  const second = registry.restart(() => fakeController())
  assert.notEqual(first, second)
  assert.equal(first.disposed, true)
  assert.equal(second.disposed, false)
  assert.equal(registry.current, second)
  assert.equal(registry.generation, 1)
  assert.deepEqual(seen, [0, 1])
})

test('dispose drops the pinned shell', () => {
  const registry = createPinnedRegistry()
  const first = registry.acquire(() => fakeController())
  registry.dispose()
  assert.equal(first.disposed, true)
  assert.equal(registry.current, null)
  assert.equal(registry.generation, 1)
})
