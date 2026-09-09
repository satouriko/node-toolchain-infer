import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { syncData } from '../scripts/sync-data.js'
import { fetchCatalog, loadCatalog, loadRules } from '../src/catalog.js'

import type { Fetcher, FetchResponse } from '../src/types.js'

const urls = {
  node: 'https://nodejs.org/dist/index.json',
  npm: 'https://registry.npmjs.org/npm',
  pnpm: 'https://registry.npmjs.org/pnpm',
  yarnClassic: 'https://registry.npmjs.org/yarn',
  yarnBerry: 'https://registry.npmjs.org/@yarnpkg%2Fcli-dist',
  yarnCli: 'https://registry.npmjs.org/@yarnpkg%2Fcli',
  yarnTags: 'https://repo.yarnpkg.com/tags',
  yarnZpm: 'https://repo.yarnpkg.com/releases',
}

class FixtureResponse implements FetchResponse {
  status: number
  ok: boolean
  headers: { get: (name: string) => string | null }
  constructor(
    readonly body: string,
    { status = 200, etag }: { status?: number; etag?: string } = {},
  ) {
    this.status = status
    this.ok = status >= 200 && status < 300
    this.headers = {
      get(name: string) {
        return name.toLowerCase() === 'etag' ? (etag ?? null) : null
      },
    }
  }

  text() {
    return Promise.resolve(this.body)
  }
}

function registryFixture(
  name: string,
  versions: Array<{ key: string; version: string; engines?: Record<string, string>; releasedAt: string }>,
) {
  const manifests: Record<string, unknown> = {}
  const time: Record<string, string> = { created: '2024-01-01T00:00:00.000Z' }

  for (const entry of versions) {
    manifests[entry.key] = {
      name,
      version: entry.version,
      dist: {
        integrity: 'sha512-fixture',
        tarball: `https://registry.npmjs.org/${name}/-/${name}-${entry.version}.tgz`,
      },
      ...(entry.engines === undefined ? {} : { engines: entry.engines }),
    }
    time[entry.key] = entry.releasedAt
  }

  return JSON.stringify({
    _id: name,
    name,
    'dist-tags': { latest: versions.at(-1)?.version },
    versions: manifests,
    time,
  })
}

function validBodies() {
  return new Map([
    [urls.yarnTags, JSON.stringify({ tags: ['4.6.0', '3.0.0-rc.1', '2.4.3'] })],
    [
      urls.yarnZpm,
      JSON.stringify({
        releaseLines: { zpm: { stable: '6.0.0-rc.20', canary: '6.0.0-rc.20', tags: ['6.0.0-rc.19'] } },
      }),
    ],
    [
      urls.node,
      JSON.stringify([
        {
          version: 'v22.14.0',
          date: '2025-02-11',
          files: ['headers', 'linux-x64'],
          npm: '10.9.2',
          v8: '12.4.254.21',
          uv: '1.49.2',
          zlib: '1.3.0.1-motley',
          openssl: '3.0.15+quic',
          modules: '127',
          lts: 'Jod',
          security: false,
        },
        {
          version: 'v23.9.0',
          date: '2025-02-13',
          files: ['headers', 'linux-x64'],
          npm: '10.9.2',
          v8: '12.9.202.28',
          uv: '1.50.0',
          zlib: '1.3.0.1-motley',
          openssl: '3.0.16+quic',
          modules: '131',
          lts: false,
          security: false,
        },
      ]),
    ],
    [
      urls.npm,
      registryFixture('npm', [
        {
          key: '10.9.2',
          version: '10.9.2',
          engines: { node: '^18.17.0 || >=20.5.0' },
          releasedAt: '2024-11-27T14:42:30.000Z',
        },
        {
          key: '11.0.0-beta.1',
          version: '11.0.0-beta.1',
          engines: { node: '^20.17.0 || >=22.9.0' },
          releasedAt: '2024-12-01T00:00:00.000Z',
        },
      ]),
    ],
    [
      urls.pnpm,
      registryFixture('pnpm', [
        { key: '9.15.5', version: '9.15.5', engines: { node: '>=18.12' }, releasedAt: '2025-01-21T12:00:00.000Z' },
        {
          key: '10.0.0-rc.1',
          version: '10.0.0-rc.1',
          engines: { node: '>=18.12' },
          releasedAt: '2025-01-22T12:00:00.000Z',
        },
      ]),
    ],
    [
      urls.yarnClassic,
      registryFixture('yarn', [
        { key: '0.27.5', version: '0.27.5', engines: { node: '>=4.0.0' }, releasedAt: '2017-07-01T00:00:00.000Z' },
        { key: '1.22.22', version: '1.22.22', engines: { node: '>=4.0.0' }, releasedAt: '2024-03-09T00:00:00.000Z' },
        { key: '2.4.3', version: '2.4.3', engines: { node: '>=10' }, releasedAt: '2021-02-01T00:00:00.000Z' },
        { key: '4.6.0', version: '4.6.0', engines: { node: '>=20' }, releasedAt: '2025-01-10T00:00:00.000Z' },
      ]),
    ],
    [
      urls.yarnCli,
      registryFixture('@yarnpkg/cli', [
        { key: '4.6.0', version: '4.6.0', engines: { node: '>=99' }, releasedAt: '2025-01-10T00:00:00.000Z' },
        { key: '3.0.0-rc.1', version: '3.0.0-rc.1', engines: { node: '>=12' }, releasedAt: '2021-01-10T00:00:00.000Z' },
      ]),
    ],
    [
      urls.yarnBerry,
      registryFixture('@yarnpkg/cli-dist', [
        { key: '1.0.0', version: '1.0.0', engines: { node: '>=12' }, releasedAt: '2022-01-01T00:00:00.000Z' },
        { key: '4.6.0', version: '4.6.0', engines: { node: '>=18.12.0' }, releasedAt: '2025-01-10T00:00:00.000Z' },
      ]),
    ],
  ])
}

