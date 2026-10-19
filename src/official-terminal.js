/**
 * Loader for the official terminal body component.
 *
 * The official right-sidebar terminal ships its renderer as a package-local
 * dynamic chunk (`lib/client.terminal.js`) that bundles xterm and the official
 * screen/theme/cursor behavior. The client module system exposes that chunk
 * importer on its `modules` service, so this extension renders the very same
 * component instead of shipping a second xterm stack:
 *
 *   modules.importChunk('@deepseek-ai/dsh-client-ui-sidebar-terminal',
 *                       'client.terminal.js') -> { TerminalBody }
 *
 * `TerminalBody` is a plain React component parameterized by hooks and a view
 * lookup: `{ useTabInfo, useTerminal, useTheme, view, t }`. The bottom panel
 * supplies the same interoccurrence contract the sidebar gives it. The chunk is
 * loaded lazily (only when the panel first opens) and memoized; a failed load
 * is retried on the next open.
 */

/** Package that owns the official terminal body chunk. */
const TERMINAL_PACKAGE = '@deepseek-ai/dsh-client-ui-sidebar-terminal'
/** Package-local chunk file name. */
const TERMINAL_CHUNK = 'client.terminal.js'

/** @type {Promise<Function> | undefined} */
let pending

/**
 * @param {any} ctx - client Cordis context.
 * @returns {Promise<Function>} the official `TerminalBody` component.
 */
export function loadOfficialTerminalBody(ctx) {
  if (pending === undefined) {
    pending = (async () => {
      const modules = typeof ctx?.get === 'function' ? ctx.get('modules') : undefined
      if (typeof modules?.importChunk !== 'function') {
        throw new Error('当前 DSH 版本不支持加载官方终端组件')
      }
      const chunk = await modules.importChunk(TERMINAL_PACKAGE, TERMINAL_CHUNK)
      if (typeof chunk?.TerminalBody !== 'function') {
        throw new Error('官方终端组件缺少 TerminalBody 导出')
      }
      return chunk.TerminalBody
    })()
    pending.catch(() => {
      // Allow a later open to retry after a transient load failure.
      pending = undefined
    })
  }
  return pending
}
