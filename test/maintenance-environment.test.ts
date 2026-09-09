import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import test from 'node:test'

import { digest, type Fixture, FROZEN_LOCKFILES } from '../maintenance/model.js'
import { reusableObservation } from '../maintenance/run-matrix.js'
import { frozenArgs } from '../maintenance/runner.js'
import { readSeedRows, seedData } from '../scripts/seed-data.js'

import { makeObservation } from './maintenance-fixture.js'

import type { Tool } from '../maintenance/provision.js'
import type { Catalog } from '../src/types.js'

const environment = {
  npm_config_auto_install_peers: 'true',
  npm_config_exclude_links_from_lockfile: 'false',
}

async function setup(settings = true) {
  const root = await mkdtemp(join(tmpdir(), 'fixture-environment-'))
  const fixture: Fixture = {
    id: 'pnpm-v6',
    manager: 'pnpm',
    version: '7.33.0',
    directory: 'basic',
    lock: 'pnpm-lock.yaml',
    match: { format: '6.0' },
    dependencies: {},
  }
  const source = join(root, 'fixtures', fixture.directory)
  await mkdir(source, { recursive: true })
  const lock = settings
    ? 'lockfileVersion: 6.0\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n'
    : 'lockfileVersion: 5.4\n'
  await writeFile(join(source, 'package.json'), '{}')
  await writeFile(join(source, fixture.lock), lock)
  await writeFile(join(root, 'fixtures/recipes.json'), JSON.stringify([fixture]))
  const inputs = { 'package.json': digest('{}'), 'pnpm-lock.yaml': digest(lock) }
  const watched = { ...Object.fromEntries(FROZEN_LOCKFILES.map((file) => [file, '<missing>'])), ...inputs }
  const tool: Tool = {
    version: fixture.version,
    node: process.execPath,
    nodeVersion: process.versions.node,
    nodeArch: process.arch,
    nodeIntegrity: 'test-node',
    cli: '/unused',
    integrity: 'official-tool',
    url: 'https://registry.npmjs.org/pnpm/-/pnpm-7.33.0.tgz',
  }
  const catalog: Catalog = {
    schemaVersion: 1,
    generatedAt: '2026-09-09',
    sources: [],
    warnings: [],
    nodes: [],
    managers: { npm: [], yarn: [], pnpm: [{ version: fixture.version, node: '*', integrity: tool.integrity }] },
  }
  const observation = makeObservation({
    manager: fixture.manager,
    version: fixture.version,
    actualVersion: fixture.version,
    fixtureId: fixture.id,
    fixtureHash: digest(JSON.stringify(inputs)),
    inputHashes: inputs,
    beforeHashes: watched,
    afterHashes: watched,
    command: frozenArgs(fixture.manager, fixture.version),
    node: tool.nodeVersion,
    nodeIntegrity: tool.nodeIntegrity,
    nodeArch: tool.nodeArch,
    platform: process.platform,
    arch: process.arch,
    toolIntegrity: tool.integrity,
    status: 'incompatible',
    exitCode: 1,
  })
  return { root, fixture, tool, catalog, observation }
}

test('local matrix reuse requires the current lock settings, including explicit false values', async () => {
  const options = await setup()
  try {
    const { fixture, tool, root, observation } = options
    for (const recorded of [undefined, {}, { ...environment, npm_config_auto_install_peers: 'false' }])
      assert.equal(
        await reusableObservation(fixture, tool, join(root, 'fixtures'), [{ ...observation, environment: recorded }]),
        undefined,
      )
    const current = {
      ...observation,
      environment: { npm_config_exclude_links_from_lockfile: 'false', npm_config_auto_install_peers: 'true' },
    }
    assert.equal(await reusableObservation(fixture, tool, join(root, 'fixtures'), [current]), current)
  } finally {
    await rm(options.root, { recursive: true, force: true })
  }
})

test('local observations without a settings override remain reusable under the existing protocol', async () => {
  const options = await setup(false)
  try {
    assert.equal(
      await reusableObservation(options.fixture, options.tool, join(options.root, 'fixtures'), [options.observation]),
      options.observation,
    )
  } finally {
    await rm(options.root, { recursive: true, force: true })
  }
})

test('seed resume appends a current-environment attempt and preserves obsolete environment evidence', async () => {
  const setupOptions = await setup()
  let attempts = 0
  let stale = true
  try {
    const options = {
      root: setupOptions.root,
      catalog: setupOptions.catalog,
      quiet: true,
      provisionTool: () => Promise.resolve(setupOptions.tool),
      installFixture: () =>
        Promise.resolve({
          ...setupOptions.observation,
          id: `environment-attempt-${++attempts}`,
          environment: stale ? undefined : environment,
        }),
    }
    assert.equal((await seedData(options)).unattempted, 1)
    const output = join(options.root, 'maintenance/evidence/initial-matrix')
    const original = (await readSeedRows(output))[0]
    const path = join(output, 'rows', `${original.id}.json`)
    const originalBytes = await readFile(path, 'utf8')
    assert.equal((await seedData({ ...options, limit: 0 })).unattempted, 1)
    assert.equal(attempts, 1)
    stale = false
    const corrected = await seedData(options)
    assert.equal(corrected.unattempted, 0)
    assert.equal(attempts, 2)
    const rows = await readSeedRows(output)
    assert.equal(rows.length, 2)
    assert.equal(rows[0].key, rows[1].key)
    assert.equal(rows[1].attempt, 2)
    assert.equal(await readFile(path, 'utf8'), originalBytes)
    assert.equal((await seedData(options)).unattempted, 0)
    assert.equal(attempts, 2)
  } finally {
    await rm(setupOptions.root, { recursive: true, force: true })
  }
})
