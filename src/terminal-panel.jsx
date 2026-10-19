/**
 * Bottom-panel terminal body: the official terminal component over the
 * official `webTerminals` view.
 *
 * This extension contributes placement and Desktop entry points only; the
 * PTY, transport, session inventory, theme and screen rendering all come from
 * `@deepseek-ai/dsh-client-ui-sidebar-terminal`. The official `TerminalBody`
 * expects the same contract the sidebar hands it — `useTabInfo`,
 * `useTerminal`, `useTheme`, a `view(key)` lookup and a translator — so the
 * panel supplies a bottom-panel occurrence instead of registering another
 * terminal implementation.
 *
 * Restarting uses the official service: close the current view (which removes
 * its binding and Host process) and mount a fresh one. Collapsing the panel
 * only detaches: the official view and its Host process stay for reattachment.
 */
import React from 'react'
import { loadOfficialTerminalBody } from './official-terminal.js'

/** View key and content identity: one bottom terminal per Session. */
const VIEW_KEY = 'dsh-terminal-bottom'
const CONTENT_ID = 'dsh-terminal-bottom'

/** Minimal theme shape for a runtime whose theme service is unavailable. */
const FALLBACK_THEME = Object.freeze({
  fontSizes: { terminal: 13 },
  fontFamilies: { terminal: '' },
})

/**
 * Official terminal copy (the same strings the official sidebar terminal uses),
 * so the shared component reads naturally in the bottom panel too.
 */
const MESSAGES = {
  new: '新建终端',
  loading: '正在读取终端环境…',
  creating: '正在启动…',
  connecting: '正在连接…',
  disconnected: '连接已断开。',
  reconnect: '重新连接',
  readonly: '此页面当前只读。',
  control: '接管输入',
  closed: '终端已关闭。',
  exited: '进程已退出（{code}）',
  failed: '终端错误：{message}',
  unavailable: '不可用',
  retry: '重试',
  missingTerminal: '此终端已不存在，请新建终端。',
  inputFull: '输入缓冲区已满，请重新连接后重试。',
  attachmentEnded: '终端连接已结束，请重新连接。',
  invalidOutput: '终端画面传输异常，请重新连接。',
  terminalLimit: '终端数量已达上限，请关闭不用的终端后重试。已退出的终端也计入数量。',
}

/**
 * Translate one official terminal message key.
 *
 * @param {string} key - copy key or an unknown state name.
 * @param {Record<string, unknown>} [params] - `{name}` interpolation values.
 * @returns {string} the localized message.
 */
function translate(key, params) {
  const template = MESSAGES[key] ?? String(key ?? '')
  if (params === undefined || params === null) return template
  return template.replace(/\{(\w+)\}/g, (match, name) => (
    name in params ? String(params[name]) : match
  ))
}

/**
 * Render the official terminal inside the bottom panel.
 *
 * @param {object} props - panel props.
 * @param {any} props.ctx - client Cordis context.
 * @param {string} props.sessionId - owning Session.
 * @param {any} props.retention - window-hold bridge from `createRetentionBridge`.
 * @returns {React.ReactElement} the terminal body or a loading/failure message.
 */
export function BottomTerminal({ ctx, sessionId, retention }) {
  const [Body, setBody] = React.useState(null)
  const [error, setError] = React.useState('')
  const [view, setView] = React.useState(null)
  const [generation, setGeneration] = React.useState(0)

  const service = React.useMemo(
    () => (typeof ctx.get === 'function' ? ctx.get('webTerminals') : undefined),
    [ctx],
  )

  // The official renderer is a lazily loaded package chunk; load it only when
  // this panel first opens, and let a later open retry a transient failure.
  React.useEffect(() => {
    let cancelled = false
    loadOfficialTerminalBody(ctx).then((Component) => {
      if (!cancelled) setBody(() => Component)
    }).catch((cause) => {
      if (!cancelled) setError(`无法加载官方终端组件：${cause?.message ?? cause}`)
    })
    return () => {
      cancelled = true
    }
  }, [ctx])

  React.useEffect(() => {
    if (service === undefined || service === null) {
      setError('当前 DSH 版本没有官方终端服务（webTerminals）')
      return undefined
    }
    let current
    try {
      current = service.view(sessionId, VIEW_KEY, CONTENT_ID)
    } catch (cause) {
      setError(`无法打开官方终端：${cause?.message ?? cause}`)
      return undefined
    }
    setView(current)
    retention?.register(sessionId, VIEW_KEY, CONTENT_ID)
    return () => {
      // Collapsing the panel is not closing the terminal: release the window
      // hold (the Host keeps the process for its unattended timeout) and leave
      // the official view in the service so reopening reattaches it.
      retention?.unregister(sessionId)
    }
  }, [service, sessionId, generation, retention])

  const restart = React.useCallback(() => {
    if (service !== undefined && service !== null && view !== null) {
      try {
        service.close(sessionId, VIEW_KEY, CONTENT_ID, view.id)
      } catch { /* the fresh view reports any remaining problem */ }
    }
    setView(null)
    setGeneration((value) => value + 1)
  }, [service, sessionId, view])

  // The official body calls these as hooks; they must keep hook order stable.
  const useTabInfo = React.useMemo(() => function useBottomTabInfo() {
    return {
      tab: {
        id: VIEW_KEY,
        visible: true,
        actions: { openTab: restart },
      },
    }
  }, [restart])

  const useTerminal = React.useMemo(() => {
    if (view === null) return undefined
    return function useBottomTerminalState() {
      return React.useSyncExternalStore(
        (callback) => view.state.subscribe(callback),
        () => view.state.getSnapshot(),
      )
    }
  }, [view])

  const useTheme = React.useMemo(() => {
    const themeOf = () => {
      const themeService = typeof ctx.get === 'function' ? ctx.get('theme') : undefined
      return typeof themeService?.getTheme === 'function' ? themeService.getTheme() : FALLBACK_THEME
    }
    const subscribe = (callback) => (
      typeof ctx.on === 'function' ? ctx.on('theme/change', callback) : () => {}
    )
    return function useBottomTheme(selector) {
      const value = React.useSyncExternalStore(subscribe, themeOf)
      return typeof selector === 'function' ? selector(value) : value
    }
  }, [ctx])

  const viewOf = React.useCallback(() => view, [view])

  if (error !== '') {
    return <div className="dsh-term-message" role="alert">{error}</div>
  }
  if (Body === null || view === null || useTerminal === undefined) {
    return <div className="dsh-term-message">正在加载官方终端…</div>
  }
  return (
    <Body
      useTabInfo={useTabInfo}
      useTerminal={useTerminal}
      useTheme={useTheme}
      view={viewOf}
      t={translate}
    />
  )
}
