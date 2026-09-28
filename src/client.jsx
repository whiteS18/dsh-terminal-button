/**
 * dsh-terminal-button — Client half (browser bundle).
 *
 * Bundled by build.mjs (esbuild): @xterm/xterm + FitAddon + xterm.css are
 * inlined; only platform seed modules (react, @deepseek-ai/*) stay external
 * and resolve through the loader's `require`.
 *
 * Placement is configurable (settingsScope namespace "dsh-terminal-button" on
 * DSH <= 0.1.5; the volatile `position` field of the `terminal-plugin` loader
 * entry via `configForms` on DSH >= 0.1.6 — key "position" either way):
 *   - "sidebar" (default): a DockKit right-sidebar tab (kind "terminal"),
 *     opened from the Desktop titlebar button or the sidebar guide.
 *   - "bottom": a full-width panel at the very bottom of the session column
 *     (`conversation.composer.dock`, wrapped onto its own line below the
 *     token meter via CSS). It rises from the bottom edge and pushes the
 *     composer (input card and context meter stay glued together) plus the
 *     conversation up, mirroring opencode's bottom panel. Drag the top edge
 *     to resize; the close button collapses it.
 *   - "external": every entry point spawns the Desktop-native system
 *     terminal window instead (via the host's /dsh-terminal/open-native).
 * The selector itself is registered into the Plugins page detail of this
 * bundle (`plugins.bundle.config`, keyed by the package name). On DSH <= 0.1.5,
 * which has no Plugins detail slot, it stays on `settings.general.item`.
 * Either surface uses the native primitives Menu.
 *
 * On DSH Desktop, "open terminal" entry points split across two processes:
 * tray/settings-page calls reach the Host's `desktopRuntime` service (host
 * patch → SSE `/dsh-terminal/events`), while the titlebar chrome — a separate
 * WebContentsView — is handled by the Electron main process, which the
 * desktop installation patch (electron-runtime-*.js, chromeActions
 * .openTerminal) turns into a `dsh-desktop:open-terminal` window event.
 * This bundle listens to both and reveals the panel.
 *
 * The icon is Lucide's SquareTerminal — the same glyph DSH Desktop's native
 * titlebar terminal button ships — so the entry points look native.
 *
 * The xterm panel is wired to the host over a same-origin WebSocket
 * (`/dsh-terminal/pty`). Theme follows the DSH CSS tokens (--dsw-alias-*)
 * and re-reads on `theme/change` and body[data-ds-dark-theme] flips. The
 * PTY cwd is resolved host-side from the session id (workspace root); the
 * client only sends its session cwd as a fallback hint.
 */
import React from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import xtermCss from '@xterm/xterm/css/xterm.css'

const { Menu } = primitives
// Icon exports were renamed in DSH 0.1.7 (size suffix dropped for Regular/
// Medium weights); resolve whichever name this runtime exports.
const IconChevronDownOutline14 = primitives.IconChevronDownOutline14
  ?? primitives.IconChevronDownOutlineRegular
  ?? primitives.IconChevronDownOutlineMedium

export const name = 'dsh-terminal-button'
// 'settingsScope' was removed in DSH 0.1.7 (replaced by 'configForms') and
// 'theme' is only consumed through the ctx.on('theme/change') event — neither
// may be a hard inject, or the client half never activates on 0.1.7.
export const inject = ['slots', 'sidebarRightTabs', 'sidebarRight']

const TAB_ID = 'dsh-terminal'
const TAB_KIND = 'terminal'
const WS_PATH = '/dsh-terminal/pty'
/** SSE channel: the host pushes 'open' when a Desktop entry point fires. */
const EVENTS_PATH = '/dsh-terminal/events'
/** Host endpoint that always spawns the Desktop system terminal window. */
const OPEN_NATIVE_PATH = '/dsh-terminal/open-native'
const SETTINGS_NAMESPACE = 'dsh-terminal-button'
/**
 * Profile loader entry id from cordis.patch.yml. Settings writes address this
 * id (`settings.describe().ns`), not `include:<id>` and not the package name.
 */
