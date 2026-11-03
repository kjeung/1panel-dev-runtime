import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

// The Dockerfile installs the market next to DSH's own packages, where its
// `@deepseek-ai/*` peers resolve. The entrypoint links that copy into the Web
// profile, which is what the loader resolves the `dsh-market` row against.
// Overridable so the same assertions can run against a checkout.
const packageRoot =
  process.env.DSH_MARKET_ROOT ??
  '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/dshmarket'
const patchPath =
  process.env.DSH_MARKET_PATCH ?? '/opt/deepseek-harness/web-market.cordis.patch.yml'

const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))

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

test('the profile link resolves the plugin through a profile module directory', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'dsh-market-profile-'))
  try {
    const modules = join(profile, 'node_modules')
    await mkdir(modules)
    // The entrypoint creates exactly this symlink; the loader resolves the
    // `dshmarket` package name from the profile, the way DSH resolves every
    // profile plugin.
    await symlink(packageRoot, join(modules, 'dshmarket'), 'dir')
    const require = createRequire(join(profile, 'package.json'))
    const resolved = require.resolve('dshmarket')
    assert.equal(resolved, join(await realpath(packageRoot), manifest.main))
  } finally {
    await rm(profile, { recursive: true, force: true })
  }
})

test('the image overlay mounts the market without image-owned restart', async () => {
  const patch = await readFile(patchPath, 'utf8')
  assert.match(patch, /^- insert:$/m)
  assert.match(patch, /^\s+- id: dsh-market$/m)
  assert.match(patch, /^\s+name: dshmarket$/m)
  assert.match(patch, /DSH_MARKET_ENABLED === '0'/)
  assert.match(patch, /^\s+allowRestart: false$/m)
})

test('the host can import the plugin module', async () => {
  const module = await import(pathToFileURL(join(packageRoot, manifest.main)).href)
  assert.equal(module.name, 'dsh-market')
  assert.equal(typeof module.apply, 'function')
})
