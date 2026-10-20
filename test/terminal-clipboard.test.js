import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clipboardAction,
  copySelection,
  hasSelection,
  installTerminalClipboard,
  isMacPlatform,
  pasteClipboard,
} from '../src/terminal-clipboard.js'

/** Minimal keydown double; records the calls the bridge should make. */
function keydown(overrides = {}) {
  return {
    code: 'KeyC',
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    isComposing: false,
    repeat: false,
    target: null,
    preventDefault() { this.defaultPrevented = true },
    stopPropagation() { this.propagationStopped = true },
    ...overrides,
  }
}

function terminal({ selected = true } = {}) {
  const textarea = {
    focused: false,
    isConnected: true,
    events: [],
    focus() { this.focused = true },
    dispatchEvent(event) { this.events.push(event); return true },
  }
  return {
    textarea,
    node: {
      querySelector(selector) {
        if (selector === 'textarea.xterm-helper-textarea') return textarea
        if (selector === '.xterm-selection') return { childElementCount: selected ? 2 : 0 }
        return null
      },
    },
  }
}

test('Ctrl+Shift+C copies and Ctrl+Shift+V pastes on every platform', () => {
  assert.equal(clipboardAction(keydown({ code: 'KeyC', ctrlKey: true, shiftKey: true }), false), 'copy')
  assert.equal(clipboardAction(keydown({ code: 'KeyC', ctrlKey: true, shiftKey: true }), true), 'copy')
  assert.equal(clipboardAction(keydown({ code: 'KeyV', ctrlKey: true, shiftKey: true }), false), 'paste')
  assert.equal(clipboardAction(keydown({ code: 'KeyV', ctrlKey: true, shiftKey: true }), true), 'paste')
})

test('plain Ctrl+V pastes on Windows/Linux but stays terminal input on macOS', () => {
  assert.equal(clipboardAction(keydown({ code: 'KeyV', ctrlKey: true }), false), 'paste')
  assert.equal(clipboardAction(keydown({ code: 'KeyV', ctrlKey: true }), true), null)
})

test('unclaimed chords keep their terminal behavior', () => {
  // Ctrl+C must stay SIGINT, and Cmd/Meta combinations belong to the platform.
  assert.equal(clipboardAction(keydown({ code: 'KeyC', ctrlKey: true }), false), null)
  assert.equal(clipboardAction(keydown({ code: 'KeyV', metaKey: true }), false), null)
  assert.equal(clipboardAction(keydown({ code: 'KeyV', ctrlKey: true, altKey: true }), false), null)
  assert.equal(clipboardAction(keydown({ code: 'KeyV', ctrlKey: true, isComposing: true }), false), null)
  assert.equal(clipboardAction(keydown({ code: 'KeyV', ctrlKey: true, repeat: true }), false), null)
  assert.equal(clipboardAction(keydown({ code: 'KeyX', ctrlKey: true, shiftKey: true }), false), null)
  assert.equal(clipboardAction(undefined, false), null)
})

test('the platform probe follows navigator.platform and userAgentData', () => {
  assert.equal(isMacPlatform({ platform: 'MacIntel' }), true)
  assert.equal(isMacPlatform({ userAgentData: { platform: 'macOS' } }), true)
  assert.equal(isMacPlatform({ platform: 'Win32' }), false)
  assert.equal(isMacPlatform(undefined), false)
})

test('hasSelection reads the official renderer selection layer', () => {
  assert.equal(hasSelection(terminal({ selected: true }).node), true)
  assert.equal(hasSelection(terminal({ selected: false }).node), false)
  assert.equal(hasSelection(undefined), false)
})

test('copySelection focuses xterm and issues the browser copy command', () => {
  const { node, textarea } = terminal()
  const commands = []
  const documentLike = {
    activeElement: null,
    execCommand(command) { commands.push(command); return true },
  }
  assert.equal(copySelection(node, documentLike), true)
  assert.equal(textarea.focused, true)
  assert.deepEqual(commands, ['copy'])
  assert.equal(copySelection(node, documentLike), true)
})

test('copySelection never touches the clipboard without a selection', () => {
  const { node } = terminal({ selected: false })
  let commands = 0
  const documentLike = { activeElement: null, execCommand() { commands += 1; return true } }
  assert.equal(copySelection(node, documentLike), false)
  assert.equal(commands, 0)
})

