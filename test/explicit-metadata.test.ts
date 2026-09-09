import assert from 'node:assert/strict'
import test from 'node:test'

import { fetchExplicitCatalog } from '../src/catalog.js'
import { resolve } from '../src/resolve.js'
import { createSource } from '../src/sources.js'

import type { Catalog, Fetcher, FetchResponse } from '../src/types.js'

const catalog: Catalog = {
  schemaVersion: 1,
  generatedAt: '2026-09-09T00:00:00.000Z',
  sources: [],
  warnings: [],
  nodes: [
    { version: '22.0.0', npm: '10.0.0' },
    { version: '24.0.0', npm: '10.0.0' },
  ],
  managers: { npm: [{ version: '10.0.0', node: '>=18' }], pnpm: [{ version: '9.0.0', node: '>=18' }], yarn: [] },
}
function response(data: unknown, status = 200): FetchResponse {
  return {
    status,
    ok: status === 200,
    text: () => Promise.resolve(JSON.stringify(data)),
    headers: { get: (key) => (key === 'etag' ? '"fixture"' : null) },
  }
}
const pin = createSource('packageManager', 'pnpm@10.0.0-rc.1')
const url = 'https://registry.npmjs.org/pnpm/10.0.0-rc.1'
const manifest = { name: 'pnpm', version: '10.0.0-rc.1', engines: { node: '>=23.0.0-0' } }

test('ordinary ranges and lockfiles never request prerelease metadata', async () => {
  const result = await fetchExplicitCatalog(
    catalog,
    [createSource('packageManager', 'pnpm@>=10'), createSource('nvmrc', '18'), createSource('pnpmLock', '9')],
    {
      fetcher: () => {
        throw new Error('unexpected network request')
      },
    },
  )
  assert.equal(result, catalog)
})

test('explicit npm and pnpm ranges fetch matching prereleases without changing stable metadata', async () => {
  for (const manager of ['npm', 'pnpm'] as const) {
    const requests: string[] = []
    const source = createSource('packageManager', `${manager}@>=10.0.0-rc.0 <10.0.0`)
    const result = await fetchExplicitCatalog(catalog, [source], {
      fetcher: (request) => {
        requests.push(request)
        return Promise.resolve(
          response({
            versions: Object.fromEntries(
              ['10.0.0-rc.1', '10.0.0-rc.2', '10.0.0', '11.0.0-rc.1'].map((version) => [
                version,
                {
                  name: manager,
                  version,
                  engines: { node: '>=23.0.0-0' },
                },
              ]),
            ),
          }),
        )
      },
    })
    assert.deepEqual(requests, [`https://registry.npmjs.org/${manager}`])
    assert.deepEqual(
      result.managers[manager]
        .filter((p) => p.version.includes('-'))
        .map((p) => p.version)
        .sort(),
      ['10.0.0-rc.1', '10.0.0-rc.2'],
    )
    assert.equal(
      catalog.managers[manager].some((p) => p.version.includes('-')),
      false,
    )
    const resolved = resolve({ runtime: { node: '22.0.0', npm: '10.0.0' }, sources: [source] }, result)
    assert.equal(resolved.packageManager?.version, '10.0.0-rc.2')
    assert.equal(resolved.node?.version, '24.0.0')
  }
})

test('explicit Node ranges query prerelease channels and retain only matching releases', async () => {
  const requests: string[] = []
  const source = createSource('nvmrc', '>=23.0.0-rc.0 <23.0.0')
  const result = await fetchExplicitCatalog(catalog, [source], {
    fetcher: (request) => {
      requests.push(request)
      return Promise.resolve(
        response([
          { version: 'v23.0.0-rc.1', npm: '10.0.0' },
          { version: 'v23.0.0-rc.2', npm: '10.0.0' },
          { version: 'v23.0.0', npm: '10.0.0' },
          { version: 'v25.0.0-rc.1', npm: '10.0.0' },
        ]),
      )
    },
  })
  assert.ok(requests.includes('https://nodejs.org/download/rc/index.json'))
  assert.deepEqual(
    result.nodes
      .filter((n) => n.version.includes('-'))
      .map((n) => n.version)
      .sort(),
    ['23.0.0-rc.1', '23.0.0-rc.2'],
  )
  assert.equal(
    catalog.nodes.some((n) => n.version.includes('-')),
    false,
  )
  const resolved = resolve({ runtime: { node: '22.0.0', npm: '10.0.0' }, sources: [source] }, result)
  assert.equal(resolved.node?.version, '23.0.0-rc.2')
})

