import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { compileInitial, compileInitialPaths } from '../maintenance/compile-initial.js'
import { observationFingerprint } from '../maintenance/known-bugs.js'
import {
  digest,
  type Fixture,
  FROZEN_LOCKFILES,
  FROZEN_PROTOCOL,
  type Observation,
  type Outcome,
  SEED_PROTOCOL,
} from '../maintenance/model.js'

import { makeObservation } from './maintenance-fixture.js'

import type { SeedRow } from '../scripts/seed-data.js'
import type { Catalog } from '../src/types.js'

const fixture: Fixture = {
  id: 'lock',
  manager: 'npm',
  version: '2.0.0',
  directory: 'lock',
  lock: 'package-lock.json',
  match: { format: 3 },
  dependencies: { 'is-number': '7.0.0' },
}
const before = { 'package-lock.json': 'lock-hash', 'package.json': 'manifest-hash' }
const fixtureHash = digest(JSON.stringify(before))
const watched = (inputs: Record<string, string>): Record<string, string> => ({
  ...Object.fromEntries(FROZEN_LOCKFILES.map((file) => [file, '<missing>'])),
  ...inputs,
})
function catalog(versions: string[]): Catalog {
  return {
    schemaVersion: 1,
    generatedAt: '2026-09-09T00:00:00Z',
    sources: [],
    nodes: [],
    warnings: [],
    managers: {
      npm: versions.map((version) => ({ version, node: '*', integrity: `integrity-${version}` })),
      pnpm: [],
      yarn: [],
    },
  }
}
function row(
  version: string,
  status: Outcome,
  metadata: Catalog,
  overrides: Partial<Observation> = {},
  sample = fixture,
): SeedRow {
  const observation = makeObservation({
    id: `${sample.id}-${version}-${status}`,
    protocol: FROZEN_PROTOCOL,
    inputHashes: overrides.inputHashes ?? overrides.beforeHashes ?? before,
    manager: sample.manager,
    version,
    actualVersion: version,
    fixtureId: sample.id,
    fixtureHash,
    status,
    toolIntegrity: `integrity-${version}`,
    command: ['ci', '--ignore-scripts', '--no-audit', '--no-fund'],
    beforeHashes: before,
    afterHashes: status === 'rewrite' ? { ...before, 'package-lock.json': 'rewritten' } : before,
    installed: status === 'semantic-mismatch' ? {} : sample.dependencies,
    semantic: status !== 'semantic-mismatch',
    exitCode: status === 'incompatible' || status === 'inconclusive' ? 1 : 0,
    ...overrides,
  })
  observation.beforeHashes = watched(observation.beforeHashes)
  observation.afterHashes = watched(observation.afterHashes)
  return {
    id: `row-${observation.id}`,
    key: observation.id,
    protocol: SEED_PROTOCOL,
    manager: sample.manager,
    version,
    fixtureId: sample.id,
    fixtureHash,
    catalogHash: digest(JSON.stringify(metadata)),
    createdAt: observation.createdAt,
    attempt: 1,
    status,
    observation,
  }
}
function compile(metadata: Catalog, rows: SeedRow[], fixtures = [fixture]) {
  return compileInitial({
    catalog: metadata,
    rows,
    fixtures,
    fixtureHashes: Object.fromEntries(fixtures.map((item) => [item.id, fixtureHash])),
  })
}

test('confirmed adjacent behavior changes compile restored support and leave its future open', () => {
  const metadata = catalog(['1.0.0', '1.1.0', '1.2.0', '1.3.0', '2.0.0'])
  const result = compile(metadata, [
    row('1.0.0', 'incompatible', metadata),
    row('1.1.0', 'pass', metadata),
    row('1.2.0', 'rewrite', metadata),
    row('1.3.0', 'semantic-mismatch', metadata),
    row('2.0.0', 'pass', metadata),
  ])
  assert.equal(result.data.rules[0]?.range, '>=1.1.0 <1.2.0 || >=2.0.0')
  assert.equal(result.data.rules[0]?.match.file, 'package-lock.json')
  assert.equal(Object.hasOwn(result.data.rules[0], 'provenance'), false)
  assert.ok(result.report.fixtures[0]?.boundaries.some((edge) => edge.evidenceIds.includes('lock-1.2.0-rewrite')))
  assert.deepEqual(result.data.observations, [])
})

