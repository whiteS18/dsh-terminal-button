/**
 * Placement setting vocabulary.
 *
 * The official sidebar terminal now owns the right-sidebar tab, so the only
 * placements this extension still contributes are the bottom panel and the
 * Desktop-native system terminal window. `sidebar` was this plugin's own tab
 * before 0.4.0; it remains an accepted stored value so an old profile does not
 * fail schema validation, but it normalizes to the bottom panel.
 */

/** Labels for the placements the settings row offers. */
export const POSITIONS = {
  bottom: '底部面板',
  external: '系统弹窗',
}

/**
 * Collapse any stored placement onto a supported one.
 *
 * @param {unknown} value - stored setting value.
 * @returns {'bottom' | 'external'} the effective placement.
 */
export function normalizePosition(value) {
  return value === 'external' ? 'external' : 'bottom'
}

/**
 * @param {unknown} value - stored setting value.
 * @returns {string} the label shown in the settings row.
 */
export function positionLabel(value) {
  return POSITIONS[normalizePosition(value)]
}