const CONFIG_ENTRY_ID = 'terminal-plugin'
/** Plugins page keys `plugins.bundle.config` by the package name. */
const BUNDLE_KEY = 'dsh-terminal-button'
const POSITION_KEY = 'position'
const POSITIONS = { sidebar: '右侧栏', bottom: '底部面板', external: '系统弹窗' }
/**
 * PSReadLine disables its ListView prediction — and prints a warning at every
 * prompt — when the console window is smaller than 50x5. A hidden or
 * freshly-mounted panel fits xterm to a degenerate 2x1, so the PTY geometry
 * is floored at this minimum (host enforces the same floor as backstop).
 */
const MIN_COLS = 50
const MIN_ROWS = 5

const CSS = [
  xtermCss,
  '.dsh-term-panel{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}',
  '.dsh-term-view{flex:1;min-height:0;padding:6px 4px 4px 10px;overflow:hidden}',
  '.dsh-term-view .xterm{height:100%}',
  '.dsh-term-status{display:flex;align-items:center;gap:8px;padding:4px 10px;border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2));font-size:11px;color:var(--dsw-alias-label-tertiary,#999);white-space:nowrap;overflow:hidden}',
  '.dsh-term-status-path{overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left;flex:1}',
  '.dsh-term-badge{flex:none;padding:1px 6px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.12))}',
  '.dsh-term-badge[data-state="exit"],.dsh-term-badge[data-state="error"]{color:var(--dsw-alias-state-error-primary,#f85149)}',
  '.dsh-term-badge[data-state="ready"]{color:var(--dsw-alias-state-success-primary,#3fb950)}',
  '.dsh-term-restart{flex:none;border:none;border-radius:6px;padding:2px 8px;cursor:pointer;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.12));color:var(--dsw-alias-label-secondary,#ccc);font-size:11px}',
  '.dsh-term-restart:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.2))}',
  '.dsh-term-title{display:inline-flex;align-items:center;gap:6px}',
  '.dsh-term-title svg{width:14px;height:14px;display:block}',
  // Bottom dock card (conversation.composer.dock). The slot outlet renders
  // inside the composer's bottom flex row — a horizontal line it shares with
  // the context (token) meter, which would squeeze the panel into the middle.
  // The :has() rule below turns that row into a wrapping, full-width line so
  // the dock (order: 1, basis > 100%) lands on its own row BELOW the meter,
  // and the negative side margins cancel the composer root's side clearance
  // so the panel spans the whole conversation column (main-area width) and
  // rises from the bottom edge — opencode-style. The conversation column's
  // width-drag handle (._widthHandle) is absolutely positioned over the
  // content's right edge in a stacking context we cannot out-z-index from
  // inside the slot — so keep the dock head's controls clear of that strip
  // with right padding.
  'div:has(> [data-slot="conversation.composer.dock"] > .dsh-term-dock){width:100%;flex-wrap:wrap}',
  '.dsh-term-dock{order:1;flex:none;box-sizing:border-box;width:calc(100% + var(--dsh-composer-side-clearance,16px) * 2);margin:0 calc(var(--dsh-composer-side-clearance,16px) * -1);position:relative;z-index:30;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base));border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.25));border-radius:12px;overflow:hidden}',
  '.dsh-term-dock-head{position:relative;z-index:31;padding-right:52px}',
  '.dsh-term-dock-drag{flex:none;height:5px;cursor:row-resize}',
  '.dsh-term-dock-drag:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.18))}',
  '.dsh-term-dock-head{flex:none;display:flex;align-items:center;gap:8px;padding:6px 10px 4px;color:var(--dsw-alias-label-secondary,#ccc);font-size:12px}',
  '.dsh-term-dock-head svg{width:14px;height:14px}',
  '.dsh-term-dock-head-title{font-weight:500}',
  '.dsh-term-dock-head-cwd{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary,#999);font-size:11px;direction:rtl;text-align:left}',
  '.dsh-term-dock-body{flex:none;min-height:0}',
  '.dsh-term-iconbtn{width:24px;height:24px;flex:none;border:none;border-radius:6px;background:0 0;color:var(--dsw-alias-label-tertiary,#999);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;padding:4px}',
  '.dsh-term-iconbtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.15));color:var(--dsw-alias-label-secondary,#ccc)}',
  // settings row — metrics copied from the native Language row
  // (dsh-client-locale LanguageRow.module.css, figma 'Setting-Cell'):
  // 36px-tall pill, radius 18px, 14px text, platform-module background.
  '.dsh-term-setting{border-bottom:.5px solid var(--dsw-alias-border-l2,rgba(128,128,128,.15));display:flex;align-items:center;gap:8px;padding:16px 0}',
  '.dsh-term-setting-text{display:flex;flex-direction:column;flex:1;gap:4px;min-width:0;padding-right:48px}',
  '.dsh-term-setting-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}',
  '.dsh-term-setting-desc{font-size:12px;color:var(--dsw-alias-label-tertiary,#999)}',
  '.dsh-term-setting-selector{background:var(--dsw-alias-bg-module-platform,rgba(128,128,128,.12));height:36px;font:inherit;color:var(--dsw-alias-label-primary);cursor:pointer;border:none;border-radius:18px;align-items:center;gap:12px;padding:0 14px;font-size:14px;line-height:22px;display:inline-flex}',
  '.dsh-term-setting-selector:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.2))}',
  '.dsh-term-setting-selector svg{flex:none}',
  '.dsh-term-setting-error{margin:6px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary,#f85149)}',
  // conversation header button — mirrors the shipped ghost icon actions
  '.dsh-term-header-btn{width:28px;height:28px;flex:none;color:var(--dsw-alias-label-tertiary,#999);cursor:pointer;background:0 0;border:none;border-radius:8px;display:inline-flex;align-items:center;justify-content:center;padding:6px}',
  '.dsh-term-header-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));color:var(--dsw-alias-label-secondary,#ccc)}',
  '.dsh-term-header-btn svg{display:block}',
].join('\n')