function fixtureFetcher(bodies = validBodies(), overrides = new Map<string, FixtureResponse>()): Fetcher {
  return (url, _options) => {
    if (overrides.has(url)) return Promise.resolve(overrides.get(url)!)
    const body = bodies.get(url)
    assert.notEqual(body, undefined, `unexpected URL ${url}`)
    return Promise.resolve(new FixtureResponse(body!, { etag: `"${new URL(url).pathname}"` }))
  }
}

test('fetchCatalog parses official Node and registry shapes with stable releases only', async () => {
  const signal = AbortSignal.timeout(5_000)
  const seenSignals: Array<AbortSignal | undefined> = []
  const fetcher: Fetcher = async (url, options) => {
    seenSignals.push(options.signal)
    return fixtureFetcher()(url, options)
  }

  const catalog = await fetchCatalog({ fetcher, signal })

  assert.equal(catalog.schemaVersion, 1)
  assert.match(catalog.generatedAt, /^\d{4}-\d{2}-\d{2}T/)
  assert.deepEqual(catalog.nodes, [
    { version: '22.14.0', npm: '10.9.2', lts: 'Jod', date: '2025-02-11' },
    { version: '23.9.0', npm: '10.9.2', lts: false, date: '2025-02-13' },
  ])
  assert.deepEqual(
    catalog.managers.npm.map(({ version, node }) => ({ version, node })),
    [{ version: '10.9.2', node: '^18.17.0 || >=20.5.0' }],
  )
  assert.deepEqual(
    catalog.managers.pnpm.map(({ version }) => version),
    ['9.15.5'],
  )
  assert.deepEqual(
    catalog.managers.yarn.map(({ version }) => version),
    ['4.6.0', '2.4.3', '1.22.22', '0.27.5'],
  )
  assert.equal(
    catalog.managers.yarn[0].node,
    '>=18.12.0',
    'cli-dist is canonical when both registries publish a version',
  )
  assert.equal(catalog.managers.yarn[0].sourceUrl, urls.yarnBerry)
  assert.equal(catalog.managers.yarn[1].sourceUrl, urls.yarnClassic)
  assert.equal(catalog.sources.length, 8)
  assert.deepEqual(
    catalog.sources.map(({ id }) => id),
    ['node', 'npm', 'pnpm', 'yarn-classic', 'yarn-berry', 'yarn-cli', 'yarn-tags', 'yarn-zpm'],
  )
  for (const source of catalog.sources) {
    assert.match(source.sha256, /^[a-f0-9]{64}$/)
    assert.match(source.fetchedAt, /^\d{4}-\d{2}-\d{2}T/)
    assert.equal(typeof source.etag, 'string')
  }
  assert.equal(seenSignals.length, 8)
  assert.ok(seenSignals.every((item) => item instanceof AbortSignal))
})

test('fetchCatalog rejects a registry key that differs from manifest.version', async () => {
  const bodies = validBodies()
  bodies.set(
    urls.pnpm,
    registryFixture('pnpm', [
      { key: '9.15.5', version: '9.15.4', engines: { node: '>=18.12' }, releasedAt: '2025-01-21T12:00:00.000Z' },
    ]),
  )

  await assert.rejects(fetchCatalog({ fetcher: fixtureFetcher(bodies) }), /pnpm.*9\.15\.5.*9\.15\.4/i)
})

