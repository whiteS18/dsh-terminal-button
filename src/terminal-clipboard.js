/**
 * Clipboard shortcuts for the bottom-panel terminal.
 *
 * The official `TerminalBody` owns the xterm instance but ships no clipboard
 * key handling of its own. xterm consumes Ctrl+C as SIGINT and Ctrl+V as ^V, so
 * the only clipboard paths the browser reaches are native Ctrl+Insert /
 * Shift+Insert and the context menu. 0.3.x had its own xterm and a custom key
 * handler that implemented Ctrl+Shift+C/V; the 0.4.x extension lost those
 * shortcuts. This module restores them without taking over the renderer:
 *
 *   - copy (Ctrl+Shift+C): xterm answers a `copy` event fired inside the
 *     terminal root by writing its selection into `clipboardData`. The browser
 *     copy command dispatches exactly that event, so the official renderer
 *     stays the single owner of the selection model.
 *   - paste (Ctrl+Shift+V, and Ctrl+V on Windows/Linux): the clipboard text is
 *     read and replayed as a `paste` event on xterm's helper textarea, whose
 *     official listener feeds the PTY (including bracketed-paste mode).
 *
 * Only these chords are claimed. Typing, Ctrl+C interrupt, mouse selection and
 * the native macOS Cmd+C / Cmd+V paths keep their terminal behavior.
 */

/** The xterm root the official renderer creates inside the panel body. */
const TERMINAL_SELECTOR = '.xterm'
/** xterm's hidden input; receives the replayed paste event. */
const TEXTAREA_SELECTOR = 'textarea.xterm-helper-textarea'
/** xterm's selection layer; children exist only while a selection is active. */
const SELECTION_SELECTOR = '.xterm-selection'

/**
 * @param {any} navigatorLike - `navigator` (or a test double).
 * @returns {boolean} whether the runtime is macOS/iOS.
 */
export function isMacPlatform(navigatorLike) {
  const platform = navigatorLike?.userAgentData?.platform ?? navigatorLike?.platform ?? ''
  return /mac|iphone|ipad|ipod/iu.test(platform)
}

/**
 * Map a keydown to a clipboard action.
 *
 * Ctrl+Shift+C/V is the cross-platform pair. Ctrl+V is also claimed on
 * Windows/Linux (the 0.3.x behavior users know) but left alone on macOS, where
 * the physical Control chord is terminal input and Cmd+V works natively.
 *
 * @param {KeyboardEvent | any} event - keydown event.
 * @param {boolean} [mac] - whether the runtime is macOS.
 * @returns {'copy' | 'paste' | null} claimed action, or null to pass through.
 */
export function clipboardAction(event, mac = false) {
  if (!event || event.isComposing || event.altKey || event.repeat) return null
  if (event.metaKey) return null
  const ctrl = event.ctrlKey === true
  if (!ctrl) return null
  const shift = event.shiftKey === true
  if (event.code === 'KeyC' && shift) return 'copy'
  if (event.code === 'KeyV' && shift) return 'paste'
  if (event.code === 'KeyV' && !shift && mac !== true) return 'paste'
  return null
}

/**
 * Whether the official renderer currently shows a model selection.
 *
 * Works without touching xterm internals: its DOM renderer keeps the selection
 * rectangles in `.xterm-selection` and empties that layer when nothing is
 * selected.
 *
 * @param {any} xterm - terminal root element.
 * @returns {boolean} true when a selection is active.
 */
export function hasSelection(xterm) {
  const layer = xterm?.querySelector?.(SELECTION_SELECTOR)
  return (layer?.childElementCount ?? 0) > 0
}

/**
 * Copy the terminal's current selection through the browser copy command.
 *
 * `execCommand('copy')` dispatches a `copy` event on the focused element; the
 * event bubbles to the terminal root, where xterm writes its selection into
 * `clipboardData` and prevents the default. Nothing is copied when there is no
 * selection, so the clipboard is never cleared by accident.
 *
 * @param {any} xterm - terminal root element.
 * @param {Document | any} documentLike - document owning the terminal.
 * @returns {boolean} whether a copy command was issued.
 */