function injectStyle() {
  const el = document.createElement('style')
  el.setAttribute('data-plugin', name)
  el.textContent = CSS
  document.head.append(el)
}

/** Lucide "square-terminal" — the same icon as DSH Desktop's native titlebar terminal button. */
function SquareTerminalGlyph({ size = 16, className }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m7 9 2 2-2 2" />
      <path d="M12 15h3" />
      <rect width="18" height="18" x="3" y="3" rx="2" />
    </svg>
  )
}

function CloseGlyph({ size = 14 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  )
}

function cssVar(name, fallback) {
  const value = getComputedStyle(document.body).getPropertyValue(name).trim()
  return value || fallback
}

function readTheme() {
  const dark = document.body.hasAttribute('data-ds-dark-theme')
  return {
    background: cssVar('--dsw-alias-bg-base', dark ? '#151517' : '#ffffff'),
    foreground: cssVar('--dsw-alias-label-primary', dark ? '#f9fafb' : '#0f1115'),
    cursor: cssVar('--dsw-alias-label-primary', dark ? '#f9fafb' : '#0f1115'),
    cursorAccent: cssVar('--dsw-alias-bg-base', dark ? '#151517' : '#ffffff'),
    selectionBackground: dark ? 'rgba(255,255,255,0.22)' : 'rgba(38,49,72,0.18)',
  }
}

function terminalFontFamily() {
  return cssVar('--ds-font-family-code', 'Consolas, "Courier New", monospace')
}