test('sparse transitions and cross-Node transitions remain unknown rather than invented bounds', () => {
  const metadata = catalog(['1.0.0', '1.1.0', '2.0.0'])
  const sparse = compile(metadata, [row('1.0.0', 'incompatible', metadata), row('2.0.0', 'pass', metadata)])
  assert.equal(sparse.data.rules[0]?.range, undefined)
  assert.ok(sparse.report.fixtures[0]?.issues.some((issue) => issue.code === 'unconfirmed-transition'))
  const cross = compile(metadata, [
    row('1.0.0', 'incompatible', metadata),
    row('1.1.0', 'pass', metadata, { node: '20.0.0' }),
    row('2.0.0', 'pass', metadata),
  ])
  assert.equal(cross.data.rules[0]?.range, undefined)
  assert.ok(cross.report.fixtures[0]?.issues.some((issue) => issue.code === 'incomparable-transition'))
})

test('historical Yarn semantic failures require a PnP-aware verification receipt', () => {
  const metadata = catalog(['2.0.0', '2.1.0'])
  metadata.managers.yarn = metadata.managers.npm
  metadata.managers.npm = []
  const sample: Fixture = { ...fixture, manager: 'yarn', lock: 'yarn.lock' }
  const inputs = { 'yarn.lock': 'lock', 'package.json': 'manifest' }
  const hash = digest(JSON.stringify(inputs))
  const candidates = ['2.0.0', '2.1.0'].map((version) => {
    const item = row(
      version,
      version === '2.0.0' ? 'semantic-mismatch' : 'pass',
      metadata,
      {
        inputHashes: inputs,
        beforeHashes: inputs,
        afterHashes: inputs,
        fixtureHash: hash,
        command: ['install', '--immutable'],
        semanticMethod: undefined,
      },
      sample,
    )
    item.fixtureHash = hash
    return item
  })
  const result = compileInitial({
    catalog: metadata,
    rows: candidates,
    fixtures: [sample],
    fixtureHashes: { lock: hash },
  })
  assert.equal(result.report.fixtures[0]?.points.find((point) => point.version === '2.0.0')?.outcome, 'unknown')
  assert.ok(result.report.fixtures[0]?.issues.some((item) => item.detail.includes('PnP')))
})

test('explicit original catalogs allow unchanged artifact evidence to survive an expanded release list', () => {
  const original = catalog(['1.0.0', '2.0.0'])
  const expanded = catalog(['1.0.0', '1.5.0', '2.0.0', '3.0.0'])
  const rows = [
    row('1.0.0', 'incompatible', original),
    row('2.0.0', 'pass', original),
    row('1.5.0', 'pass', expanded),
    row('3.0.0', 'incompatible', expanded),
  ]
  const options = {
    catalog: expanded,
    evidenceCatalogs: [original],
    rows,
    fixtures: [fixture],
    fixtureHashes: { lock: fixtureHash },
  }
  const result = compileInitial(options)
  assert.equal(result.data.rules[0]?.range, '>=1.5.0 <3.0.0')
  assert.equal(compileInitial({ ...options, evidenceCatalogs: [] }).data.rules.length, 0)
  expanded.managers.npm.find((release) => release.version === '2.0.0')!.integrity = 'different-artifact'
  const changed = compileInitial(options)
  assert.equal(changed.report.fixtures[0].points.find((point) => point.version === '2.0.0')?.outcome, 'unknown')
  assert.ok(changed.report.fixtures[0].issues.some((issue) => issue.code === 'invalid-evidence'))
})

test('inconclusive tail cannot create an upper bound or erase a confirmed earlier interval', () => {
  const metadata = catalog(['1.0.0', '1.1.0', '2.0.0'])
  const result = compile(metadata, [
    row('1.0.0', 'incompatible', metadata),
    row('1.1.0', 'pass', metadata),
    row('2.0.0', 'inconclusive', metadata),
  ])
  assert.equal(result.data.rules[0]?.range, '>=1.1.0')
  assert.equal(result.report.fixtures[0]?.points.at(-1)?.outcome, 'unknown')
})

test('prerelease rejection bounds do not truncate stable support', () => {
  const metadata = catalog(['1.0.0', '1.1.0', '2.0.0-beta.1', '2.0.0-beta.2', '2.0.0'])
  const result = compile(metadata, [
    row('1.0.0', 'incompatible', metadata),
    row('1.1.0', 'pass', metadata),
    row('2.0.0-beta.1', 'rewrite', metadata),
    row('2.0.0-beta.2', 'pass', metadata),
    row('2.0.0', 'pass', metadata),
  ])
  assert.equal(result.data.rules[0]?.range, '>=1.1.0')
  assert.equal(result.report.fixtures[0]?.points.length, 3)
})