test('native Yarn ranges use the official release feed and select the largest matching RC', async () => {
  const source = createSource('packageManager', 'yarn@>=6.0.0-rc.19 <6.0.0')
  const requests: string[] = []
  const result = await fetchExplicitCatalog(catalog, [source], {
    fetcher: (request) => {
      requests.push(request)
      return Promise.resolve(
        response({
          releaseLines: {
            zpm: {
              tags: ['6.0.0-rc.18', '6.0.0-rc.19'],
              stable: '6.0.0-rc.20',
              canary: '6.0.0-rc.20',
            },
          },
        }),
      )
    },
  })
  assert.deepEqual(requests, ['https://repo.yarnpkg.com/releases'])
  assert.deepEqual(result.managers.yarn.map((p) => p.version).sort(), ['6.0.0-rc.19', '6.0.0-rc.20'])
  const resolved = resolve({ runtime: { node: '22.0.0', npm: '10.0.0' }, sources: [source] }, result)
  assert.equal(resolved.packageManager?.version, '6.0.0-rc.20')
  assert.equal(resolved.packageManager.runtime, 'native')
})

test('Berry ranges merge official registry records and tag-only prereleases with cli-dist precedence', async () => {
  const source = createSource('packageManager', 'yarn@>=2.0.0-rc.0 <2.0.0')
  const requests: string[] = []
  const result = await fetchExplicitCatalog(catalog, [source], {
    fetcher: (request) => {
      requests.push(request)
      if (request === 'https://repo.yarnpkg.com/tags')
        return Promise.resolve(response({ tags: ['2.0.0-rc.1', '2.0.0-rc.2', '3.0.0-rc.1'] }))
      if (request.startsWith('https://raw.githubusercontent.com/'))
        return Promise.resolve(response({ name: '@yarnpkg/cli', version: '2.0.0-rc.1', engines: { node: '>=8' } }))
      return Promise.resolve(
        response({
          versions: {
            '2.0.0-rc.2': { version: '2.0.0-rc.2', engines: { node: request.includes('cli-dist') ? '>=10' : '>=8' } },
            '2.0.0': { version: '2.0.0' },
          },
        }),
      )
    },
  })
  assert.deepEqual(result.warnings, [])
  assert.equal(result.managers.yarn.find((p) => p.version === '2.0.0-rc.2')?.node, '>=10')
  assert.equal(result.managers.yarn.find((p) => p.version === '2.0.0-rc.1')?.node, '>=8')
  assert.deepEqual(result.managers.yarn.map((p) => p.version).sort(), ['2.0.0-rc.1', '2.0.0-rc.2'])
  assert.equal(requests.filter((request) => request.startsWith('https://raw.githubusercontent.com/')).length, 1)
})

test('range metadata caches never reuse candidates from a different range', async () => {
  const fetcher: Fetcher = (_request, options) =>
    Promise.resolve(
      options.headers?.['If-None-Match']
        ? response(null, 304)
        : response({
            versions: {
              '10.0.0-rc.1': { version: '10.0.0-rc.1' },
              '11.0.0-rc.1': { version: '11.0.0-rc.1' },
            },
          }),
    )
  for (const major of [10, 11, 10]) {
    const source = createSource('packageManager', `pnpm@>=${major}.0.0-rc.0 <${major}.0.0`)
    const result = await fetchExplicitCatalog(catalog, [source], { fetcher })
    assert.deepEqual(
      result.managers.pnpm.filter((p) => p.version.includes('-')).map((p) => p.version),
      [`${major}.0.0-rc.1`],
    )
    assert.deepEqual(result.warnings, [])
  }
})

test('an exact prerelease fetches only its official manifest and does not mutate the stable catalog', async () => {
  const requests: string[] = []
  const result = await fetchExplicitCatalog(catalog, [pin, { ...pin, id: 'duplicate' }], {
    fetcher: (request) => {
      requests.push(request)
      return Promise.resolve(response(manifest))
    },
  })
  assert.deepEqual(requests, [url])
  assert.deepEqual(
    result.managers.pnpm.map((row) => row.version),
    ['9.0.0', '10.0.0-rc.1'],
  )
  assert.deepEqual(
    catalog.managers.pnpm.map((row) => row.version),
    ['9.0.0'],
  )
  assert.equal(result.sources[0].url, url)
  assert.match(result.sources[0].sha256, /^[a-f0-9]{64}$/)
  const selected = resolve({ sources: [pin], runtime: { node: '22.0.0', npm: '10.0.0' } }, result)
  assert.equal(selected.packageManager?.version, '10.0.0-rc.1')
  assert.equal(selected.node?.version, '24.0.0')
})

test('explicit metadata validates manifest identity and declared Node requirements', async () => {
  for (const invalid of [
    { ...manifest, version: '10.0.0' },
    { ...manifest, name: 'not-pnpm' },
    { ...manifest, engines: { node: 'invalid' } },
  ]) {
    const result = await fetchExplicitCatalog(catalog, [pin], { fetcher: () => Promise.resolve(response(invalid)) })
    assert.deepEqual(result.managers.pnpm, catalog.managers.pnpm)
    assert.equal(result.warnings[0].code, 'explicit-version-unavailable')
    assert.equal(result.warnings[0].sourceId, pin.id)
  }
})

