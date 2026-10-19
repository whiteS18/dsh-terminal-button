import assert from 'node:assert/strict'
import test from 'node:test'
import { statusOf, translate } from '../src/terminal-status.js'

test('missingTerminal shows the friendly copy instead of the raw issue token', () => {
  // `terminal/view` failures carry the issue token as their message; the status
  // row must translate it rather than print "missingTerminal".
  const status = statusOf({ phase: 'failed', issue: 'missingTerminal', error: 'missingTerminal' })
  assert.equal(status.state, 'error')
  assert.equal(status.label, '错误')
  assert.equal(status.message, '此终端已不存在，请新建终端。')
  assert.equal(status.restart, true)
})

test('a failure without an issue keeps the raw error message', () => {
  const status = statusOf({ phase: 'failed', error: 'Terminal window hold released' })
  assert.equal(status.message, 'Terminal window hold released')
  assert.equal(status.restart, true)
})

test('running and exited snapshots map to their badges', () => {
  assert.deepEqual(
    statusOf({ phase: 'connected', info: { state: 'running' } }),
    { state: 'ready', label: '运行中' },
  )
  const exited = statusOf({ phase: 'connected', info: { state: 'exited', exitCode: 0 } })
  assert.equal(exited.state, 'exit')
  assert.equal(exited.label, '已退出')
  assert.equal(exited.restart, true)
})

test('loading and connecting snapshots read as connecting', () => {
  assert.equal(statusOf({ phase: 'connecting' }).state, 'connecting')
  assert.equal(statusOf({ phase: 'loading' }).label, '连接中')
  assert.equal(statusOf(undefined).label, '连接中')
})

test('the copy table interpolates official placeholders', () => {
  assert.equal(translate('exited', { code: 0 }), '进程已退出（0）')
  assert.equal(translate('failed', { message: 'boom' }), '终端错误：boom')
  assert.equal(translate('missingTerminal'), '此终端已不存在，请新建终端。')
  assert.equal(translate('unknownKey'), 'unknownKey')
})