export function copySelection(xterm, documentLike) {
  if (!hasSelection(xterm)) return false
  const textarea = xterm.querySelector?.(TEXTAREA_SELECTOR)
  if (!textarea) return false
  if (documentLike?.activeElement !== textarea) textarea.focus?.()
  try {
    return documentLike?.execCommand?.('copy') === true
  } catch {
    return false
  }
}

/**
 * Paste the current clipboard text into the terminal.
 *
 * The text is replayed as a `paste` event on xterm's helper textarea so the
 * official listener keeps applying bracketed paste and newline handling.
 *
 * @param {any} xterm - terminal root element.
 * @param {{
 *   clipboard?: any,
 *   ClipboardEvent?: any,
 *   DataTransfer?: any,
 * }} [options] - test seams; production resolves the globals.
 * @returns {Promise<boolean>} whether a paste event was dispatched.
 */
export async function pasteClipboard(xterm, options = {}) {
  if (!xterm) return false
  const clipboard = options.clipboard ?? globalThis.navigator?.clipboard
  if (typeof clipboard?.readText !== 'function') return false
  let text
  try {
    text = await clipboard.readText()
  } catch {
    // Denied or unavailable clipboard: leave the terminal untouched.
    return false
  }
  if (typeof text !== 'string' || text === '') return false
  const ClipboardEventCtor = options.ClipboardEvent ?? globalThis.ClipboardEvent
  const DataTransferCtor = options.DataTransfer ?? globalThis.DataTransfer
  if (typeof ClipboardEventCtor !== 'function' || typeof DataTransferCtor !== 'function') return false
  const data = new DataTransferCtor()
  data.setData('text/plain', text)
  const target = xterm.querySelector?.(TEXTAREA_SELECTOR) ?? xterm
  // The panel may have closed while the clipboard read was pending.
  if (target.isConnected === false) return false
  target.dispatchEvent(new ClipboardEventCtor('paste', {
    clipboardData: data,
    bubbles: true,
    cancelable: true,
  }))
  return true
}

/**
 * Claim the clipboard chords inside a panel container.
 *
 * The listener runs in the capture phase so it sees Ctrl+Shift+C/V (and
 * Windows/Linux Ctrl+V) before xterm's own textarea keydown listener. Events
 * outside a terminal (e.g. the panel's close button) pass through untouched.
 *
 * @param {HTMLElement | any} container - panel body element.
 * @param {{
 *   document?: any,
 *   window?: any,
 *   mac?: boolean,
 *   clipboard?: any,
 *   ClipboardEvent?: any,
 *   DataTransfer?: any,
 * }} [options] - test seams.
 * @returns {() => void} disposer removing the listener.
 */
export function installTerminalClipboard(container, options = {}) {
  if (typeof container?.addEventListener !== 'function') return () => {}
  const documentLike = options.document
    ?? container.ownerDocument
    ?? globalThis.document
  const windowLike = options.window ?? documentLike?.defaultView
  const mac = options.mac ?? isMacPlatform(windowLike?.navigator)

  const onKeyDown = (event) => {
    const action = clipboardAction(event, mac)
    if (action === null) return
    const target = event.target
    if (typeof target?.closest !== 'function') return
    const xterm = target.closest(TERMINAL_SELECTOR)
    if (xterm === null) return
    if (typeof container.contains === 'function' && !container.contains(xterm)) return
    event.preventDefault()
    event.stopPropagation()
    if (action === 'copy') {
      copySelection(xterm, documentLike)
      return
    }
    pasteClipboard(xterm, options).catch(() => {})
  }

  container.addEventListener('keydown', onKeyDown, true)
  return () => container.removeEventListener('keydown', onKeyDown, true)
}
