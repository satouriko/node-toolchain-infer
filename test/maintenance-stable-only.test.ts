import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import test from 'node:test'

import { discoverFixtures } from '../maintenance/discover-fixtures.js'
import { generateFixture, generateFixtures } from '../maintenance/generate-fixtures.js'
import { provision } from '../maintenance/provision.js'
import { prepareYarnArtifacts } from '../maintenance/yarn-artifacts.js'

import type { Fixture } from '../maintenance/model.js'
import type { Catalog } from '../src/types.js'

const release = { version: '3.0.0-beta.1', node: null }
const catalog: Catalog = {
  schemaVersion: 1,
  generatedAt: '2026-09-09T00:00:00Z',
  sources: [],
  warnings: [],
  nodes: [],
  managers: { npm: [], pnpm: [], yarn: [release] },
}
const fixture: Fixture = {
  id: 'historical-yarn',
  manager: 'yarn',
  version: release.version,
  directory: 'historical',
  lock: 'yarn.lock',
  match: { format: 6 },
  dependencies: {},
}

test('prerelease generators and discovery probes cannot provision tools or change historical fixtures', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'stable-fixture-policy-'))
  const { argv } = process
  const fetchMock = context.mock.method(globalThis, 'fetch', () => {
    throw new Error('Prerelease rejection must happen before any network request')
  })
  try {
    await mkdir(join(root, 'fixtures/historical'), { recursive: true })
    await writeFile(join(root, 'fixtures/recipes.json'), JSON.stringify([fixture]))
    await writeFile(join(root, 'fixtures/historical/yarn.lock'), 'historical bytes')
    await writeFile(join(root, 'catalog.json'), JSON.stringify(catalog))
    process.argv = [...argv, '--catalog', join(root, 'catalog.json')]
    await generateFixtures(root)
    assert.equal(await readFile(join(root, 'fixtures/historical/yarn.lock'), 'utf8'), 'historical bytes')
    await assert.rejects(generateFixture(fixture, catalog, join(root, 'new')), /Prerelease generators/)
    await assert.rejects(provision('yarn', release, catalog, join(root, 'tools')), /Prerelease versions/)
    await assert.rejects(
      provision(
        'yarn',
        {
          version: '3.0.0',
          node: '>=18.0.0-0',
          tarball: 'https://registry.npmjs.org/@yarnpkg/cli-dist/-/cli-dist-3.0.0.tgz',
          integrity: 'sha512-synthetic-test-artifact',
        },
        { ...catalog, nodes: [{ version: '18.0.0-beta.1' }] },
        join(root, 'node'),
        '18.0.0-beta.1',
      ),
      /Requested Node/,
    )
    await discoverFixtures([{ manager: 'yarn', version: release.version, lock: 'yarn.lock' }])
    assert.equal(fetchMock.mock.callCount(), 0)
  } finally {
    process.argv = argv
    await rm(root, { recursive: true, force: true })
  }
})

test('Yarn artifact preparation ignores prerelease fetches and saved diagnostics while preserving raw catalogs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stable-yarn-policy-'))
  try {
    const seed = join(root, 'seed')
    await mkdir(seed)
    const raw = JSON.stringify(catalog)
    await writeFile(join(seed, 'catalog.json'), raw)
    await writeFile(
      join(seed, 'report.json'),
      JSON.stringify({ failures: [{ version: release.version, error: 'old mismatch' }] }),
    )
    const result = await prepareYarnArtifacts({
      catalog,
      stateDirectory: join(root, 'state'),
      seedDirectories: [seed],
      enrich: () => {
        throw new Error('Prerelease artifact must not be fetched')
      },
    })
    assert.deepEqual(result.catalog.managers.yarn, [])
    assert.deepEqual(result.incomplete, [])
    assert.equal(await readFile(join(seed, 'catalog.json'), 'utf8'), raw)
    assert.equal(catalog.managers.yarn[0].version, release.version)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
