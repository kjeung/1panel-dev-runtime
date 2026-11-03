import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

// The image ships the market next to DSH's own packages, where its
// `@deepseek-ai/*` peers resolve, and the overlay row names it by absolute
// path. That keeps the data volume free of image-owned symlinks and lets the
// client roster find `dsh.client` from the package's nearest manifest.
// Overridable so the same assertions can run against a checkout fixture.
const IMAGE_ROOT = '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/dshmarket'
const packageRoot = process.env.DSH_MARKET_ROOT ?? IMAGE_ROOT
const patchPath =
  process.env.DSH_MARKET_PATCH ?? '/opt/deepseek-harness/web-market.cordis.patch.yml'
const desktopPatchPath =
  process.env.DSH_DESKTOP_PATCH ?? '/opt/deepseek-harness/web-desktop.cordis.patch.yml'
const fixture = process.env.DSH_MARKET_ROOT !== undefined

const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))

/** Read the `- id: … / name: …` rows of an overlay file, in order. */
function rowsOf(source) {
  return [...source.matchAll(/^\s+-\s+id:\s*(\S+)\s*\n\s+name:\s*(\S+)/gm)].map(
    ([, id, name]) => ({ id, name }),
  )
}

test('the image ships dsh-market as a DSH bundle', () => {
  assert.equal(manifest.name, 'dshmarket')
  assert.match(manifest.version, /^\d+\.\d+\.\d+/)
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.ok(manifest.dependencies && 'undici' in manifest.dependencies)
})

test('the plugin declares the Web client half the roster needs', () => {
  assert.equal(manifest.dsh?.client?.platform, 'web')
  assert.ok(Array.isArray(manifest.dsh.client.inject))
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings'))
})

test('the market overlay mounts the image copy by absolute path', () => {
  const patch = readFileSync(patchPath, 'utf8')
  const rows = rowsOf(patch)
  assert.deepEqual(rows.map((row) => row.id), ['dsh-market'])
  const entry = rows[0].name
  assert.ok(isAbsolute(entry), `overlay must use an absolute path, got ${entry}`)
  assert.equal(entry, join(IMAGE_ROOT, manifest.main))
  if (!fixture) assert.ok(existsSync(entry), `market entry is missing from the image: ${entry}`)
  assert.match(patch, /DSH_MARKET_ENABLED === '0'/)
  assert.match(patch, /^\s+allowRestart: false$/m)
})

test('the desktop overlay mounts every image plugin by absolute path', () => {
  const rows = rowsOf(readFileSync(desktopPatchPath, 'utf8'))
  assert.deepEqual(
    rows.map((row) => row.id),
    ['browser-use', 'browser-use-playwright-mcp', 'browser-desktop'],
  )
  for (const row of rows) {
    assert.ok(isAbsolute(row.name), `${row.id} must use an absolute path, got ${row.name}`)
    assert.ok(existsSync(row.name), `${row.id} entry is missing from the image: ${row.name}`)
  }
})

test('the host can import the plugin module', async () => {
  const module = await import(pathToFileURL(join(packageRoot, manifest.main)).href)
  assert.equal(module.name, 'dsh-market')
  assert.equal(typeof module.apply, 'function')
})
