/**
 * dsh-terminal-button — Client half (browser bundle).
 *
 * An extension of DeepSeek Harness's official terminal
 * (`@deepseek-ai/dsh-client-ui-sidebar-terminal`), not a second terminal.
 * DSH 0.2.1 ships a right-sidebar terminal; this plugin no longer registers a
 * competing sidebar tab and no longer runs its own xterm/WebSocket/PTY stack.
 * What it adds:
 *
 *   - "bottom" placement: the official terminal body rendered in
 *     `conversation.composer.dock`, below the composer, with a resizable panel
 *     and a persistent-per-Session view through the official `webTerminals`
 *     service.
 *   - Desktop entry-point redirection: the tray/settings/titlebar "open
 *     terminal" affordance opens this bottom panel instead of a system window
 *     (the Host half patches `desktopRuntime.openTerminal` and pushes an SSE
 *     `open`; the "external" placement falls through to the system window).
 *   - A settings row for that placement.
 *
 * The terminal itself — PTY, transport, session inventory, theme, xterm — is
 * the official implementation. This half only supplies a bottom-panel
 * occurrence: the official `TerminalBody` component is loaded from the
 * official package's lazy chunk and wired to a `webTerminals` view, exactly as
 * the sidebar does, plus the window-hold bridge that keeps that view alive
 * without a sidebar tab.
 */
import React from 'react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import { createRetentionBridge } from './terminal-retention.js'
import { BottomTerminal } from './terminal-panel.jsx'
import { normalizePosition, POSITIONS } from './position.js'
import { shouldCollapseDock } from './dock-visibility.js'

const { Menu } = primitives
// Icon exports were renamed in DSH 0.1.7 (size suffix dropped for Regular/
// Medium weights); resolve whichever name this runtime exports.
const IconChevronDownOutline14 = primitives.IconChevronDownOutline14
  ?? primitives.IconChevronDownOutlineRegular
  ?? primitives.IconChevronDownOutlineMedium

export const name = 'dsh-terminal-button'
// `webTerminals` is the official client terminal service; requiring it makes
// this plugin an extension of that service instead of a parallel terminal.
export const inject = ['slots', 'webTerminals']

const EVENTS_PATH = '/dsh-terminal/events'
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

