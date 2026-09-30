/**
 * Lifetime of the bottom-dock shell.
 *
 * `conversation.composer.dock` is session-scoped, so switching sessions
 * unmounts the panel. The shell is not: `acquire` returns the live
 * controller until `restart` or `dispose`.
 */
export function createPinnedRegistry() {
  let current = null
  let generation = 0
  const listeners = new Set()

  function emit() {
    for (const listener of listeners) listener()
  }

  function live() {
    return current && current.disposed !== true ? current : null
  }

  return {
    get generation() {
      return generation
    },
    get current() {
      return live()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    /** Snapshot changed; generation did not. */
    notify() {
      emit()
    },
    acquire(factory) {
      const existing = live()
      if (existing) return existing
      current = factory()
      emit()
      return current
    },
    restart(factory) {
      const previous = current
      generation += 1
      current = factory()
      previous?.dispose?.()
      emit()
      return current
    },
    dispose() {
      const previous = current
      current = null
      generation += 1
      previous?.dispose?.()
      emit()
    },
  }
}
