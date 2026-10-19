import assert from 'node:assert/strict'
import test from 'node:test'
import { delimiter } from 'node:path'
import { withTerminalPath } from '../index.js'

test('the shim precedes the inherited PATH when the caller provides none', () => {
  const env = withTerminalPath({ DSH_SESSION_ID: 'session' }, { shimDir: '/shim', fallbackPath: '/usr/bin' }, 'posix')
  assert.equal(env.PATH, `/shim${delimiter}/usr/bin`)
  assert.equal(env.DSH_SESSION_ID, 'session')
})

test('an explicit caller PATH is kept and the shim is prepended', () => {
  const windows = withTerminalPath({ Path: 'C:\\custom' }, { shimDir: 'C:\\shim', fallbackPath: 'C:\\ignored' }, 'win32')
  assert.deepEqual(windows, { Path: `C:\\shim${delimiter}C:\\custom` })
  const posix = withTerminalPath({ PATH: '/custom' }, { shimDir: '/shim', fallbackPath: '/ignored' }, 'posix')
  assert.deepEqual(posix, { PATH: `/shim${delimiter}/custom` })
})

test('windows uses the canonical Path key regardless of the caller spelling', () => {
  const env = withTerminalPath({ PATH: 'C:\\custom' }, { shimDir: 'C:\\shim' }, 'win32')
  assert.deepEqual(env, { Path: `C:\\shim${delimiter}C:\\custom` })
})

test('no shim directory leaves the caller environment untouched', () => {
  const original = { DSH_SESSION_ID: 'session' }
  assert.deepEqual(withTerminalPath(original, { shimDir: '' }, 'win32'), original)
  assert.deepEqual(withTerminalPath(original, {}, 'posix'), original)
})
