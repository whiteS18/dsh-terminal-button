import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizePosition, positionLabel } from '../src/position.js'

test('the bottom panel is the normalized default', () => {
  assert.equal(normalizePosition(undefined), 'bottom')
  assert.equal(normalizePosition('bottom'), 'bottom')
})

test('the legacy sidebar placement folds into the bottom panel', () => {
  assert.equal(normalizePosition('sidebar'), 'bottom')
  assert.equal(positionLabel('sidebar'), '底部面板')
})

test('external stays external', () => {
  assert.equal(normalizePosition('external'), 'external')
  assert.equal(positionLabel('external'), '系统弹窗')
})
