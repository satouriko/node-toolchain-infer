import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import test from 'node:test'

import { compileInitial } from '../maintenance/compile-initial.js'
import { digest, type Fixture, FROZEN_LOCKFILES, SEED_PROTOCOL } from '../maintenance/model.js'
import { reusableObservation } from '../maintenance/run-matrix.js'
import { frozenArgs } from '../maintenance/runner.js'
import { monitorFacts } from '../maintenance/seed-monitor.js'
import { readSeedRows, seedData, type SeedRow } from '../scripts/seed-data.js'

import { makeObservation } from './maintenance-fixture.js'

import type { Tool } from '../maintenance/provision.js'
import type { Catalog } from '../src/types.js'

const fixture: Fixture = {
  id: 'legacy',
  manager: 'pnpm',
  version: '2.25.7',
  directory: 'legacy',
  lock: 'shrinkwrap.yaml',
  match: { format: 3, file: 'shrinkwrap.yaml' },
  dependencies: {},
}
const release = { version: fixture.version, node: '*', integrity: 'official-tool-integrity' }
const catalog: Catalog = {
  schemaVersion: 1,
  generatedAt: '2026-09-09',
  sources: [],
  nodes: [],
  warnings: [],
  managers: { npm: [], pnpm: [release], yarn: [] },
}
const tool: Tool = {
  version: release.version,
  node: '/test/node',
  nodeVersion: '10.24.1',
  nodeArch: process.arch,
  nodeIntegrity: 'node-integrity',
  cli: '/test/pnpm',
  integrity: release.integrity,
  url: 'https://registry.npmjs.org/pnpm/-/pnpm-2.25.7.tgz',
}
const oldCommand = ['install', '--frozen-lockfile', '--ignore-scripts']

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'historical-pnpm-'))
  await mkdir(join(root, 'fixtures', fixture.directory), { recursive: true })
  await writeFile(join(root, 'fixtures', fixture.directory, 'package.json'), '{}')
  await writeFile(join(root, 'fixtures', fixture.directory, fixture.lock), '{}')
  await writeFile(join(root, 'fixtures/recipes.json'), JSON.stringify([fixture]))
  const inputHashes = { 'package.json': digest('{}'), 'shrinkwrap.yaml': digest('{}') }
  const watched = { ...Object.fromEntries(FROZEN_LOCKFILES.map((file) => [file, '<missing>'])), ...inputHashes }
  const observation = makeObservation({
    manager: fixture.manager,
    version: release.version,
    actualVersion: release.version,
    fixtureId: fixture.id,
    fixtureHash: digest(JSON.stringify(inputHashes)),
    inputHashes,
    beforeHashes: watched,
    afterHashes: watched,
    command: frozenArgs(fixture.manager, release.version),
    node: tool.nodeVersion,
    nodeIntegrity: tool.nodeIntegrity,
    nodeArch: tool.nodeArch,
    platform: process.platform,
    arch: process.arch,
    toolIntegrity: release.integrity,
    status: 'incompatible',
    exitCode: 1,
  })
  return { root, observation }
}

test('seed resumes stale pnpm commands without discarding the original attempts', async () => {
  const { root, observation } = await setup()
  let attempts = 0
  let stale = true
  try {
    const options = {
      root,
      catalog,
      quiet: true,
      provisionTool: () => Promise.resolve(tool),
      installFixture: () =>
        Promise.resolve({
          ...observation,
          id: `attempt-${++attempts}`,
          command: stale ? oldCommand : observation.command,
        }),
    }
    const first = await seedData(options)
    assert.equal(first.unattempted, 1, 'a saved obsolete command cannot satisfy the current protocol')
    const output = join(root, 'maintenance/evidence/initial-matrix')
    const original = (await readSeedRows(output))[0]
    const originalBytes = await readFile(join(output, 'rows', `${original.id}.json`), 'utf8')
    assert.equal((await seedData({ ...options, limit: 0 })).unattempted, 1)
    assert.equal(attempts, 1)
    stale = false
    const corrected = await seedData(options)
    assert.equal(corrected.unattempted, 0)
    assert.equal(corrected.statuses.incompatible, 1)
    assert.equal(attempts, 2, 'an obsolete conclusive command is rerun without retryIncomplete')
    assert.equal((await readSeedRows(output)).length, 2)
    assert.equal(await readFile(join(output, 'rows', `${original.id}.json`), 'utf8'), originalBytes)
    await seedData(options)
    assert.equal(attempts, 2, 'the corrected exact command resumes normally')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('compiler, scheduled monitor and local matrix all reject the obsolete pnpm command', async () => {
  const { root, observation } = await setup()
  try {
    for (const stale of [false, true]) {
      const candidate = { ...observation, command: stale ? oldCommand : observation.command }
      const row: SeedRow = {
        id: 'row',
        attempt: 1,
        key: 'combination',
        protocol: SEED_PROTOCOL,
        manager: fixture.manager,
        version: release.version,
        fixtureId: fixture.id,
        fixtureHash: candidate.fixtureHash,
        catalogHash: digest(JSON.stringify(catalog)),
        createdAt: candidate.createdAt,
        status: candidate.status,
        observation: candidate,
      }
      const compiled = compileInitial({
        catalog,
        fixtures: [fixture],
        fixtureHashes: { [fixture.id]: candidate.fixtureHash },
        rows: [row],
      })
      assert.equal(compiled.report.fixtures[0]?.points[0]?.outcome, stale ? 'unknown' : 'unsupported')
      assert.equal(
        monitorFacts(catalog, [{ fixture, hash: candidate.fixtureHash }], [candidate]).covered.size,
        stale ? 0 : 1,
      )
      assert.equal(Boolean(await reusableObservation(fixture, tool, join(root, 'fixtures'), [candidate])), !stale)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