test('explicit metadata shares pending requests, revalidates cached responses and reports stale fallback', async () => {
  let phase = 'first'
  let calls = 0
  const fetcher: Fetcher = (_url, options) => {
    calls++
    if (phase !== 'first') assert.equal(options.headers?.['If-None-Match'], '"fixture"')
    if (phase === '304') return Promise.resolve(response(null, 304))
    if (phase === 'offline') return Promise.reject(new Error('offline'))
    return Promise.resolve(response(manifest))
  }
  const [a, b] = await Promise.all([
    fetchExplicitCatalog(catalog, [pin], { fetcher }),
    fetchExplicitCatalog(catalog, [pin], { fetcher }),
  ])
  assert.equal(calls, 1)
  assert.deepEqual(a.managers.pnpm, b.managers.pnpm)
  phase = '304'
  const reused = await fetchExplicitCatalog(catalog, [pin], { fetcher })
  assert.equal(reused.sources[0].sha256, a.sources[0].sha256)
  phase = 'offline'
  const stale = await fetchExplicitCatalog(catalog, [pin], { fetcher })
  assert.equal(stale.warnings[0].code, 'stale-metadata')
  assert.equal(stale.managers.pnpm[1].version, manifest.version)
})

test('a pinned Node prerelease reads its official channel and admits only that exact version', async () => {
  const result = await fetchExplicitCatalog(catalog, [createSource('nvmrc', '23.0.0-rc.1')], {
    fetcher: (request) => {
      assert.equal(request, 'https://nodejs.org/download/rc/index.json')
      return Promise.resolve(response([{ version: 'v23.0.0-rc.1' }, { version: 'v25.0.0-rc.2' }]))
    },
  })
  assert.deepEqual(
    result.nodes.map((node) => node.version),
    ['22.0.0', '24.0.0', '23.0.0-rc.1'],
  )
  assert.equal(result.nodes[2].npm, null, 'absent release npm metadata must not be invented')
  assert.equal(result.sources[0].id, 'explicit-node@23.0.0-rc.1')
})

test('tag-only Yarn prereleases use the official version list and exact tag manifest', async () => {
  const version = '2.0.0-rc.1'
  const tagUrl = `https://raw.githubusercontent.com/yarnpkg/berry/${encodeURIComponent(`@yarnpkg/cli/${version}`)}/packages/yarnpkg-cli/package.json`
  const result = await fetchExplicitCatalog(catalog, [createSource('packageManager', `yarn@${version}`)], {
    fetcher: (request) => {
      if (request.startsWith('https://registry.npmjs.org/')) return Promise.resolve(response(null, 404))
      if (request === 'https://repo.yarnpkg.com/tags') return Promise.resolve(response({ tags: [version, '4.0.0'] }))
      assert.equal(request, tagUrl)
      return Promise.resolve(response({ name: '@yarnpkg/cli', version, engines: { node: '>=8' } }))
    },
  })
  assert.deepEqual(result.warnings, [])
  assert.equal(result.managers.yarn[0].node, '>=8')
  assert.equal(result.managers.yarn[0].sourceUrl, tagUrl)
  assert.equal(result.managers.yarn[0].tarball, undefined)
})

test('an explicitly pinned Yarn 6 RC uses its native feed without Berry manifests or binaries', async () => {
  const version = '6.0.0-rc.20'
  const nativePin = createSource('packageManager', `yarn@${version}`)
  const nativeLock = createSource('yarnLock', '9')
  nativeLock.features = { yarnFamily: 'zpm' }
  const requests: string[] = []
  const result = await fetchExplicitCatalog(catalog, [nativePin, nativeLock], {
    fetcher: (request) => {
      requests.push(request)
      return Promise.resolve(
        response({ releaseLines: { zpm: { stable: version, canary: version, tags: ['6.0.0-rc.19'] } } }),
      )
    },
  })
  assert.deepEqual(requests, ['https://repo.yarnpkg.com/releases'])
  assert.deepEqual(result.managers.yarn, [{ version, node: '*', runtime: 'native', sourceUrl: requests[0] }])
  assert.deepEqual(catalog.managers.yarn, [])
  const selected = resolve({ sources: [nativePin, nativeLock], runtime: { node: '22.0.0', npm: '10.0.0' } }, result)
  assert.equal(selected.packageManager?.version, version)
  assert.equal(selected.packageManager.runtime, 'native')
  assert.equal(selected.packageManager.nodeRange, '*')
  assert.equal(selected.node?.version, '22.0.0')
  assert.equal(selected.trace.find((source) => source.id === nativeLock.id)?.status, 'accepted')
  assert.ok(selected.warnings.some((warning) => warning.code === 'unknown-lock-compatibility'))
  assert.ok(!selected.warnings.some((warning) => warning.code === 'constraint-conflict'))
})

test('a Yarn native exact version absent from its official channel fails without inventing metadata', async () => {
  const result = await fetchExplicitCatalog(catalog, [createSource('packageManager', 'yarn@6.0.0-rc.99')], {
    fetcher: (request) => {
      assert.equal(request, 'https://repo.yarnpkg.com/releases')
      return Promise.resolve(response({ releaseLines: { zpm: { tags: ['6.0.0-rc.20'] } } }))
    },
  })
  assert.deepEqual(result.managers.yarn, [])
  assert.equal(result.warnings[0].code, 'explicit-version-unavailable')
  assert.match(result.warnings[0].message, /absent.*native/)
})