test('prerelease observations do not enter compiled ranges or report points', () => {
  const metadata = catalog([
    '0.9.0',
    '1.0.0-rc.0',
    '1.0.0-rc.1',
    '1.0.0',
    '1.1.0-beta.0',
    '1.1.0-beta.1',
    '1.1.0-beta.2',
    '1.1.0-beta.3',
    '1.1.0',
  ])
  const rows = metadata.managers.npm.map(({ version }) =>
    row(version, ['0.9.0', '1.1.0-beta.2'].includes(version) ? 'incompatible' : 'pass', metadata),
  )
  const result = compile(metadata, rows)
  assert.equal(result.data.rules[0]?.range, '>=1.0.0')
})

test('prerelease-only support stays outside reports and cannot restrict stable compatibility', () => {
  const metadata = catalog(['0.9.0', '1.0.0-rc.1', '1.0.0-rc.2', '1.0.0-rc.3', '1.0.0'])
  for (const earlier of ['incompatible', 'inconclusive'] as const) {
    const result = compile(metadata, [
      row('0.9.0', earlier, metadata),
      row('1.0.0-rc.1', 'pass', metadata),
      row('1.0.0-rc.2', 'pass', metadata),
      row('1.0.0-rc.3', 'incompatible', metadata),
      row('1.0.0', 'incompatible', metadata),
    ])
    assert.equal(result.report.fixtures[0].range, null)
    assert.deepEqual(result.data.rules, [])
    assert.deepEqual(
      result.report.fixtures[0].points.filter((point) => point.outcome === 'supported').map((point) => point.version),
      [],
    )
    assert.ok(result.report.fixtures[0].issues.some((problem) => problem.code === 'unknown-lower-bound'))
  }
})

test('reviewed upstream bugs preserve failed evidence while compiling semantic compatibility', () => {
  const metadata = catalog(['1.0.0', '1.1.0', '1.2.0', '1.3.0'])
  const failed = row('1.2.0', 'incompatible', metadata)
  const rows = [
    row('1.0.0', 'incompatible', metadata),
    row('1.1.0', 'pass', metadata),
    failed,
    row('1.3.0', 'pass', metadata),
  ]
  const original = JSON.stringify(rows)
  const result = compileInitial({
    catalog: metadata,
    rows,
    fixtures: [fixture],
    fixtureHashes: { lock: fixtureHash },
    knownBugs: [
      {
        id: 'test-upstream-bug',
        manager: 'npm',
        range: '>=1.2.0-beta.1 <1.2.1',
        fixtureIds: ['lock'],
        reason: 'Installer fails despite understanding this format.',
        url: 'https://github.com/npm/cli/issues/1',
        semanticEvidence: 'Reviewed upstream reader and fixture generation establish format compatibility.',
        reviewedAt: '2026-09-09T00:00:00Z',
        observations: [{ id: failed.observation!.id, fingerprint: observationFingerprint(failed.observation!) }],
      },
    ],
  })
  assert.equal(result.data.rules[0]?.range, '>=1.1.0')
  assert.equal(result.data.rules[0]?.knownBugs?.[0]?.range, '>=1.2.0 <1.2.1')
  assert.equal(result.report.fixtures[0]?.points[2]?.exceptions?.[0]?.bugId, 'test-upstream-bug')
  assert.equal(result.report.fixtures[0]?.points[2]?.exceptions?.[0]?.status, 'incompatible')
  assert.equal(JSON.stringify(rows), original)
})

test('forged pass receipts and contradictory retry outcomes cannot establish support', () => {
  const metadata = catalog(['1.0.0', '1.1.0'])
  const invalid = compile(metadata, [
    row('1.0.0', 'incompatible', metadata),
    row('1.1.0', 'pass', metadata, { installed: {} }),
  ])
  assert.equal(invalid.data.rules[0]?.range, undefined)
  assert.equal(invalid.report.fixtures[0]?.points[1]?.outcome, 'unknown')
  const conflict = compile(metadata, [
    row('1.0.0', 'incompatible', metadata),
    row('1.1.0', 'pass', metadata),
    row('1.1.0', 'rewrite', metadata),
  ])
  assert.equal(conflict.data.rules[0]?.range, undefined)
  assert.ok(conflict.report.fixtures[0]?.issues.some((issue) => issue.code === 'contradictory-outcomes'))
})

