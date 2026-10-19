/**
 * Window-hold bridge for the bottom panel's official terminal.
 *
 * The official terminal service (`webTerminals`) reconciles its Host-side
 * window holds from sidebar tab membership: the official sidebar-terminal
 * plugin calls `webTerminals.retainTabs(tabs)` with its open terminal tabs and
 * every hold whose terminal is not in that list is released, which lets the
 * Host reclaim an idle process. The bottom panel is not a sidebar tab, so its
 * hold would be dropped the next time the user opens or closes any sidebar
 * tab. Wrap that one service method once and merge the bottom panel's virtual
 * tab rows into every call.
 *
 * The bridge never creates terminals or touches terminal state; it only keeps
 * the official hold reconciliation aware of a terminal that has no tab.
 */

/**
 * Wrap `webTerminals.retainTabs` so bottom-panel terminals count as open.
 *
 * @param {any} webTerminals - official client terminal service.
 * @returns {{
 *   register: (sessionId: string, tabId: string, contentId: string) => void,
 *   unregister: (sessionId: string) => void,
 *   refresh: () => void,
 *   dispose: () => void,
 * }} bridge with idempotent disposer.
 */
export function createRetentionBridge(webTerminals) {
  const noop = () => {}
  if (webTerminals === null || typeof webTerminals !== 'object' || typeof webTerminals.retainTabs !== 'function') {
    return { register: noop, unregister: noop, refresh: noop, dispose: noop }
  }
  /** Virtual tab rows, one per Session whose bottom panel has a view. */
  const virtual = new Map()
  /** Last tab list the official plugin handed us (its sidebar terminal tabs). */
  let official = []
  let disposed = false
  const original = webTerminals.retainTabs
  const callOriginal = (tabs) => original.call(webTerminals, tabs)
  const merged = () => [...official, ...virtual.values()]
  const patched = (tabs) => {
    official = Array.isArray(tabs) ? [...tabs] : []
    return callOriginal(merged())
  }
  webTerminals.retainTabs = patched
  const reconcile = () => {
    if (!disposed) patched(official)
  }
  return {
    register(sessionId, tabId, contentId) {
      virtual.set(sessionId, { sessionId, tabId, contentId })
      reconcile()
    },
    unregister(sessionId) {
      if (!virtual.delete(sessionId)) return
      reconcile()
    },
    refresh: reconcile,
    dispose() {
      if (disposed) return
      disposed = true
      virtual.clear()
      if (webTerminals.retainTabs === patched) webTerminals.retainTabs = original
      try {
        // Keep the official plugin's own holds; only ours are dropped.
        callOriginal(official)
      } catch { /* service already torn down */ }
    },
  }
}
