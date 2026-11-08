window.__ModuleLoader__.load({
  id: '@1panel/dsh-ctrl-enter-send',
  factory(require) {
    /** The resident composer's editable root (Lexical binds to this node). */
    const COMPOSER_INPUT = '[data-composer-input]'
    /** The open slash / reference candidate menu surface. */
    const TRIGGER_MENU = '[data-trigger-menu]'
    /** Set while this plugin replays the composer's own Shift+Enter path. */
    let replaying = false

    /** Resolve the composer root around an event target, when it is editable. */
    function composerRootOf(target) {
      if (target === null || typeof target !== 'object') return null
      if (typeof target.closest !== 'function') return null
      const root = target.closest(COMPOSER_INPUT)
      if (root === null || root === undefined) return null
      if (root.getAttribute('contenteditable') !== 'true') return null
      return root
    }

    /** Whether an open candidate menu owns plain Enter right now. */
    function candidateMenuOpen() {
      return document.querySelector(TRIGGER_MENU) !== null
    }

    /** Whether this Enter belongs to an IME composition instead of a gesture. */
    function composing(event, root) {
      if (event.isComposing === true) return true
      if (event.keyCode === 229) return true
      return root.hasAttribute('data-composer-composing')
    }

    /**
     * Replay the composer's own Shift+Enter path: the shipped keymap turns a
     * plain Enter into a submission, while its Shift+Enter binding falls
     * through to Lexical's line-break insertion. Dispatching that same shape
     * keeps draft text, chips, and IME state in the owner's hands, so this
     * plugin never edits the draft itself.
     */
    function insertLineBreak(root, source) {
      const lineBreak = new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        location: 0,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        repeat: source.repeat === true,
      })
      replaying = true
      try {
        root.dispatchEvent(lineBreak)
      } finally {
        replaying = false
      }
    }

    /**
     * Own plain Enter inside the composer so sending moves to Ctrl/Cmd+Enter.
     * Every other gesture — Shift, Alt, AltGraph, Ctrl, Cmd, IME composition,
     * and the open candidate menu — keeps its shipped behavior.
     */
    function onKeyDown(event) {
      if (replaying) return
      if (event.defaultPrevented) return
      if (event.key !== 'Enter') return
      const root = composerRootOf(event.target)
      if (root === null) return
      if (composing(event, root)) return
      if (event.altKey === true || event.shiftKey === true) return
      if (event.ctrlKey === true || event.metaKey === true) return
      if (typeof event.getModifierState === 'function' && event.getModifierState('AltGraph')) return
      if (candidateMenuOpen()) return
      // Capture-phase takeover: the composer's own keymap listens on the
      // editable root and would submit this same event, so stop it before it
      // reaches that handler and replay only the line break it would have run.
      event.preventDefault()
      event.stopPropagation()
      if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation()
      insertLineBreak(root, event)
    }

    return {
      apply(ctx) {
        ctx.effect(() => {
          window.addEventListener('keydown', onKeyDown, true)
          return () => {
            window.removeEventListener('keydown', onKeyDown, true)
          }
        }, 'ctrl-enter-send: composer keydown')
      },
    }
  },
})