test('identical numeric formats in npm lock and shrinkwrap retain separate rules', () => {
  const metadata = catalog(['1.0.0', '1.1.0', '2.0.0'])
  const shrink: Fixture = { ...fixture, id: 'shrink', lock: 'npm-shrinkwrap.json' }
  const shrinkHashes = { ...before, 'npm-shrinkwrap.json': 'shrink-hash' }
  const shrinkHash = digest(JSON.stringify(shrinkHashes))
  const rows = [row('1.0.0', 'incompatible', metadata), row('1.1.0', 'pass', metadata), row('2.0.0', 'pass', metadata)]
  for (const [version, status] of [
    ['1.0.0', 'incompatible'],
    ['1.1.0', 'pass'],
    ['2.0.0', 'rewrite'],
  ] as const) {
    const record = row(
      version,
      status,
      metadata,
      {
        fixtureHash: shrinkHash,
        beforeHashes: shrinkHashes,
        afterHashes: status === 'rewrite' ? { ...shrinkHashes, 'npm-shrinkwrap.json': 'rewrite' } : shrinkHashes,
      },
      shrink,
    )
    record.fixtureHash = shrinkHash
    rows.push(record)
  }
  const result = compileInitial({
    catalog: metadata,
    fixtures: [fixture, shrink],
    fixtureHashes: { lock: fixtureHash, shrink: shrinkHash },
    rows,
  })
  assert.equal(result.data.rules.find((rule) => rule.match.file === 'package-lock.json')?.range, '>=1.1.0')
  assert.equal(result.data.rules.find((rule) => rule.match.file === 'npm-shrinkwrap.json')?.range, '>=1.1.0 <2.0.0')
})

test('a contradictory tail cannot disappear into unknown while an open range admits its measured rejection', () => {
  const metadata = catalog(['1.0.0', '1.1.0', '2.0.0'])
  const result = compile(metadata, [
    row('1.0.0', 'incompatible', metadata),
    row('1.1.0', 'pass', metadata),
    row('2.0.0', 'pass', metadata),
    row('2.0.0', 'rewrite', metadata),
  ])
  assert.equal(result.data.rules[0]?.range, undefined)
})

test('missing parsed format never compiles a broad filename-only rule', () => {
  const metadata = catalog(['1.0.0', '1.1.0'])
  const unparsed = { ...fixture, match: {} }
  const result = compile(metadata, [row('1.0.0', 'incompatible', metadata), row('1.1.0', 'pass', metadata)], [unparsed])
  assert.equal(result.data.rules[0]?.range, undefined)
  assert.ok(result.report.fixtures[0]?.issues.some((item) => item.code === 'unknown-format'))
})

test('nested feature sets cannot collapse into the same rule identity', () => {
  const metadata = catalog(['1.0.0', '1.1.0'])
  const a = { ...fixture, id: 'a', match: { format: 3, features: { workspace: { layout: 'a' } } } }
  const b = { ...fixture, id: 'b', match: { format: 3, features: { workspace: { layout: 'b' } } } }
  const result = compile(
    metadata,
    [
      row('1.0.0', 'incompatible', metadata, {}, a),
      row('1.1.0', 'pass', metadata, {}, a),
      row('1.0.0', 'incompatible', metadata, {}, b),
      row('1.1.0', 'pass', metadata, {}, b),
    ],
    [a, b],
  )
  assert.equal(result.data.rules.length, 2)
})

test('unconfirmed transitions expose adjacent retest tasks with common official engine-compatible Nodes', () => {
  const metadata = catalog(['1.0.0', '1.1.0', '2.0.0'])
  metadata.nodes = [
    { version: '18.20.8', npm: '10.8.2', lts: 'Hydrogen', date: '2025-03-27' },
    { version: '20.0.0', npm: '9.6.4', lts: false, date: '2023-04-18' },
  ]
  metadata.managers.npm[0].node = '>=18 <20'
  metadata.managers.npm[1].node = '>=18'
  const result = compile(metadata, [
    row('1.0.0', 'incompatible', metadata),
    row('2.0.0', 'pass', metadata, { node: '20.0.0' }),
  ])
  assert.deepEqual(
    result.report.retests.map((task) => [task.beforeVersion, task.afterVersion]),
    [
      ['1.0.0', '1.1.0'],
      ['1.1.0', '2.0.0'],
    ],
  )
  assert.deepEqual(result.report.retests[0]?.nodeCandidates, ['18.20.8'])
  assert.equal(result.report.retests[0]?.fixtureId, fixture.id)
  assert.equal(result.report.retests[0]?.existingBefore[0]?.node, '18.20.8')
})

