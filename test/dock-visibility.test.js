import assert from 'node:assert/strict'
import test from 'node:test'
import { shouldCollapseDock } from '../src/dock-visibility.js'

test('the dock collapses when a new-session (hero) screen takes over', () => {
  assert.equal(shouldCollapseDock('hero', true), true)
})

test('an active conversation never collapses the dock', () => {
  assert.equal(shouldCollapseDock('active', true), false)
})

test('the settling phase is left alone so existing sessions keep the panel', () => {
  assert.equal(shouldCollapseDock('settling', true), false)
})

test('a closed dock stays closed and unknown phases leave it alone', () => {
  assert.equal(shouldCollapseDock('hero', false), false)
  assert.equal(shouldCollapseDock(undefined, true), false)
})
