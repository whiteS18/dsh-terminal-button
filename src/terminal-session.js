/**
 * One xterm + PTY.
 *
 * `attach` mounts the view into a slot. `detach` parks that DOM without
 * closing the socket — the bottom dock uses this so a session switch, which
 * unmounts the session-scoped slot, does not spawn a new shell. `dispose`
 * is the only path that kills the PTY.
 */
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'

let parkEl = null

function terminalPark() {
  if (parkEl?.isConnected) return parkEl
  parkEl = document.createElement('div')
  parkEl.setAttribute('data-dsh-terminal-park', '')
  parkEl.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;overflow:hidden;pointer-events:none'
  document.body.appendChild(parkEl)
  return parkEl
}

export function createTerminalController(env, { ctx, sessionId, cwdHint, onSnapshot }) {
  const { wsUrl, readTheme, terminalFontFamily, minCols, minRows } = env
  const viewEl = document.createElement('div')
  viewEl.className = 'dsh-term-view'

  let disposed = false
  let attached = false
  let opened = false
  let didFocus = false
  let open = false
  let ws = null
  const pending = []
  const listeners = new Set()
  let snapshot = { state: 'connecting', info: null, boundCwd: cwdHint || '' }

  const term = new Terminal({
    cursorBlink: true,
    cursorStyle: 'bar',
    fontSize: 13,
    fontFamily: terminalFontFamily(),
    scrollback: 10000,
    theme: readTheme(),
  })
  const fit = new FitAddon()
  term.loadAddon(fit)

  function publish(patch) {
    if (disposed) return
    snapshot = { ...snapshot, ...patch }
    for (const listener of listeners) listener(snapshot)
    onSnapshot?.(snapshot)
  }

  function publishState(updater) {
    const next = updater(snapshot.state)
    if (next !== snapshot.state) publish({ state: next })
  }

  function publishInfo(updater) {
    publish({ info: updater(snapshot.info) })
  }

  // xterm forwards Ctrl+C to the shell as SIGINT and never copies, and it
  // swallows the keydown before a DOM listener can see it. Ctrl+Shift+C is
  // claimed here so it copies instead of sending a modified Ctrl+C. A plain
  // Ctrl+C is left untouched: the copy event below writes the selection,
  // and xterm still delivers the interrupt when nothing is selected.
  // Ctrl+Shift+V pastes. Right-click copies a selection, otherwise pastes.
  const writeClipboard = (text) => {
    if (!text) return
    const clipboard = navigator.clipboard
    if (clipboard?.writeText) {
      clipboard.writeText(text).catch(() => {})
      return
    }
    try {
      document.execCommand('copy')
    } catch { /* clipboard unavailable */ }
  }
  const readClipboard = () => {
    const clipboard = navigator.clipboard
    if (!clipboard?.readText) return Promise.resolve('')
    return clipboard.readText().catch(() => '')
  }
  term.attachCustomKeyEventHandler((event) => {
    const chord = event.ctrlKey || event.metaKey
    if (event.type === 'keydown' && chord && event.shiftKey && event.code === 'KeyC') {
      writeClipboard(term.getSelection())
      return false
    }
    if (event.type === 'keydown' && chord && event.shiftKey && event.code === 'KeyV') {
      // Chromium dispatches a native "paste as plain text" paste event for
      // Ctrl+Shift+V in a textarea, and xterm does NOT preventDefault when
      // this handler returns false — so without this guard the clipboard
      // lands twice: once through the native paste event (onPaste below)
      // and once through this async clipboard read.
      event.preventDefault()
      readClipboard().then((text) => { if (text) term.paste(text) })
      return false
    }
    return true
  })
  const onCopy = (event) => {
    const text = term.getSelection()
    if (!text) return
    event.preventDefault()
    event.stopPropagation()
    event.clipboardData?.setData('text/plain', text)
  }
  const onPaste = (event) => {
    const text = event.clipboardData?.getData('text/plain')
    if (!text) return
    event.preventDefault()
    event.stopPropagation()
    term.paste(text)
  }
  // Copy once the pointer is released, not on every selection-change tick
  // while the user is still dragging.
  const onSelectCopy = (event) => {
    if (event.button !== 0 || !term.hasSelection()) return
    writeClipboard(term.getSelection())
  }
  const onContextMenu = (event) => {
    const selection = term.getSelection()
    if (selection) {
      writeClipboard(selection)
      return
    }
    event.preventDefault()
    readClipboard().then((text) => { if (text) term.paste(text) })
  }
  viewEl.addEventListener('copy', onCopy, true)
  viewEl.addEventListener('paste', onPaste, true)
  viewEl.addEventListener('mouseup', onSelectCopy)
  viewEl.addEventListener('contextmenu', onContextMenu)

  const send = (message) => {
    if (open && ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message))
    else pending.push(message)
  }

  // Spawning the PTY while the panel is hidden or not yet laid out (the
  // sidebar open animation, a parked dock) fits xterm to a degenerate 2x1,
  // and the shell inherits it as its console window — PowerShell's
  // PSReadLine then warns at the first prompt. Defer the connection until
  // the host element has a real box, and floor every geometry at the
  // PSReadLine minimum. Never fit while detached: a 0×0 park would shrink
  // the live PTY.
  function safeFit() {
    if (!attached || disposed) return
    if (viewEl.clientWidth <= 0 || viewEl.clientHeight <= 0) return
    try {
      fit.fit()
    } catch { /* hidden or zero-size */ }
  }

  const connect = () => {
    if (disposed || ws || !attached) return
    safeFit()
    ws = new WebSocket(wsUrl(sessionId, cwdHint, Math.max(minCols, term.cols), Math.max(minRows, term.rows)))
    ws.binaryType = 'arraybuffer'

    ws.onopen = () => {
      open = true
      for (const message of pending.splice(0)) ws.send(JSON.stringify(message))
    }
    ws.onmessage = (event) => {
      if (disposed) return
      if (typeof event.data === 'string') {
        let control
        try {
          control = JSON.parse(event.data)
        } catch {
          return
        }
        if (control?.type === 'ready') {
          publish({
            state: 'ready',
            info: { cwd: control.cwd, shell: control.shell, pid: control.pid },
          })
        } else if (control?.type === 'exit') {
          publish({ state: 'exit' })
          publishInfo((prev) => ({ ...prev, exitCode: control.exitCode }))
          term.write(`\r\n\x1b[2m[进程已退出，退出码 ${String(control.exitCode ?? '?')}]\x1b[0m\r\n`)
        } else if (control?.type === 'error') {
          publish({
            state: 'error',
            info: { message: control.message },
          })
          term.write(`\r\n\x1b[31m${control.message}\x1b[0m\r\n`)
        }
        return
      }
      term.write(new Uint8Array(event.data))
    }
    ws.onclose = (event) => {
      if (disposed) return
      // A close during the handshake is a connection failure, not a shell exit.
      // Browsers give no detail on onerror; the close code is the only signal.
      publishState((prev) => {
        if (prev === 'ready') return 'exit'
        if (prev === 'connecting') return 'error'
        return prev
      })
      if (event && event.code !== 1000) {
        const detail = `WebSocket 已关闭（code ${event.code}${event.reason ? `：${event.reason}` : ''}）`
        publishInfo((prev) => (prev?.message ? prev : { ...prev, message: detail }))
      }
    }
    ws.onerror = () => {
      if (disposed) return
      publishState((prev) => (prev === 'connecting' ? 'error' : prev))
      publishInfo((prev) => (prev?.message ? prev : { message: 'WebSocket 连接失败' }))
    }
  }

  const dataSub = term.onData((data) => send({ type: 'input', data }))
  const resizeSub = term.onResize(({ cols, rows }) => send({
    type: 'resize',
    cols: Math.max(minCols, cols),
    rows: Math.max(minRows, rows),
  }))
  const observer = new ResizeObserver(() => {
    if (!attached || disposed) return
    if (!ws && viewEl.clientWidth > 0 && viewEl.clientHeight > 0) connect()
    safeFit()
  })

  const applyTheme = () => {
    term.options.theme = readTheme()
    term.options.fontFamily = terminalFontFamily()
  }
  const themeObserver = new MutationObserver(applyTheme)
  themeObserver.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
  const offTheme = typeof ctx.on === 'function' ? ctx.on('theme/change', applyTheme) : undefined

  function attach(container) {
    if (disposed) return
    container.appendChild(viewEl)
    attached = true
    if (!opened) {
      term.open(viewEl)
      opened = true
    }
    observer.observe(viewEl)
    safeFit()
    try {
      term.refresh(0, Math.max(0, term.rows - 1))
    } catch { /* not open yet */ }
    if (!ws && viewEl.clientWidth > 0 && viewEl.clientHeight > 0) connect()
    // Focus on the first reveal only. Reattaching after a session switch
    // must not steal the caret from the conversation the user just opened.
    if (!didFocus) {
      didFocus = true
      term.focus()
    }
  }

  function detach() {
    if (disposed || !attached) return
    attached = false
    observer.disconnect()
    terminalPark().appendChild(viewEl)
  }

  function dispose() {
    if (disposed) return
    disposed = true
    attached = false
    observer.disconnect()
    themeObserver.disconnect()
    if (typeof offTheme === 'function') offTheme()
    dataSub.dispose()
    resizeSub.dispose()
    viewEl.removeEventListener('copy', onCopy, true)
    viewEl.removeEventListener('paste', onPaste, true)
    viewEl.removeEventListener('mouseup', onSelectCopy)
    viewEl.removeEventListener('contextmenu', onContextMenu)
    if (ws) {
      ws.onopen = null
      ws.onmessage = null
      ws.onclose = null
      ws.onerror = null
      try {
        ws.close()
      } catch { /* already closed */ }
      ws = null
    }
    try {
      term.dispose()
    } catch { /* already disposed */ }
    viewEl.remove()
    listeners.clear()
  }

  return {
    get disposed() {
      return disposed
    },
    getSnapshot() {
      return snapshot
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    attach,
    detach,
    dispose,
  }
}
