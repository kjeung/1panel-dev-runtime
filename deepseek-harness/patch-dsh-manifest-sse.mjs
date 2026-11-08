import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

// Build-time patches for the two Web surfaces that need behaviour the upstream
// prebuilt packages do not provide:
//   1. the manifest link must request credentials, or a browser behind an
//      authenticated reverse proxy fetches it without its session cookie;
//   2. the HMR SSE channel must send a heartbeat, or a reverse proxy with an
//      idle read timeout cuts the otherwise-silent stream.
// Both replacements are exact-string matches so a DSH upgrade fails the image
// build instead of silently shipping an unpatched frontend.
const dshRoot = resolve(process.argv[2] ?? '/usr/local/lib/node_modules/@deepseek-ai/dsh')
const requireFromDsh = createRequire(join(dshRoot, 'package.json'))

async function packageRoot(name) {
  const manifestPath = requireFromDsh.resolve(`${name}/package.json`)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (manifest.name !== name) throw new Error(`unexpected package at ${manifestPath}`)
  return dirname(manifestPath)
}

function replaceOnce(source, original, replacement, label) {
  const count = source.split(original).length - 1
  if (count !== 1 || source.includes(replacement)) {
    throw new Error(`unexpected ${label} source shape: original=${count}`)
  }
  return source.replace(original, () => replacement)
}

// 1. Make the browser send its session cookie when it fetches the manifest.
// Chrome fetches manifests with credentials omitted unless the link opts in;
// behind authentik that turns the fetch into a 302 to the SSO host, which the
// browser then blocks as a cross-origin redirect without CORS headers.
const frontendRoot = await packageRoot('@deepseek-ai/dsh-web-frontend')
const indexPath = join(frontendRoot, 'dist/index.html')
const indexOriginal = '<link rel="manifest" href="./manifest.webmanifest" />'
const indexReplacement = '<link rel="manifest" href="./manifest.webmanifest" crossorigin="use-credentials" />'
let indexHtml = replaceOnce(await readFile(indexPath, 'utf8'), indexOriginal, indexReplacement, 'web manifest link')
if (!indexHtml.includes(indexReplacement)) throw new Error('web manifest link patch verification failed')
await writeFile(indexPath, indexHtml, 'utf8')

// 2. Keep the HMR SSE stream alive across reverse proxies. The channel sends
// no data between graph changes, so a 60-120 s idle read timeout (nginx default,
// Cloudflare, LBs) closes it. A comment frame every 15 s is valid SSE and is
// ignored by the browser parser.
const hmrRoot = await packageRoot('@deepseek-ai/dsh-client-hmr')
const hmrPath = join(hmrRoot, 'lib/index.js')
const closeHandler = '\t\tres.on("close", () => {\n\t\t\tconnections.delete(res);\n\t\t});'
const heartbeat = [
  '\t\tconst heartbeat = setInterval(() => {',
  '\t\t\tif (res.destroyed || res.writableEnded) return;',
  '\t\t\ttry { res.write(": ping\\n\\n"); } catch {}',
  '\t\t}, 15e3);',
  '\t\theartbeat.unref();',
  '\t\tres.on("close", () => {',
  '\t\t\tclearInterval(heartbeat);',
  '\t\t\tconnections.delete(res);',
  '\t\t});',
].join('\n')
let hmrSource = replaceOnce(await readFile(hmrPath, 'utf8'), closeHandler, heartbeat, 'HMR SSE close handler')
if (!hmrSource.includes('res.write(": ping\\n\\n")')) throw new Error('HMR SSE heartbeat patch verification failed')
await writeFile(hmrPath, hmrSource, 'utf8')
