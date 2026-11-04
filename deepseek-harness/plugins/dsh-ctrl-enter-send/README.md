# `@1panel/dsh-ctrl-enter-send`

Makes the DeepSeek Harness composer send with **Ctrl+Enter** (or **Cmd+Enter**
on macOS) instead of plain Enter. While the plugin is enabled, a bare Enter
inserts a line break; disable the plugin and Enter sends again.

| | plugin enabled | plugin disabled |
| --- | --- | --- |
| plain `Enter` | inserts a line break | sends the message |
| `Ctrl`/`Cmd` + `Enter` | sends the message | uses the shipped complementary delivery (Queue / Steer) |
| `Shift` + `Enter` | inserts a line break | inserts a line break |
| candidate menu (`/`, `@`) | `Enter` picks the highlighted item | `Enter` picks the highlighted item |
| IME composition | `Enter` is left to the IME | `Enter` is left to the IME |

## Why a listener instead of a slot

The shipped composer owns its keymap: `ui-conversation` registers
`KEY_ENTER_COMMAND` on the resident Lexical editor and turns that gesture into
a submission. There is no slot or setting for "which chord sends", so this
plugin takes plain Enter in the capture phase, stops it before the composer
keymap sees it, and replays the composer's own `Shift+Enter` shape. The owner
still performs the line-break insertion, so draft text, chips, the claimed
slash command, undo history, and IME state all stay in its hands — the plugin
never edits the draft itself.

Guards keep the gesture surgical: it only reacts inside the editable composer
(`[data-composer-input]` with `contenteditable="true"`), only for an unmodified
Enter, never during IME composition, and never while the slash/reference menu
is open (that menu owns `Enter` for picking a candidate).

## Install

The plain-HTTP image loads it the same way it loads the other vendored
plugins: as a profile bundle.

```bash
dsh plugin add /opt/deepseek-harness/plugins/dsh-ctrl-enter-send
```

Or install from a source checkout with the plugin manager's `install_bundle`
action pointed at this directory. Toggle it on the Plugins page (or with
`plugin_manager set_plugin include:ctrl-enter-send enabled:false`) to switch
between Ctrl+Enter and Enter.

## Refresh behavior

A newly installed Client module loads on the next page load; the bundled
`client.js` is served from the module route with a content revision, so the
page also picks it up on reload after an edit.

## Files

| file | purpose |
| --- | --- |
| `index.js` | Host half — intentionally empty; the behavior is Client-side only |
| `client.js` | The `window.__ModuleLoader__` Client module and the key listener |
| `cordis.patch.yml` | Bundle patch inserting the plugin row |
| `locale/en.json`, `locale/zh.json` | Plugin Manager title and description |
| `icon.svg` | Plugin artwork (Enter/backspace glyph) |
