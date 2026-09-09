import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { collect } from '../src/collect.js'
import { playgroundSources } from '../src/playground.js'
import { resolveLive } from '../website/src/resolve-live.js'

import type { UiCatalog } from '../website/src/ui-types.js'

test('calculator and collector preserve explicit legacy workspace features at every directory', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'infer-playground-')))
  try {
    const cwd = join(root, 'child')
    await mkdir(join(root, '.git'))
    await mkdir(cwd)
    await writeFile(join(root, 'shrinkwrap.yaml'), 'shrinkwrapVersion: 4\nimporters: {}\n')
    await writeFile(join(cwd, 'shrinkwrap.yaml'), 'shrinkwrapVersion: 3\n')
    const actual = await collect({ cwd })
    const simulated = playgroundSources({
      runtime: {},
      fields: { pnpmShrinkwrap: '3' },
      searchDepth: 1,
      additional: [{ key: 'pnpmShrinkwrap', depth: 1, value: '4', sharedWorkspace: true }],
    })
    const values = (rows: typeof actual.sources) =>
      rows.map(({ kind, depth, value, features }) => ({ kind, depth, value, features }))
    assert.deepEqual(values(simulated), values(actual.sources))
    const undeclared = playgroundSources({
      runtime: {},
      fields: { pnpmShrinkwrap: '4' },
      searchDepth: 0,
      additional: [],
    })
    assert.deepEqual(
      undeclared[0].features,
      { sharedWorkspace: false },
      'format number alone does not invent importers',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('calculator preserves each Yarn lock family and defaults old states to Berry', () => {
  const input = {
    runtime: {},
    fields: { yarnLock: '9', yarnLockFamily: 'zpm' },
    searchDepth: 2,
    additional: [
      { key: 'yarnLock', depth: 1, value: '9' },
      { key: 'yarnLock', depth: 2, value: '9', yarnFamily: 'zpm' as const },
    ],
  }
  const rows = playgroundSources(input)
  assert.deepEqual(
    rows.map((source) => source.features),
    [{ yarnFamily: 'zpm' }, undefined, { yarnFamily: 'zpm' }],
  )
  assert.equal(playgroundSources({ ...input, fields: { yarnLock: '9' }, additional: [] })[0].features, undefined)
})

test('a native Yarn range retains its metadata receipt and derivations without changing stable facts', async (t) => {
  // This test executes the browser adapter; Node 18 does not expose WebCrypto globally by default.
  if (!('crypto' in globalThis)) {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto })
    t.after(() => {
      Reflect.deleteProperty(globalThis, 'crypto')
    })
  }
  const catalog: UiCatalog = {
    schemaVersion: 1,
    generatedAt: '2026-09-09T00:00:00Z',
    sources: [],
    warnings: [],
    nodes: [{ version: '18.20.8', npm: '10.8.2' }],
    managers: { npm: [{ version: '10.8.2', node: '>=18' }], yarn: [], pnpm: [] },
  }
  const version = '6.0.0-rc.20'
  const result = await resolveLive(
    {
      runtime: { node: '18.20.8', npm: '10.8.2' },
      fields: { packageManager: 'yarn@>=6.0.0-rc.19 <6.0.0', yarnLock: '9', yarnLockFamily: 'zpm' },
      additional: [],
      searchDepth: 0,
    },
    catalog,
    {
      fetcher: (url) => {
        assert.equal(url, 'https://repo.yarnpkg.com/releases')
        return Promise.resolve({
          status: 200,
          ok: true,
          headers: { get: () => null },
          text: () => Promise.resolve(JSON.stringify({ releaseLines: { zpm: { stable: version, tags: [] } } })),
        })
      },
    },
  )
  assert.equal(result.packageManager?.runtime, 'native')
  assert.equal(result.packageManager.version, version)
  assert.deepEqual(result.trace.find((source) => source.key === 'packageManager')?.derivations, [
    { node: '*', versions: [version], count: 1 },
  ])
  assert.equal(result.versionData.sources[0].url, 'https://repo.yarnpkg.com/releases')
  assert.match(result.versionData.sources[0].sha256, /^[a-f0-9]{64}$/)
  assert.deepEqual(catalog.sources, [])
  assert.deepEqual(catalog.managers.yarn, [])
})
