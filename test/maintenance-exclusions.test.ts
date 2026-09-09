import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { compileInitialPaths } from '../maintenance/compile-initial.js'
import { digest, type Fixture, FROZEN_LOCKFILES, SEED_PROTOCOL } from '../maintenance/model.js'
import { importSeedMonitor } from '../maintenance/seed-monitor.js'

import { makeObservation } from './maintenance-fixture.js'

import type { Catalog } from '../src/types.js'

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'evidence-exclusions-test-'))
  const evidence = join(root, 'evidence')
  const fixture: Fixture = {
    id: 'npm-lock',
    manager: 'npm',
    version: '1.1.0',
    directory: 'npm',
    lock: 'package-lock.json',
    match: { format: 3 },
    dependencies: { 'is-number': '7.0.0' },
  }
  await mkdir(join(root, 'fixtures/npm'), { recursive: true })
  await mkdir(join(evidence, 'rows'), { recursive: true })
  await mkdir(join(evidence, 'logs'), { recursive: true })
  await writeFile(join(root, 'fixtures/npm/package.json'), '{}')
  await writeFile(join(root, 'fixtures/npm/package-lock.json'), '{"lockfileVersion":3}')
  const inputs = { 'package-lock.json': digest('{"lockfileVersion":3}'), 'package.json': digest('{}') }
  const hash = digest(JSON.stringify(inputs))
  const watched = { ...Object.fromEntries(FROZEN_LOCKFILES.map((name) => [name, '<missing>'])), ...inputs }
  const catalog: Catalog = {
    schemaVersion: 1,
    generatedAt: '2026-09-09T00:00:00Z',
    sources: [],
    warnings: [],
    nodes: [{ version: '18.20.8' }],
    managers: {
      npm: ['1.0.0', '1.1.0'].map((version) => ({ version, node: '>=18', integrity: `artifact-${version}` })),
      pnpm: [],
      yarn: [],
    },
  }
  for (const [id, version, status] of [
    ['lower', '1.0.0', 'incompatible'],
    ['pass', '1.1.0', 'pass'],
    ['misclassified', '1.1.0', 'incompatible'],
  ] as const) {
    const observation = makeObservation({
      id: `observation-${id}`,
      key: id,
      fixtureId: fixture.id,
      fixtureHash: hash,
      version,
      actualVersion: version,
      toolIntegrity: `artifact-${version}`,
      command: ['ci', '--ignore-scripts', '--no-audit', '--no-fund'],
      inputHashes: inputs,
      beforeHashes: watched,
      afterHashes: watched,
      installed: fixture.dependencies,
      status,
      exitCode: status === 'pass' ? 0 : 1,
      logPath: `logs/${id}.log`,
    })
    await writeFile(
      join(evidence, 'rows', `${id}.json`),
      JSON.stringify({
        id,
        key: id,
        protocol: SEED_PROTOCOL,
        manager: 'npm',
        version,
        fixtureId: fixture.id,
        fixtureHash: hash,
        catalogHash: digest(JSON.stringify(catalog)),
        createdAt: '2026-09-09T00:00:00Z',
        attempt: 1,
        status,
        observation,
      }),
    )
    await writeFile(
      join(evidence, `logs/${id}.log`),
      id === 'misclassified' ? 'YN0018 checksum failure, not a proven lock format rejection' : status,
    )
  }
  await writeFile(join(root, 'catalog.json'), JSON.stringify(catalog))
  await writeFile(join(evidence, 'catalog.json'), JSON.stringify(catalog))
  await writeFile(join(root, 'recipes.json'), JSON.stringify([fixture]))
  const raw = await readFile(join(evidence, 'rows/misclassified.json'))
  const entry = {
    rowId: 'misclassified',
    observationId: 'observation-misclassified',
    rowSha256: digest(raw),
    reason: 'Reviewed command log: checksum failure was wrongly classified as format incompatibility',
    reviewedAt: '2026-09-09T10:00:00Z',
  }
  return {
    root,
    evidence,
    catalog,
    raw,
    entry,
    samples: [{ fixture, hash }],
    paths: {
      catalog: join(root, 'catalog.json'),
      recipes: join(root, 'recipes.json'),
      fixturesRoot: join(root, 'fixtures'),
      evidence: [evidence],
      output: join(root, 'compiled'),
    },
  }
}

test('compiler and monitor consistently exclude only reviewed row identities and retain source evidence and audit', async () => {
  const value = await setup()
  try {
    const before = await compileInitialPaths(value.paths)
    assert.ok(before.report.fixtures[0].issues.some((issue) => issue.code === 'contradictory-outcomes'))
    const exclusionBytes = JSON.stringify(
      { schemaVersion: 1, entries: [{ ...value.entry, observationId: undefined }] },
      null,
      2,
    )
    await writeFile(join(value.evidence, 'exclusions.json'), exclusionBytes)
    const compiled = await compileInitialPaths(value.paths)
    assert.equal(compiled.data.rules[0].range, '>=1.1.0')
    assert.equal(compiled.report.exclusions?.[0].reason, value.entry.reason)
    assert.ok(!JSON.stringify(compiled.data).includes('observation-misclassified'))
    const destination = join(value.root, 'state')
    const imported = await importSeedMonitor({
      directories: [value.evidence],
      destination,
      catalog: value.catalog,
      samples: value.samples,
    })
    assert.equal(imported.observations.length, 2)
    assert.deepEqual(imported.excludedObservationIds, ['observation-misclassified'])
    const archive = join(destination, 'seed-evidence/exclusions', digest(exclusionBytes))
    assert.equal(await readFile(join(archive, 'exclusions.json'), 'utf8'), exclusionBytes)
    assert.deepEqual(await readFile(join(archive, 'rows', `${value.entry.rowSha256}.json`)), value.raw)
    assert.deepEqual(await readFile(join(value.evidence, 'rows/misclassified.json')), value.raw)
    assert.match(await readFile(join(value.evidence, 'logs/misclassified.log'), 'utf8'), /YN0018/)
    const resumed = await importSeedMonitor({
      directories: [],
      destination,
      catalog: value.catalog,
      samples: value.samples,
    })
    assert.deepEqual(
      resumed.excludedObservationIds,
      ['observation-misclassified'],
      'archived exclusion must survive unavailable original seed checkout',
    )
  } finally {
    await rm(value.root, { recursive: true, force: true })
  }
})

test('bad exclusion hashes, identities, reasons and unmatched rows fail loudly in both production entry points', async () => {
  const value = await setup()
  try {
    for (const override of [
      { rowSha256: '0'.repeat(64) },
      { observationId: 'different-observation' },
      { reason: '  ' },
      { reviewedAt: 'not-a-date' },
      { rowId: 'absent-row' },
    ]) {
      await writeFile(
        join(value.evidence, 'exclusions.json'),
        JSON.stringify({ schemaVersion: 1, entries: [{ ...value.entry, ...override }] }),
      )
      await assert.rejects(compileInitialPaths(value.paths), /exclusion/i)
      const imported = await importSeedMonitor({
        directories: [value.evidence],
        destination: join(value.root, `state-${Object.keys(override)[0]}`),
        catalog: value.catalog,
        samples: value.samples,
      })
      assert.ok(
        imported.incomplete.some((message) => /exclusion/i.test(message)),
        JSON.stringify(imported),
      )
    }
    assert.deepEqual(await readdir(join(value.evidence, 'rows')), ['lower.json', 'misclassified.json', 'pass.json'])
  } finally {
    await rm(value.root, { recursive: true, force: true })
  }
})