test('fetchCatalog rejects malformed declared engines.node instead of inventing compatibility', async () => {
  const bodies = validBodies()
  bodies.set(
    urls.npm,
    registryFixture('npm', [
      {
        key: '10.9.2',
        version: '10.9.2',
        engines: { node: 'definitely-node-ish' },
        releasedAt: '2024-11-27T14:42:30.000Z',
      },
    ]),
  )

  await assert.rejects(fetchCatalog({ fetcher: fixtureFetcher(bodies) }), /npm@10\.9\.2.*engines\.node/i)
})

test('loadCatalog and loadRules reject invalid shipped data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'toolchain-catalog-'))
  try {
    const catalogPath = join(directory, 'catalog.json')
    const rulesPath = join(directory, 'compatibility.json')
    const catalog = await fetchCatalog({ fetcher: fixtureFetcher() })
    await writeFile(catalogPath, JSON.stringify(catalog))
    await writeFile(
      rulesPath,
      JSON.stringify({
        schemaVersion: 1,
        generatedAt: '2026-09-09T00:00:00.000Z',
        rules: [
          {
            id: 'npm-lock-v3',
            manager: 'npm',
            match: { format: 'package-lock-v3' },
            range: '10.9.2',
          },
        ],
        observations: [],
      }),
    )

    assert.deepEqual(await loadCatalog(catalogPath), catalog)
    assert.equal((await loadRules({ compatibilityPath: rulesPath }))[0].id, 'npm-lock-v3')

    await writeFile(rulesPath, JSON.stringify({ schemaVersion: 1, generatedAt: 'bad', rules: [], observations: [] }))
    await assert.rejects(loadRules({ compatibilityPath: rulesPath }), /generatedAt/i)
    await assert.rejects(loadCatalog(join(directory, 'missing.json')), /missing\.json/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('syncData preserves the destination and leaves no temp file after HTTP failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'toolchain-sync-http-'))
  try {
    const output = join(directory, 'catalog.json')
    await writeFile(output, 'original catalog\n')
    const fetcher = fixtureFetcher(
      validBodies(),
      new Map([[urls.node, new FixtureResponse('unavailable', { status: 503 })]]),
    )

    await assert.rejects(syncData({ output, fetcher }), /503/)

    assert.equal(await readFile(output, 'utf8'), 'original catalog\n')
    assert.deepEqual(await readdir(directory), ['catalog.json'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('syncData preserves the destination and leaves no temp file after parse failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'toolchain-sync-parse-'))
  try {
    const output = join(directory, 'catalog.json')
    await writeFile(output, 'original catalog\n')
    const fetcher = fixtureFetcher(validBodies(), new Map([[urls.pnpm, new FixtureResponse('{not json')]]))

    await assert.rejects(syncData({ output, fetcher }), /pnpm.*JSON/i)

    assert.equal(await readFile(output, 'utf8'), 'original catalog\n')
    assert.deepEqual(await readdir(directory), ['catalog.json'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('conditional requests reuse validated bytes on 304 and recover after transient failures', async () => {
  let phase = 'first'
  const received: Array<Record<string, string>> = []
  const base = fixtureFetcher()
  const fetcher: Fetcher = async (url, options) => {
    received.push(options.headers ?? {})
    if (phase === '304') return new FixtureResponse('', { status: 304 })
    if (phase === 'fail') throw new Error('offline')
    return base(url, options)
  }
  const first = await fetchCatalog({ fetcher })
  phase = '304'
  const cached = await fetchCatalog({ fetcher })
  assert.deepEqual(cached.nodes, first.nodes)
  assert.deepEqual(
    cached.sources.map((s) => s.sha256),
    first.sources.map((s) => s.sha256),
  )
  assert.ok(received.slice(8).every((h) => h['If-None-Match']))
  phase = 'fail'
  const stale = await fetchCatalog({ fetcher })
  assert.equal(stale.warnings.filter((w) => w.code === 'stale-metadata').length, 8)
  phase = 'first'
  assert.equal((await fetchCatalog({ fetcher })).warnings.length, 0)
})
test('concurrent requests deduplicate and a rejected request can be retried', async () => {
  let fail = true
  let calls = 0
  const base = fixtureFetcher()
  const fetcher: Fetcher = async (url, options) => {
    calls++
    await new Promise((resolve) => {
      setTimeout(resolve, 5)
    })
    if (fail) throw new Error('offline')
    return base(url, options)
  }
  await assert.rejects(fetchCatalog({ fetcher }), /offline/)
  fail = false
  calls = 0
  const [a, b] = await Promise.all([fetchCatalog({ fetcher }), fetchCatalog({ fetcher })])
  assert.equal(calls, 8)
  assert.deepEqual(a.nodes, b.nodes)
})
test('missing engines.node stays unknown rather than being written as a wildcard', async () => {
  const bodies = validBodies()
  bodies.set(urls.npm, registryFixture('npm', [{ key: '1.0.0', version: '1.0.0', releasedAt: '2020-01-01' }]))
  const data = await fetchCatalog({ fetcher: fixtureFetcher(bodies) })
  assert.equal(data.managers.npm[0].node, null)
})

test('Yarn native release channels and tags are unioned, deduplicated and filtered by semver stability', async () => {
  const bodies = validBodies()
  bodies.set(
    urls.yarnZpm,
    JSON.stringify({
      releaseLines: {
        berry: { stable: '4.6.0', tags: ['4.6.0'] },
        zpm: { stable: '6.1.0', canary: '6.2.0-rc.1', tags: ['6.0.0', '6.0.0', '6.0.0-rc.20'] },
      },
    }),
  )
  const data = await fetchCatalog({ fetcher: fixtureFetcher(bodies) })
  const native = data.managers.yarn.filter((release) => release.runtime === 'native')
  assert.deepEqual(
    native,
    ['6.1.0', '6.0.0'].map((version) => ({ version, runtime: 'native', node: '*', sourceUrl: urls.yarnZpm })),
  )
  assert.equal(data.managers.yarn.filter((release) => release.version === '4.6.0').length, 1)
  assert.ok(data.sources.some((source) => source.id === 'yarn-zpm' && /^[a-f0-9]{64}$/.test(source.sha256)))
})

test('invalid Yarn native feed schema or nonnative versions cannot silently become native releases', async () => {
  for (const zpm of [undefined, { tags: '6.0.0' }, { tags: ['invalid'] }, { tags: ['4.6.0'] }]) {
    const bodies = validBodies()
    bodies.set(urls.yarnZpm, JSON.stringify({ releaseLines: { zpm } }))
    await assert.rejects(fetchCatalog({ fetcher: fixtureFetcher(bodies) }), /Yarn.*(?:zpm|native)/i)
  }
})

test('tag-only Yarn releases retain official manifest engines and response hashes without runtime bundle downloads', async () => {
  const bodies = validBodies()
  const version = '2.0.1'
  const url = `https://raw.githubusercontent.com/yarnpkg/berry/${encodeURIComponent(`@yarnpkg/cli/${version}`)}/packages/yarnpkg-cli/package.json`
  bodies.set(urls.yarnTags, JSON.stringify({ tags: [version, '4.6.0'] }))
  bodies.set(url, JSON.stringify({ version, engines: { node: '>=8.0.0' } }))
  let cached = false
  const base = fixtureFetcher(bodies)
  const fetcher: Fetcher = (requestUrl, options) => {
    if (cached) {
      assert.ok(options.headers?.['If-None-Match'])
      return Promise.resolve(new FixtureResponse('', { status: 304 }))
    }
    return base(requestUrl, options)
  }
  const catalog = await fetchCatalog({ fetcher })
  const release = catalog.managers.yarn.find((item) => item.version === version)!
  assert.equal(release.node, '>=8.0.0')
  assert.equal(release.tarball, undefined)
  assert.equal(release.sourceUrl, url)
  assert.ok(catalog.sources.some((source) => source.url === url && /^[a-f0-9]{64}$/.test(source.sha256)))
  cached = true
  assert.deepEqual((await fetchCatalog({ fetcher })).managers.yarn, catalog.managers.yarn)
})

test('unavailable or missing tag manifest engines stay explicit unknown with actionable warnings', async () => {
  const version = '2.0.1'
  const url = `https://raw.githubusercontent.com/yarnpkg/berry/${encodeURIComponent(`@yarnpkg/cli/${version}`)}/packages/yarnpkg-cli/package.json`
  for (const missing of [true, false]) {
    const bodies = validBodies()
    bodies.set(urls.yarnTags, JSON.stringify({ tags: [version] }))
    bodies.set(url, JSON.stringify({ version }))
    const overrides = missing
      ? new Map([[url, new FixtureResponse('missing', { status: 404 })]])
      : new Map<string, FixtureResponse>()
    const catalog = await fetchCatalog({ fetcher: fixtureFetcher(bodies, overrides) })
    assert.equal(catalog.managers.yarn.find((item) => item.version === version)?.node, null)
    assert.ok(
      catalog.warnings.some(
        (warning) => warning.path === url && warning.message.includes(missing ? '404' : 'engines.node'),
      ),
    )
  }
})
