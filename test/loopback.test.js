import assert from 'node:assert/strict'
import test from 'node:test'
import { loopbackBaseFrom, resolveLoopbackBase, webSocketUrl } from '../src/loopback.js'

const desktopLocation = { protocol: 'dsh-app:', origin: 'dsh-app://app' }

test('DSH >= 0.2 desktop reads the live transport stream base', () => {
  const scope = {
    location: desktopLocation,
    __DSH_TRANSPORT__: { ownsHost: true, streamBaseUrl: 'http://127.0.0.1:62460/' },
  }
  assert.equal(loopbackBaseFrom(scope), 'http://127.0.0.1:62460')
})

test('legacy desktop boot payload still supplies the host origin', () => {
  assert.equal(
    loopbackBaseFrom({ location: desktopLocation, __DSH_BOOT__: { webUrl: 'http://127.0.0.1:19387' } }),
    'http://127.0.0.1:19387',
  )
  assert.equal(
    loopbackBaseFrom({ location: desktopLocation, __DSH_BOOT__: { origin: 'http://127.0.0.1:41000/' } }),
    'http://127.0.0.1:41000',
  )
})

test('the module graph injected as __DSH_BOOT__ is not mistaken for a URL', () => {
  // Since DSH 0.2 this global is the client module graph and has no URL field.
  const scope = {
    location: desktopLocation,
    __DSH_BOOT__: { plugins: [{ id: 'dsh-terminal-button' }], batches: [], release: { version: '0.2.1' } },
  }
  assert.equal(loopbackBaseFrom(scope), undefined)
})

test('the Desktop IPC boot payload is consulted when the scope has no host origin', async () => {
  const scope = {
    location: desktopLocation,
    __DSH_BOOT__: { plugins: [] },
    dshDesktopBoot: { ready: async () => ({ injections: [], streamBaseUrl: 'http://127.0.0.1:5555' }) },
  }
  assert.equal(await resolveLoopbackBase(scope), 'http://127.0.0.1:5555')
})

test('a shell with no boot data keeps the historic fixed port as the last resort', async () => {
  assert.equal(await resolveLoopbackBase({ location: desktopLocation }), 'http://127.0.0.1:19387')
})

test('a rejected boot payload falls through instead of throwing', async () => {
  const scope = {
    location: desktopLocation,
    dshDesktopBoot: { ready: async () => { throw new Error('desktop host unavailable') } },
  }
  assert.equal(await resolveLoopbackBase(scope), 'http://127.0.0.1:19387')
})

test('browser tabs use their own document origin', () => {
  assert.equal(
    loopbackBaseFrom({ location: { protocol: 'http:', origin: 'http://127.0.0.1:62460' } }),
    'http://127.0.0.1:62460',
  )
  assert.equal(
    loopbackBaseFrom({ location: { protocol: 'https:', origin: 'https://dsh.example.com' } }),
    'https://dsh.example.com',
  )
})

test('webSocketUrl switches protocols and keeps the query intact', () => {
  assert.equal(
    webSocketUrl('http://127.0.0.1:62460', '/dsh-terminal/pty?sessionId=a&cols=80&rows=24'),
    'ws://127.0.0.1:62460/dsh-terminal/pty?sessionId=a&cols=80&rows=24',
  )
  assert.equal(
    webSocketUrl('https://dsh.example.com/', '/dsh-terminal/pty?cols=80'),
    'wss://dsh.example.com/dsh-terminal/pty?cols=80',
  )
  assert.throws(() => webSocketUrl('dsh-app://app', '/dsh-terminal/pty'))
})