test('disk entry writes an unknown data file and retest reports into explicit output without changing inputs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'compile-initial-test-'))
  try {
    const metadata = catalog(['1.0.0', '1.1.0'])
    const fixturesRoot = join(root, 'fixtures')
    const directory = join(fixturesRoot, fixture.directory)
    const evidence = join(root, 'evidence')
    await mkdir(directory, { recursive: true })
    await mkdir(join(evidence, 'rows'), { recursive: true })
    await writeFile(join(directory, 'package.json'), '{"dependencies":{"is-number":"7.0.0"}}')
    await writeFile(join(directory, fixture.lock), '{"lockfileVersion":3}')
    const fileHashes = {
      'package-lock.json': digest('{"lockfileVersion":3}'),
      'package.json': digest('{"dependencies":{"is-number":"7.0.0"}}'),
    }
    const hash = digest(JSON.stringify(fileHashes))
    for (const [version, status, node] of [
      ['1.0.0', 'incompatible', '18.20.8'],
      ['1.1.0', 'pass', '20.0.0'],
    ] as const) {
      const record = row(version, status, metadata, {
        fixtureHash: hash,
        beforeHashes: fileHashes,
        afterHashes: fileHashes,
        node,
      })
      record.fixtureHash = hash
      await writeFile(join(evidence, 'rows', `${version}.json`), JSON.stringify(record))
    }
    const catalogPath = join(root, 'catalog.json')
    const recipes = join(root, 'recipes.json')
    await writeFile(catalogPath, JSON.stringify(metadata))
    await writeFile(recipes, JSON.stringify([fixture]))
    const original = await readFile(join(evidence, 'rows/1.0.0.json'), 'utf8')
    const output = join(root, 'review')
    const result = await compileInitialPaths({
      catalog: catalogPath,
      recipes,
      fixturesRoot,
      evidence: [evidence],
      output,
    })
    assert.equal(result.report.exitCode, 1)
    assert.deepEqual(JSON.parse(await readFile(join(output, 'compatibility.json'), 'utf8')).rules, [])
    assert.match(await readFile(join(output, 'report.md'), 'utf8'), /Retest tasks/)
    assert.equal(await readFile(join(evidence, 'rows/1.0.0.json'), 'utf8'), original)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('tampered receipt identity, stale fixture, catalog mismatch and non-frozen commands remain incomplete', () => {
  const metadata = catalog(['1.0.0', '1.1.0'])
  const invalid: Array<Partial<Observation>> = [
    { actualVersion: '9.9.9' },
    { toolIntegrity: 'different-artifact' },
    { fixtureHash: 'previous-fixture' },
    { nodeIntegrity: '' },
    { command: ['install'] },
    { exitCode: 1 },
    { afterHashes: { ...before, 'package-lock.json': 'changed' } },
  ]
  for (const overrides of invalid) {
    const result = compile(metadata, [
      row('1.0.0', 'incompatible', metadata),
      row('1.1.0', 'pass', metadata, overrides),
    ])
    assert.equal(result.data.rules[0]?.range, undefined)
    assert.equal(result.report.exitCode, 2)
  }
  const otherCatalog = row('1.1.0', 'pass', metadata)
  otherCatalog.catalogHash = 'other-snapshot'
  assert.equal(
    compile(metadata, [row('1.0.0', 'incompatible', metadata), otherCatalog]).data.rules[0]?.range,
    undefined,
  )
})

test('all-pass samples cannot manufacture an unmeasured lower bound', () => {
  const metadata = catalog(['1.0.0', '1.1.0'])
  const result = compile(metadata, [row('1.0.0', 'pass', metadata), row('1.1.0', 'pass', metadata)])
  assert.equal(result.data.rules[0]?.range, undefined)
  assert.equal(result.report.fixtures[0]?.points[0]?.outcome, 'supported')
  assert.ok(result.report.fixtures[0]?.issues.some((item) => item.code === 'unknown-lower-bound'))
})

test('unknown raw outcomes never become negative evidence', () => {
  const metadata = catalog(['1.0.0', '1.1.0'])
  const invalid = row('1.0.0', 'incompatible', metadata)
  Object.assign(invalid, { status: 'environment-error' })
  Object.assign(invalid.observation!, { status: 'environment-error' })
  const result = compile(metadata, [invalid, row('1.1.0', 'pass', metadata)])
  assert.equal(result.data.rules[0]?.range, undefined)
  assert.equal(result.report.fixtures[0]?.points[0]?.outcome, 'unknown')
})

test('superseded protocol cannot negate current protocol results and new root lockfiles cannot pass', () => {
  const metadata = catalog(['1.0.0', '1.1.0'])
  const old = row('1.1.0', 'incompatible', metadata)
  old.protocol = 'frozen-initial-matrix-v1'
  const current = [row('1.0.0', 'incompatible', metadata), row('1.1.0', 'pass', metadata)]
  const result = compile(metadata, [...current, old])
  assert.equal(result.data.rules[0]?.range, '>=1.1.0')
  assert.equal(result.report.exitCode, 0)
  assert.ok(result.report.fixtures[0]?.issues.some((item) => item.code === 'superseded'))
  const added = row('1.1.0', 'pass', metadata, { afterHashes: { ...before, 'yarn.lock': 'unexpected-new-lock' } })
  assert.equal(compile(metadata, [current[0], added]).data.rules[0]?.range, undefined)
})

test('compiled output passes the actual public data validator while unknown formats stay report-only', async () => {
  const { validateCompatibility } = await import('../src/data-validation.js')
  const metadata = catalog(['1.0.0', '1.1.0'])
  const unknown = compile(metadata, [])
  assert.deepEqual(validateCompatibility(unknown.data).rules, [])
  assert.equal(unknown.report.fixtures[0]?.range, null)
  const known = compile(metadata, [row('1.0.0', 'incompatible', metadata), row('1.1.0', 'pass', metadata)])
  assert.equal(validateCompatibility(known.data).rules[0]?.range, '>=1.1.0')
})

test('successful retries resolve historical environment failures without discarding either attempt order', () => {
  const metadata = catalog(['1.0.0', '1.1.0'])
  const success = row('1.1.0', 'pass', metadata)
  const network = row('1.1.0', 'inconclusive', metadata)
  for (const attempts of [
    [network, success],
    [success, network],
  ]) {
    const result = compile(metadata, [row('1.0.0', 'incompatible', metadata), ...attempts])
    assert.equal(result.data.rules[0]?.range, '>=1.1.0')
    assert.equal(result.report.exitCode, 0)
    assert.equal(result.report.fixtures[0]?.points[1]?.rowIds.length, 2)
    assert.ok(result.report.fixtures[0]?.issues.some((item) => item.code === 'historical-attempt'))
  }
})

test('historical prerelease-only bug reviews do not enter current reports or published markers', () => {
  const metadata = catalog(['1.0.0-beta.1', '1.0.0', '1.1.0'])
  const old = row('1.0.0-beta.1', 'incompatible', metadata)
  const rows = [old, row('1.0.0', 'incompatible', metadata), row('1.1.0', 'pass', metadata)]
  const reviews = [
    {
      id: 'historical-prerelease-bug',
      manager: 'npm' as const,
      range: '>=1.0.0-beta.0 <1.0.0',
      fixtureIds: ['lock'],
      reason: 'Historical prerelease installer failure.',
      url: 'https://example.com/historical-bug',
      semanticEvidence: 'Archived reader review.',
      reviewedAt: '2026-09-09T00:00:00Z',
      observations: [{ id: old.observation!.id, fingerprint: observationFingerprint(old.observation!) }],
    },
  ]
  const archived = JSON.stringify({ rows, reviews })
  const result = compileInitial({
    catalog: metadata,
    rows,
    fixtures: [fixture],
    fixtureHashes: { lock: fixtureHash },
    knownBugs: reviews,
  })
  assert.deepEqual(result.report.knownBugs, [])
  assert.equal(result.data.rules[0].knownBugs, undefined)
  assert.equal(result.data.rules[0].range, '>=1.1.0')
  assert.equal(JSON.stringify({ rows, reviews }), archived)
})
