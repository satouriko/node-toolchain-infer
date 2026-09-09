import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import process from 'node:process'

import { build } from 'esbuild'
import { chromium } from 'playwright'

const listen = (server: Server): Promise<string> =>
  new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      assert.ok(address && typeof address === 'object')
      resolve(`http://127.0.0.1:${address.port}`)
    })
  })
const close = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
let pageOrigin = ''
let preflights = 0
let gets = 0
let revalidated = 0
let offline = false
const sourceServer = createServer((request, response) => {
  if (request.method === 'OPTIONS') {
    preflights++
    response.writeHead(403).end()
    return
  }
  gets++
  if (offline) {
    response.writeHead(503, { 'Access-Control-Allow-Origin': pageOrigin }).end('offline fixture')
    return
  }
  const source = new URL(request.url ?? '/', 'http://localhost').searchParams.get('source') ?? ''
  const etag = '"metadata-cors-fixture"'
  response.setHeader('Access-Control-Allow-Origin', pageOrigin)
  response.setHeader('Access-Control-Expose-Headers', 'ETag, Last-Modified')
  response.setHeader('Cache-Control', 'max-age=3600')
  response.setHeader('ETag', etag)
  response.setHeader('Last-Modified', 'Tue, 08 Sep 2026 00:00:00 GMT')
  if (request.headers['if-none-match'] === etag) {
    revalidated++
    response.writeHead(304).end()
    return
  }
  let body: unknown
  if (source.includes('nodejs.org')) body = [{ version: 'v22.0.0', npm: '10.0.0' }]
  else if (source.endsWith('/tags')) body = { tags: ['4.18.0'] }
  else if (source.endsWith('/releases')) body = { releaseLines: { zpm: { tags: ['6.0.0-rc.20'] } } }
  else body = { versions: { '4.18.0': { version: '4.18.0', engines: { node: '>=18' } } } }
  response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
})
const sourceOrigin = await listen(sourceServer)
const bundle = await build({
  stdin: {
    contents: `import {fetchMetadata} from './src/metadata.ts';
      import {browserMetadataFetcher} from './website/src/fetcher.ts';
      const wrap = transport => (url, options) => transport(${JSON.stringify(sourceOrigin)} + '/?source=' + encodeURIComponent(url), options);
      const safe = wrap(browserMetadataFetcher);
      const raw = wrap((url, options) => fetch(url, options));
      window.loadCatalog = (original = false) => fetchMetadata({fetcher: original ? raw : safe});`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  logLevel: 'silent',
})
const pageServer = createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html' }).end(`<script>${bundle.outputFiles[0].text}</script>`)
})
pageOrigin = await listen(pageServer)
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
})
try {
  const page = await browser.newPage()
  await page.goto(pageOrigin)
  const load = (original = false) =>
    page.evaluate(async (raw) => {
      const context = window as unknown as {
        loadCatalog: (original: boolean) => Promise<{ warnings: unknown[]; sources: unknown[] }>
      }
      const catalog = await context.loadCatalog(raw)
      return { warnings: catalog.warnings, sources: catalog.sources.length }
    }, original)
  const first = await load()
  const second = await load()
  const third = await load()
  assert.equal(first.sources, 8)
  assert.deepEqual(second.warnings, [])
  assert.deepEqual(third.warnings, [])
  assert.equal(preflights, 0, 'browser-managed revalidation does not need CORS preflight')
  assert.equal(gets, 24, 'every refresh reaches each source')
  assert.equal(revalidated, 16, 'HTTP 304 responses are revalidated and exposed with cached bodies')
  offline = true
  const stale = await load()
  assert.equal(stale.warnings.length, 8, 'failed refresh still reports retained in-memory metadata')
  offline = false
  await load(true)
  const broken = await load(true)
  assert.equal(broken.warnings.length, 8, 'the old manual headers reproduce first-success/refresh-failure')
  assert.equal(preflights, 8)
  console.log(
    'CORS regression passed: three fresh/revalidated loads, stale fallback and reproduced old preflight failure.',
  )
} finally {
  await browser.close()
  await Promise.all([close(pageServer), close(sourceServer)])
}
