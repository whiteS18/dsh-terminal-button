/**
 * Bottom-dock visibility policy for the new-session ("hero") screen.
 *
 * The dock is registered in `conversation.composer.dock`, which DSH renders
 * only outside the hero phase: a brand-new or still-blank session shows the
 * centered hero composer, which has no composer dock slot at all. Keeping the
 * dock's open flag while that screen is up makes the panel invisible now and
 * then pop back on its own once the first message turns the conversation
 * active. Collapse it on entry instead, so the panel's visibility is
 * consistent: it shows only where it can show, and an explicit
 * "open terminal" is the only thing that brings it back. The shell itself is
 * pinned page-wide and keeps running — only the panel collapses.
 */

/**
 * Whether the bottom dock must collapse for one conversation phase.
 *
 * @param {unknown} phase - the conversation body's `data-content-phase`
 *   (`'settling' | 'hero' | 'active'`); undefined on runtimes without it.
 * @param {unknown} open - current dock open flag.
 * @returns {boolean} true when the dock should be closed.
 */
export function shouldCollapseDock(phase, open) {
  return phase === 'hero' && open === true
}
