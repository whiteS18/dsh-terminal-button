/**
 * Official terminal copy and bottom-status reduction.
 *
 * `webTerminals` view snapshots speak in phases (`loading`, `creating`,
 * `connecting`, `connected`, `disconnected`, `failed`, `closed`), optional
 * issues (`missingTerminal`, `inputFull`, …) and raw error messages. The
 * official `TerminalBody` maps those with its own locale; the bottom status row
 * outside the official component needs the same vocabulary, kept here as plain
 * data so it is testable without React or a DOM.
 */

/** Official terminal copy (the same strings the official sidebar terminal uses). */
export const MESSAGES = {
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

/** Bottom status-bar badge states, matching the pre-0.4 panel. */
export const STATUS_LABELS = {
  connecting: '连接中',
  ready: '运行中',
  exit: '已退出',
  error: '错误',
}

/**
 * Translate one official terminal message key.
 *
 * @param {string} key - copy key or an unknown state name.
 * @param {Record<string, unknown>} [params] - `{name}` interpolation values.
 * @returns {string} the localized message.
 */
export function translate(key, params) {
  const template = MESSAGES[key] ?? String(key ?? '')
  if (params === undefined || params === null) return template
  return template.replace(/\{(\w+)\}/g, (match, name) => (
    name in params ? String(params[name]) : match
  ))
}

/**
 * Whether a missing terminal came from a *restore* attempt and can therefore
 * be healed by creating a fresh terminal.
 *
 * A `terminal/unavailable` failure is `missingTerminal` in two cases:
 *  - a restored view (saved Host id) whose process is gone — the safe case:
 *    allocate a new terminal instead of asking the user to click;
 *  - a brand-new view whose creation failed (Host/session unavailable) — a
 *    retry would only fail again, so leave the explicit UI in charge.
 *
 * The official view marks the difference with `createWhenMissing`: false means
 * the view was built from a saved binding and may never allocate by itself.
 * Runtimes without that field default to the restore case, paired with the
 * component's one-retry-until-healthy guard.
 *
 * @param {any} state - official `webTerminals` view snapshot.
 * @param {any} view - official view that produced the snapshot.
 * @returns {boolean} true when the panel should recreate the terminal.
 */
export function isRestoredMissingTerminal(state, view) {
  if (state?.issue !== 'missingTerminal') return false
  if (view === null || typeof view !== 'object') return false
  if (typeof view.createWhenMissing === 'boolean') return view.createWhenMissing === false
  return true
}

/**
 * Reduce one official view snapshot to the bottom status bar's badge/actions.
 *
 * A `terminal/view` failure stores the issue token as its message
 * (`state.error === 'missingTerminal'`), so prefer the translated issue: the
 * raw token must never reach the status row.
 *
 * @param {any} state - official `webTerminals` view snapshot.
 * @returns {{ state: string, label: string, message?: string, restart?: boolean }} status row.
 */
export function statusOf(state) {
  const phase = state?.phase
  const info = state?.info
  if (phase === 'failed' || phase === 'disconnected' || info?.state === 'failed') {
    const message = state?.issue !== undefined
      ? translate(state.issue)
      : (typeof state?.error === 'string' && state.error !== '' ? state.error : undefined)
    return { state: 'error', label: STATUS_LABELS.error, message, restart: true }
  }
  if (phase === 'closed' || info?.state === 'exited') {
    return { state: 'exit', label: STATUS_LABELS.exit, restart: true }
  }
  if (phase === 'connected' && info?.state === 'running') {
    return { state: 'ready', label: STATUS_LABELS.ready }
  }
  return { state: 'connecting', label: STATUS_LABELS.connecting }
}