function loopbackBase() {
  // Desktop loads the UI as dsh-app://desktop.loopback, which Chromium maps to
  // the Host's loopback HTTP origin. A relative ws:// URL is not a valid
  // WebSocket target there, so use the mapped HTTP origin explicitly.
  if (window.location.protocol === 'dsh-app:') {
    const boot = window.__DSH_BOOT__
    const fromBoot = boot?.webUrl || boot?.url || boot?.origin
    if (typeof fromBoot === 'string' && /^https?:\/\//.test(fromBoot)) return fromBoot.replace(/\/$/, '')
    return 'http://127.0.0.1:19387'
  }
  return window.location.origin
}

function wsUrl(sessionId, cwd, cols, rows) {
  const httpBase = loopbackBase()
  const protocol = httpBase.startsWith('https:') ? 'wss:' : 'ws:'
  const host = httpBase.replace(/^https?:\/\//, '')
  const query = new URLSearchParams({ sessionId, cols: String(cols), rows: String(rows) })
  if (cwd) query.set('cwd', cwd)
  return `${protocol}//${host}${WS_PATH}?${query}`
}

const STATE_LABEL = {
  connecting: '连接中',
  ready: '运行中',
  exit: '已退出',
  error: '错误',
}

// ---------------------------------------------------------------------------
// Shared stores
// ---------------------------------------------------------------------------

/** Dock UI state: height persists; the drawer always starts closed on boot. */
const dockStore = createSnapshotStore(
  { open: false, height: 260 },
  { persist: { name: 'dsh-terminal.dock' } },
)

function toggleDock() {
  const prev = dockStore.getSnapshot() ?? {}
  dockStore.set({ ...prev, open: !prev.open })
}

function openDock() {
  const prev = dockStore.getSnapshot() ?? {}
  dockStore.set({ ...prev, open: true })
}

function closeDock() {
  const prev = dockStore.getSnapshot() ?? {}
  dockStore.set({ ...prev, open: false })
}

/** Wrap one host-backed settingsScope key as a plain snapshot store. */
function createSettingStore(scope, key, fallback) {
  if (!scope) return createSnapshotStore(fallback)
  return {
    getSnapshot() {
      return scope.getSnapshot()?.value?.[key] ?? fallback
    },
    subscribe(callback) {
      return scope.subscribe(callback)
    },
    set(value) {
      scope.set(key, value)
    },
  }
}

/**
 * Bind the placement setting on whichever settings surface this runtime has:
 * DSH <= 0.1.5 exposes the `settingsScope` service; DSH >= 0.1.6 replaced it
 * with `configForms` over the loader entry declared in cordis.patch.yml
 * (`terminal-plugin`), whose volatile `position` field carries the same value.
 * Writes go through `mutate` with the revision the form was read at — `set`
 * races a describe() that bumps the revision on every read and gets refused.
 */
function bindPositionStore(ctx) {
  const settingsScope = typeof ctx.get === 'function' ? ctx.get('settingsScope') : undefined
  if (typeof settingsScope?.bind === 'function') {
    const scope = settingsScope.bind({
      namespace: SETTINGS_NAMESPACE,
      decode: (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : undefined),
    })
    return createSettingStore(scope, POSITION_KEY, 'sidebar')
  }
  const configForms = typeof ctx.get === 'function' ? ctx.get('configForms') : undefined
  if (typeof configForms?.get === 'function') {
    const scope = configForms.get(CONFIG_ENTRY_ID)
    return {
      getSnapshot() {
        return scope.getSnapshot()?.value?.[POSITION_KEY] ?? 'sidebar'
      },
      subscribe(callback) {
        return scope.subscribe(callback)
      },
      set(value) {
        const snap = scope.getSnapshot()
        const write = scope.mutate(
          [{ op: 'set', path: [POSITION_KEY], value }],
          snap?.revision,
        )
        return Promise.resolve(write).then((accepted) => {
          if (accepted === false) {
            const message = '终端位置没有保存（配置被拒绝）'
            console.error('[dsh-terminal] position write was refused')
            return { ok: false, message }
          }
          return { ok: true }
        }).catch((error) => {
          console.error('[dsh-terminal] position write failed:', error)
          return { ok: false, message: '终端位置没有保存' }
        })
      },
    }
  }
  return createSnapshotStore('sidebar')
}

/**
 * Assigned in apply(); components subscribe directly via useSyncExternalStore
 * instead of the slot `inject` hooks conversion — that conversion is not
 * wired up on every slot's render path (e.g. conversation.composer.dock).
 */
let positionStore = null
/** Assigned in apply(); lets the host-driven open events reach the service. */
let sidebarRightService = null

function usePosition() {
  return React.useSyncExternalStore(
    (callback) => positionStore.subscribe(callback),
    () => positionStore.getSnapshot(),
  )
}

function useDock() {
  return React.useSyncExternalStore(
    (callback) => dockStore.subscribe(callback),
    () => dockStore.getSnapshot(),
  )
}

// ---------------------------------------------------------------------------
// Terminal core (xterm + websocket), shared by sidebar tab and bottom dock
// ---------------------------------------------------------------------------

function TerminalView({ ctx, sessionId, cwdHint, signal }) {
  const hostRef = React.useRef(null)
  const [attempt, setAttempt] = React.useState(0)
  const [state, setState] = React.useState('connecting')
  const [info, setInfo] = React.useState(null)

  React.useEffect(() => {
    const el = hostRef.current
    if (!el || !sessionId) return undefined

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
    term.open(el)
    try {
      fit.fit()
    } catch { /* container not laid out yet; ResizeObserver will retry */ }
    term.focus()

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
    el.addEventListener('copy', onCopy, true)
    el.addEventListener('paste', onPaste, true)
    el.addEventListener('mouseup', onSelectCopy)
    el.addEventListener('contextmenu', onContextMenu)

    let disposed = false
    let open = false
    let ws = null
    const pending = []

    const send = (message) => {
      if (open && ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message))
      else pending.push(message)
    }

    // Spawning the PTY while the panel is hidden or not yet laid out (the
    // sidebar open animation, a display:none dock) fits xterm to a
    // degenerate 2x1, and the shell inherits it as its console window —
    // PowerShell's PSReadLine then warns at the first prompt. Defer the
    // connection until the host element has a real box, and floor every
    // geometry at the PSReadLine minimum.
    const connect = () => {
      if (disposed || ws) return
      try {
        fit.fit()
      } catch { /* not measurable yet; the floored defaults still apply */ }
      ws = new WebSocket(wsUrl(sessionId, cwdHint, Math.max(MIN_COLS, term.cols), Math.max(MIN_ROWS, term.rows)))
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
            setState('ready')
            setInfo({ cwd: control.cwd, shell: control.shell, pid: control.pid })
          } else if (control?.type === 'exit') {
            setState('exit')
            setInfo((prev) => ({ ...prev, exitCode: control.exitCode }))
            term.write(`\r\n\x1b[2m[进程已退出，退出码 ${String(control.exitCode ?? '?')}]\x1b[0m\r\n`)
          } else if (control?.type === 'error') {
            setState('error')
            setInfo({ message: control.message })
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
        setState((prev) => {
          if (prev === 'ready') return 'exit'
          if (prev === 'connecting') return 'error'
          return prev
        })
        if (event && event.code !== 1000) {
          const detail = `WebSocket 已关闭（code ${event.code}${event.reason ? `：${event.reason}` : ''}）`
          setInfo((prev) => (prev?.message ? prev : { ...prev, message: detail }))
        }
      }
      ws.onerror = () => {
        if (disposed) return
        setState((prev) => (prev === 'connecting' ? 'error' : prev))
        setInfo((prev) => (prev?.message ? prev : { message: 'WebSocket 连接失败' }))
      }
    }

    const dataSub = term.onData((data) => send({ type: 'input', data }))
    const resizeSub = term.onResize(({ cols, rows }) => send({
      type: 'resize',
      cols: Math.max(MIN_COLS, cols),
      rows: Math.max(MIN_ROWS, rows),
    }))
    const observer = new ResizeObserver(() => {
      if (!ws && el.clientWidth > 0 && el.clientHeight > 0) connect()
      try {
        fit.fit()
      } catch { /* hidden or zero-size */ }
    })
    observer.observe(el)
    // Fast path: the panel is usually already laid out at mount.
    if (el.clientWidth > 0 && el.clientHeight > 0) connect()

    const applyTheme = () => {
      term.options.theme = readTheme()
      term.options.fontFamily = terminalFontFamily()
    }
    const themeObserver = new MutationObserver(applyTheme)
    themeObserver.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
    const offTheme = typeof ctx.on === 'function' ? ctx.on('theme/change', applyTheme) : undefined

    const onAbort = () => cleanup()
    signal?.addEventListener('abort', onAbort, { once: true })

    function cleanup() {
      if (disposed) return
      disposed = true
      signal?.removeEventListener('abort', onAbort)
      themeObserver.disconnect()
      observer.disconnect()
      if (typeof offTheme === 'function') offTheme()
      dataSub.dispose()
      resizeSub.dispose()
      el.removeEventListener('copy', onCopy, true)
      el.removeEventListener('paste', onPaste, true)
      el.removeEventListener('mouseup', onSelectCopy)
      el.removeEventListener('contextmenu', onContextMenu)
      if (ws) {
        try {
          ws.close()
        } catch { /* already closed */ }
      }
      term.dispose()
    }

    return cleanup
  }, [sessionId, cwdHint, attempt])

  return (
    <div className="dsh-term-panel">
      <div className="dsh-term-view" ref={hostRef} />
      <div className="dsh-term-status">
        <span className="dsh-term-badge" data-state={state}>{STATE_LABEL[state] ?? state}</span>
        <span className="dsh-term-status-path" title={info?.message || info?.cwd || cwdHint || ''}>
          {state === 'error' && info?.message ? info.message : (info?.cwd ?? cwdHint ?? '')}
        </span>
        {state === 'exit' || state === 'error' ? (
          <button type="button" className="dsh-term-restart" onClick={() => setAttempt((n) => n + 1)}>
            重开终端
          </button>
        ) : null}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sidebar placement
// ---------------------------------------------------------------------------

function TerminalBody(props, ctx) {
  // DSH <= 0.1.5 hands entries useTabInfo/useSessions hooks; DSH >= 0.1.7
  // delivers the session id as a standard prop of every session-scope slot
  // and the tab's AbortSignal through the slot hook context.
  const { sessionId, useSessions } = props
  const tab = typeof props.useTabInfo === 'function' ? props.useTabInfo().tab : undefined
  const signal = tab?.signal ?? props.hookContext?.signal
  const cwdHint = typeof useSessions === 'function'
    ? useSessions((sessions) => sessions.byId?.[sessionId]?.cwd)
    : undefined
  return <TerminalView ctx={ctx} sessionId={sessionId} cwdHint={cwdHint} signal={signal} />
}

function TerminalTitle(props) {
  const tab = typeof props.useTabInfo === 'function' ? props.useTabInfo().tab : undefined
  return (
    <span className="dsh-term-title">
      <SquareTerminalGlyph size={14} />
      {tab?.title ?? '终端'}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Bottom dock placement (conversation.composer.dock, session scope)
// ---------------------------------------------------------------------------

function TerminalDock(props, ctx) {
  const { sessionId, useSessions } = props
  const dock = useDock()
  const cwdHint = typeof useSessions === 'function'
    ? useSessions((sessions) => sessions.byId?.[sessionId]?.cwd)
    : undefined

  const onDragStart = React.useCallback((event) => {
    event.preventDefault()
    const startY = event.clientY
    const startHeight = dockStore.getSnapshot()?.height ?? 260
    const onMove = (move) => {
      const max = Math.round(window.innerHeight * 0.6)
      const height = Math.min(max, Math.max(120, startHeight + (startY - move.clientY)))
      dockStore.set({ ...(dockStore.getSnapshot() ?? {}), height })
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [])

  if (!dock?.open) return null

  return (
    <div className="dsh-term-dock">
      <div className="dsh-term-dock-drag" onPointerDown={onDragStart} />
      <div className="dsh-term-dock-head">
        <SquareTerminalGlyph size={14} />
        <span className="dsh-term-dock-head-title">终端</span>
        <span className="dsh-term-dock-head-cwd" title={cwdHint ?? ''}>{cwdHint ?? ''}</span>
        <button
          type="button"
          className="dsh-term-iconbtn"
          aria-label="关闭终端面板"
          title="关闭"
          onClick={() => closeDock()}
        >
          <CloseGlyph />
        </button>
      </div>
      <div className="dsh-term-dock-body" style={{ height: dock.height ?? 260 }}>
        <TerminalView ctx={ctx} sessionId={sessionId} cwdHint={cwdHint} />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Settings row
// ---------------------------------------------------------------------------

/** Native settings row: label + Menu selector, same pattern as the permission/language rows. */
function TerminalPositionSettingRow() {
  const position = usePosition()
  const [open, setOpen] = React.useState(false)
  const [error, setError] = React.useState('')
  return (
    <div className="dsh-term-setting">
      <div className="dsh-term-setting-text">
        <span className="dsh-term-setting-title">终端显示位置</span>
        <span className="dsh-term-setting-desc">终端打开在右侧栏、底部面板，或改用系统终端弹窗</span>
        {error ? <span className="dsh-term-setting-error" role="alert">{error}</span> : null}
      </div>
      <Menu
        open={open}
        onClose={() => setOpen(false)}
        items={Object.entries(POSITIONS).map(([id, label]) => ({ id, label }))}
        selectedId={position}
        onSelect={(id) => {
          setOpen(false)
          if (id === position) return
          Promise.resolve(positionStore.set(id)).then((result) => {
            setError(result && result.ok === false ? result.message : '')
          })
        }}
        align="end"
        portal={true}
        anchor={(
          <button
            type="button"
            className="dsh-term-setting-selector"
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            {POSITIONS[position] ?? POSITIONS.sidebar}
            {IconChevronDownOutline14 ? <IconChevronDownOutline14 /> : null}
          </button>
        )}
      />
    </div>
  )
}

/** Plugins detail body. Summary view stays empty so the card one-liner is unchanged. */
function TerminalPositionConfigPage(props) {
  if (props.view === 'summary') return null
  return <TerminalPositionSettingRow />
}

// ---------------------------------------------------------------------------
// Host-driven open events (Desktop titlebar / tray / settings entry points)
// ---------------------------------------------------------------------------

function openPluginPanel() {
  const position = positionStore.getSnapshot()
  if (position === 'bottom') openDock()
  else if (position !== 'external') sidebarRightService?.openTab(TAB_KIND)
  // 'external' never reaches here: the host gate keeps the native behavior.
}

/**
 * Subscribe to both host-driven open channels:
 *  - SSE `/dsh-terminal/events`: tray item and settings-page entry points,
 *    broadcast by the host's patched desktopRuntime.openTerminal (already
 *    gated: 'external' falls through to the system window host-side).
 *  - window event `dsh-desktop:open-terminal`: dispatched by the patched
 *    Electron main process for titlebar-chrome and dshDesktopActions clicks
 *    (isolated-Host builds route those straight to main). The mode gate is
 *    applied here; 'external' goes through the host's open-native endpoint,
 *    which still spawns the real system window.
 * EventSource reconnects automatically.
 */
function installOpenEvents() {
  const cleanups = []
  if (typeof EventSource === 'function') {
    const source = new EventSource(EVENTS_PATH)
    source.onmessage = (event) => {
      if (event.data === 'open') openPluginPanel()
    }
    cleanups.push(() => source.close())
  }
  const onNativeOpen = () => {
    if (positionStore.getSnapshot() === 'external') {
      fetch(OPEN_NATIVE_PATH, { method: 'POST' }).catch(() => {})
      return
    }
    openPluginPanel()
  }
  window.addEventListener('dsh-desktop:open-terminal', onNativeOpen)
  cleanups.push(() => window.removeEventListener('dsh-desktop:open-terminal', onNativeOpen))
  return () => {
    for (const cleanup of cleanups) cleanup()
  }
}

// ---------------------------------------------------------------------------
// Conversation header button (conversation.session.header.actions — declared
// by both DSH 0.1.5 and 0.1.7): opens the panel wherever the placement
// setting points.
// ---------------------------------------------------------------------------

function TerminalHeaderButton() {
  return (
    <button
      type="button"
      className="dsh-term-header-btn"
      aria-label="打开终端"
      title="打开终端"
      onClick={() => openPluginPanel()}
    >
      <SquareTerminalGlyph size={16} />
    </button>
  )
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function apply(ctx) {
  injectStyle()

  // The dock always starts closed on boot; height persists via localStorage.
  dockStore.set({ ...(dockStore.getSnapshot() ?? {}), open: false })

  positionStore = bindPositionStore(ctx)
  sidebarRightService = ctx.sidebarRight

  ctx.effect(() => installOpenEvents())

  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: TAB_ID,
    kind: TAB_KIND,
    priority: 'extension',
    title: () => '终端',
    guide: [{
      id: TAB_ID, // required since DSH 0.1.7 (stable entry identity on the guide page)
      order: 20,
      title: () => '终端',
      description: () => '在侧栏打开内置终端，工作目录为当前工作区根目录',
      icon: SquareTerminalGlyph,
    }],
  }))

  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: TAB_ID },
    (props) => TerminalBody(props, ctx),
  ))

  ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab.title', key: TAB_ID },
    TerminalTitle,
  ))

  // conversation.composer.dock renders inside the composer card's bottom
  // row, after the input card — the CSS above wraps that row so the dock
  // takes a full-width line below the token meter, at the very bottom of the
  // session column. (conversation.input.dock renders ABOVE the input card,
  // which is the wrong end of the composer.)
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register(
    {
      name: 'conversation.composer.dock',
      id: 'dsh-terminal-dock',
      order: 60,
      label: '终端面板',
    },
    (props) => TerminalDock(props, ctx),
  ))

  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register(
    {
      name: 'conversation.session.header.actions',
      id: 'dsh-terminal',
      order: 30,
      label: '终端',
    },
    TerminalHeaderButton,
  ))

  // DSH >= 0.1.6: 插件 → 插件列表 → 本插件详情。不要用 whileServed 把门：
  // Host 一旦没把 terminal-plugin 认成可服务的 volatile 条目（旧 schemastery
  // 没有 .volatile() 时就会这样），选择器整段消失，位置就改不了。
  // 这个 client 半部能加载，就说明本包已经在 profile 里，配置区应当常驻。
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register(
    { name: 'plugins.bundle.config', key: BUNDLE_KEY },
    TerminalPositionConfigPage,
  ))

  const configForms = typeof ctx.get === 'function' ? ctx.get('configForms') : undefined
  if (typeof configForms?.whileServed !== 'function') {
    // DSH <= 0.1.5 has no Plugins detail slot.
    ctx.slots.inject('settings.general.item', () => ctx.slots.register(
      {
        name: 'settings.general.item',
        id: 'dsh-terminal-position',
        order: 50,
        label: '终端显示位置',
      },
      TerminalPositionSettingRow,
    ))
  }
}