test('pasteClipboard replays the clipboard text as an xterm paste event', async () => {
  const { node, textarea } = terminal()
  class DataTransfer {
    constructor() { this.data = new Map() }
    setData(type, value) { this.data.set(type, value) }
  }
  class ClipboardEvent {
    constructor(type, init) {
      this.type = type
      this.clipboardData = init.clipboardData
    }
  }
  const clipboard = { readText: async () => 'echo hello' }
  const pasted = await pasteClipboard(node, {
    clipboard,
    ClipboardEvent,
    DataTransfer,
  })
  assert.equal(pasted, true)
  assert.equal(textarea.events.length, 1)
  assert.equal(textarea.events[0].type, 'paste')
  assert.equal(textarea.events[0].clipboardData.data.get('text/plain'), 'echo hello')
})

test('pasteClipboard does nothing when the clipboard is empty or denied', async () => {
  const { node } = terminal()
  class DataTransfer { setData() {} }
  class ClipboardEvent { constructor() {} }
  assert.equal(await pasteClipboard(node, {
    clipboard: { readText: async () => '' },
    ClipboardEvent,
    DataTransfer,
  }), false)
  assert.equal(await pasteClipboard(node, {
    clipboard: { readText: async () => { throw new Error('denied') } },
    ClipboardEvent,
    DataTransfer,
  }), false)
  assert.equal(await pasteClipboard(node, { clipboard: {}, ClipboardEvent, DataTransfer }), false)
})

test('pasteClipboard drops a paste whose panel closed while reading the clipboard', async () => {
  const { node, textarea } = terminal()
  textarea.isConnected = false
  class DataTransfer { setData() {} }
  class ClipboardEvent { constructor() {} }
  assert.equal(await pasteClipboard(node, {
    clipboard: { readText: async () => 'late' },
    ClipboardEvent,
    DataTransfer,
  }), false)
  assert.equal(textarea.events.length, 0)
})

/** Panel body double that records capture listeners and routes a dispatch. */
function panel(xterm) {
  const listeners = new Map()
  return {
    contains(element) { return element === xterm },
    addEventListener(type, handler, capture) { listeners.set(`${type}:${capture}`, handler) },
    removeEventListener(type, handler, capture) { listeners.delete(`${type}:${capture}`) },
    dispatch(event) {
      const handler = listeners.get('keydown:true')
      if (handler === undefined) return
      handler(event)
    },
    get listenerCount() { return listeners.size },
  }
}

test('the bridge claims copy inside the panel and stops xterm from seeing it', () => {
  const { node } = terminal()
  const container = panel(node)
  const commands = []
  const documentLike = {
    activeElement: null,
    execCommand(command) { commands.push(command); return true },
  }
  const dispose = installTerminalClipboard(container, { mac: false, document: documentLike })
  const event = keydown({
    code: 'KeyC',
    ctrlKey: true,
    shiftKey: true,
    target: { closest: (selector) => (selector === '.xterm' ? node : null) },
  })
  container.dispatch(event)
  assert.equal(event.defaultPrevented, true)
  assert.equal(event.propagationStopped, true)
  assert.deepEqual(commands, ['copy'])
  dispose()
  assert.equal(container.listenerCount, 0)
})

test('the bridge leaves Ctrl+C and events outside the terminal alone', () => {
  const { node } = terminal()
  const container = panel(node)
  installTerminalClipboard(container, {
    mac: false,
    document: { activeElement: null, execCommand() { return true } },
  })
  const interrupt = keydown({
    code: 'KeyC',
    ctrlKey: true,
    target: { closest: (selector) => (selector === '.xterm' ? node : null) },
  })
  container.dispatch(interrupt)
  assert.equal(interrupt.defaultPrevented, undefined)
  const chrome = keydown({
    code: 'KeyV',
    ctrlKey: true,
    shiftKey: true,
    target: { closest: () => null },
  })
  container.dispatch(chrome)
  assert.equal(chrome.defaultPrevented, undefined)
})

test('the bridge replays Ctrl+V as a paste event on the terminal input', async () => {
  const { node, textarea } = terminal()
  const container = panel(node)
  class DataTransfer {
    constructor() { this.data = new Map() }
    setData(type, value) { this.data.set(type, value) }
  }
  class ClipboardEvent {
    constructor(type, init) {
      this.type = type
      this.clipboardData = init.clipboardData
    }
  }
  installTerminalClipboard(container, {
    mac: false,
    document: { activeElement: null, execCommand() { return false } },
    clipboard: { readText: async () => 'dir' },
    ClipboardEvent,
    DataTransfer,
  })
  const event = keydown({
    code: 'KeyV',
    ctrlKey: true,
    target: { closest: (selector) => (selector === '.xterm' ? node : null) },
  })
  container.dispatch(event)
  assert.equal(event.defaultPrevented, true)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(textarea.events.length, 1)
  assert.equal(textarea.events[0].clipboardData.data.get('text/plain'), 'dir')
})
