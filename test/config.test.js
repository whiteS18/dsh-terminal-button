import assert from 'node:assert/strict'
import test from 'node:test'
import { Config } from '../index.js'

test('Config.position is marked volatile so settings.describe serves the form', () => {
  assert.ok(Config, 'Config schema must be exported')
  const field = Config.dict?.position
  assert.ok(field, 'position field must exist')
  assert.equal(field.meta?.volatile, true)
})