const CSS = [
  '.dsh-term-dock{order:1;flex:none;box-sizing:border-box;width:calc(100% + var(--dsh-composer-side-clearance,16px) * 2);margin:0 calc(var(--dsh-composer-side-clearance,16px) * -1);position:relative;z-index:30;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base));border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.25));border-radius:12px;overflow:hidden}',
  '.dsh-term-dock-drag{flex:none;height:5px;cursor:row-resize}',
  '.dsh-term-dock-drag:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.18))}',
  '.dsh-term-dock-head{flex:none;display:flex;align-items:center;gap:8px;padding:6px 10px 4px;color:var(--dsw-alias-label-secondary,#ccc);font-size:12px}',
  '.dsh-term-dock-head svg{width:14px;height:14px}',
  '.dsh-term-dock-head-title{font-weight:500}',
  '.dsh-term-dock-head-cwd{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary,#999);font-size:11px;direction:rtl;text-align:left}',
  '.dsh-term-dock-body{flex:none;min-height:0;overflow:hidden}',
  '.dsh-term-dock-body>section{height:100%}',
  '.dsh-term-iconbtn{width:24px;height:24px;flex:none;border:none;border-radius:6px;background:0 0;color:var(--dsw-alias-label-tertiary,#999);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;padding:4px}',
  '.dsh-term-iconbtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.15));color:var(--dsw-alias-label-secondary,#ccc)}',
  '.dsh-term-message{padding:12px 14px;color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:18px}',
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
  if (document.querySelector('style[data-plugin="dsh-terminal-button"]') !== null) return
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

/**
 * Collapse the bottom dock when the conversation enters its new-session
 * ("hero") screen. DSH renders the `conversation.composer.dock` slot only on
 * an active conversation, so a dock left open there would be invisible while
 * the user starts a session and then pop back on its own after the first
 * message. Collapsing on entry keeps the panel consistent: it is visible only
 * where it can be visible, and only an explicit "open terminal" brings it
 * back. The official terminal view keeps its Host process; hiding the panel
 * only detaches the screen.
 *
 * `data-content-phase` is the conversation body's own phase marker
 * ('settling' | 'hero' | 'active'), used by DSH's layout CSS as well; runtimes
 * that lack it simply leave the dock alone. Only visible markers count, in
 * case the shell keeps a background conversation view mounted.
 */
function watchConversationPhase() {
  if (typeof MutationObserver !== 'function') return () => {}
  const phases = () => Array.from(document.querySelectorAll('[data-content-phase]'))
  // Cheap gate first: the attribute read costs no layout, and during normal
  // streaming there is no hero marker at all.
  const heroMarked = () => phases().some((el) => el.getAttribute('data-content-phase') === 'hero')
  // Only visible markers count, in case the shell keeps a background
  // conversation view mounted. `getClientRects` is deferred until a hero
  // marker actually exists, so active streaming never forces layout here.
  const heroVisible = () => phases().some(
    (el) => el.getAttribute('data-content-phase') === 'hero' && el.getClientRects().length > 0,
  )
  const sync = () => {
    if (!heroMarked()) return
    if (!shouldCollapseDock('hero', dockStore.getSnapshot()?.open)) return
    if (heroVisible()) closeDock()
  }
  const observer = new MutationObserver(sync)
  observer.observe(document.body, {
    attributes: true,
    attributeFilter: ['data-content-phase'],
    childList: true,
    subtree: true,
  })
  sync()
  return () => observer.disconnect()
}

// ---------------------------------------------------------------------------
// Placement setting
// ---------------------------------------------------------------------------

/** Wrap one host-backed settingsScope key as a plain snapshot store. */
function createSettingStore(scope, key, fallback) {
  if (!scope) return { getSnapshot: () => normalizePosition(fallback), subscribe: () => () => {}, set() {} }
  return {
    getSnapshot() {
      return normalizePosition(scope.getSnapshot()?.value?.[key] ?? fallback)
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
 * Writes go through `mutate` without a caller revision. DSH 0.2 calls
 * `describe()` inside the write, and that call itself bumps the revision
 * whenever the fingerprint changes, so a revision captured before the click
 * is already stale and the host refuses it as a conflict. The form queue
 * still fences later writes with the revision the host just answered.
 */
function bindPositionStore(ctx) {
  const settingsScope = typeof ctx.get === 'function' ? ctx.get('settingsScope') : undefined
  if (typeof settingsScope?.bind === 'function') {
    const scope = settingsScope.bind({
      namespace: SETTINGS_NAMESPACE,
      decode: (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : undefined),
    })
    return createSettingStore(scope, POSITION_KEY, 'bottom')
  }
  const configForms = typeof ctx.get === 'function' ? ctx.get('configForms') : undefined
  if (typeof configForms?.get === 'function') {
    const scope = configForms.get(CONFIG_ENTRY_ID)
    return {
      getSnapshot() {
        return normalizePosition(scope.getSnapshot()?.value?.[POSITION_KEY])
      },
      subscribe(callback) {
        return scope.subscribe(callback)
      },
      set(value) {
        const write = scope.mutate([{ op: 'set', path: [POSITION_KEY], value }])
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
  return { getSnapshot: () => 'bottom', subscribe: () => () => {}, set() {} }
}

/**
 * Assigned in apply(); components subscribe directly via useSyncExternalStore
 * instead of the slot `inject` hooks conversion — that conversion is not
 * wired up on every slot's render path (e.g. conversation.composer.dock).
 */
let positionStore = {
  getSnapshot: () => 'bottom',
  subscribe: () => () => {},
  set() {},
}
/** Assigned in apply(); keeps the official view's window hold across tab churn. */
let retentionBridge = null

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
// Placement
// ---------------------------------------------------------------------------

/**
 * Open the terminal wherever the placement setting points.
 * `external` has no in-app panel: ask the Host for the Desktop-native window.
 */
function openTerminal() {
  if (positionStore.getSnapshot() === 'external') {
    fetch(OPEN_NATIVE_PATH, { method: 'POST' }).catch(() => {})
    return
  }
  openDock()
}

// ---------------------------------------------------------------------------
// Bottom panel
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
        {sessionId
          ? <BottomTerminal key={sessionId} ctx={ctx} sessionId={sessionId} retention={retentionBridge} />
          : <div className="dsh-term-message">请先在会话中打开终端</div>}
      </div>
    </div>
  )
}

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
        <span className="dsh-term-setting-desc">终端打开在底部面板，或改用系统终端弹窗（右侧栏终端由官方提供）</span>
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
            {POSITIONS[position] ?? POSITIONS.bottom}
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
      if (event.data === 'open') openTerminal()
    }
    cleanups.push(() => source.close())
  }
  const onNativeOpen = () => openTerminal()
  window.addEventListener('dsh-desktop:open-terminal', onNativeOpen)
  cleanups.push(() => window.removeEventListener('dsh-desktop:open-terminal', onNativeOpen))
  return () => {
    for (const cleanup of cleanups) cleanup()
  }
}

// ---------------------------------------------------------------------------
// Conversation header button (conversation.session.header.actions): opens the
// terminal wherever the placement setting points.
// ---------------------------------------------------------------------------

function TerminalHeaderButton() {
  return (
    <button
      type="button"
      className="dsh-term-header-btn"
      aria-label="打开终端"
      title="打开终端"
      onClick={() => openTerminal()}
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

  // Keep the official terminal service's window holds aware of a bottom-panel
  // terminal that has no sidebar tab. Disposed with this plugin fiber.
  retentionBridge = createRetentionBridge(ctx.webTerminals)
  ctx.effect(() => () => {
    retentionBridge?.dispose()
    retentionBridge = null
  })

  ctx.effect(() => installOpenEvents())
  // Hide the bottom panel on the new-session screen instead of letting it
  // reappear by itself once the first message starts the conversation.
  ctx.effect(() => watchConversationPhase())

  // conversation.composer.dock renders inside the composer card's bottom
  // row, after the input card — the CSS above wraps that row so the dock
  // takes a full-width line below the token meter, at the very bottom of the
  // session column.
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
