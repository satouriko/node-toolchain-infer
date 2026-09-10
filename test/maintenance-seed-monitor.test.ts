import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { digest, type Fixture, FROZEN_LOCKFILES, type Observation, SEED_PROTOCOL } from '../maintenance/model.js'
import { importSeedMonitor, monitorFactKey, monitorFacts, portableReleaseKey } from '../maintenance/seed-monitor.js'
import { runReleaseCheck } from '../scripts/check-releases.js'

import { makeObservation } from './maintenance-fixture.js'

import type { Catalog } from '../src/types.js'

const fixture: Fixture = {
  id: 'npm-v3',
  manager: 'npm',
  version: '10.0.0',
  directory: 'npm/v3',
  lock: 'package-lock.json',
  match: { format: 3 },
  dependencies: { 'is-number': '7.0.0' },
}
const inputHashes = { 'package-lock.json': 'lock', 'package.json': 'manifest' }
const monitored = {
  ...inputHashes,
  'npm-shrinkwrap.json': '<missing>',
  'pnpm-lock.yaml': '<missing>',
  'shrinkwrap.yaml': '<missing>',
  'yarn.lock': '<missing>',
}
const sample = { fixture, hash: digest(JSON.stringify(inputHashes)) }
const release = { version: '10.0.0', node: '>=18', integrity: 'official-integrity' }
const catalog: Catalog = {
  schemaVersion: 1,
  generatedAt: '2026-09-09',
  sources: [],
  warnings: [],
  nodes: [],
  managers: { npm: [release], pnpm: [], yarn: [] },
}
function observation(overrides: Partial<Observation> = {}): Observation {
  return makeObservation({
    id: 'seed-observation',
    protocol: 'frozen-install-v2',
    inputHashes,
    manager: 'npm',
    version: release.version,
    actualVersion: release.version,
    fixtureId: fixture.id,
    fixtureHash: sample.hash,
    beforeHashes: monitored,
    afterHashes: monitored,
    installed: fixture.dependencies,
    command: ['ci', '--ignore-scripts', '--no-audit', '--no-fund'],
    toolIntegrity: release.integrity,
    ...overrides,
  })
}

test('historical conclusive facts cover the exact artifact and fixture independently of check host runtime', () => {
  const facts = monitorFacts(
    catalog,
    [sample],
    [observation({ node: '18.20.8', platform: 'darwin', arch: 'arm64', nodeArch: 'x64' })],
  )
  assert.ok(facts.covered.has(monitorFactKey('npm', release, sample)))
  assert.equal(facts.observations[0]?.platform, 'darwin')
  assert.equal(monitorFacts(catalog, [{ ...sample, hash: 'changed-bytes' }], [observation()]).covered.size, 0)
  assert.equal(
    monitorFacts(
      { ...catalog, managers: { ...catalog.managers, npm: [{ ...release, integrity: 'replaced-tarball' }] } },
      [sample],
      [observation()],
    ).covered.size,
    0,
  )
})

test('portable release keys distinguish manager artifacts and relevant fixture contracts, not unrelated managers', () => {
  const key = portableReleaseKey('npm', release, [sample])
  assert.notEqual(key, portableReleaseKey('npm', { ...release, integrity: 'different-artifact' }, [sample]))
  assert.notEqual(key, portableReleaseKey('npm', release, [{ ...sample, hash: 'changed' }]))
  assert.equal(
    key,
    portableReleaseKey('npm', release, [
      sample,
      { fixture: { ...fixture, manager: 'yarn', id: 'yarn' }, hash: 'other' },
    ]),
  )
})

test('old protocol, alternate new lock, inconclusive and forged passes never cover history', () => {
  for (const candidate of [
    observation({ protocol: 'frozen-install-v1' }),
    observation({ status: 'inconclusive', exitCode: 1 }),
    observation({ afterHashes: { ...monitored, 'yarn.lock': 'new-lock' } }),
    observation({ installed: {} }),
    observation({ beforeHashes: inputHashes, afterHashes: inputHashes }),
  ]) {
    assert.equal(monitorFacts(catalog, [sample], [candidate]).covered.size, 0)
  }
})

test('genuine negative contract results are reusable but contradictory conclusive attempts are unresolved', () => {
  const rejection = observation({ id: 'rejected', status: 'incompatible', exitCode: 1 })
  assert.equal(monitorFacts(catalog, [sample], [rejection]).covered.size, 1)
  const rewrite = observation({
    id: 'rewrite',
    status: 'rewrite',
    afterHashes: { ...monitored, 'yarn.lock': 'new-lock' },
  })
  assert.equal(monitorFacts(catalog, [sample], [rewrite]).covered.size, 1)
  const conflict = monitorFacts(catalog, [sample], [observation(), rejection])
  assert.equal(conflict.covered.size, 0)
  assert.equal(conflict.conflicts.length, 1)
})

test('old Yarn missing-node_modules checks do not establish incompatibility without a PnP-aware verifier', () => {
  const yarnFixture: Fixture = { ...fixture, manager: 'yarn', id: 'yarn-v3', lock: 'yarn.lock' }
  const inputs = { 'yarn.lock': 'lock', 'package.json': 'manifest' }
  const hash = digest(JSON.stringify(inputs))
  const watched = { ...Object.fromEntries(FROZEN_LOCKFILES.map((file) => [file, '<missing>'])), ...inputs }
  const metadata: Catalog = { ...catalog, managers: { npm: [], pnpm: [], yarn: [release] } }
  const candidate = observation({
    manager: 'yarn',
    fixtureId: yarnFixture.id,
    fixtureHash: hash,
    inputHashes: inputs,
    beforeHashes: watched,
    afterHashes: watched,
    command: ['install', '--immutable'],
    installed: {},
    semantic: false,
    status: 'semantic-mismatch',
    semanticMethod: undefined,
  })
  assert.equal(monitorFacts(metadata, [{ fixture: yarnFixture, hash }], [candidate]).covered.size, 0)
  assert.equal(
    monitorFacts(metadata, [{ fixture: yarnFixture, hash }], [{ ...candidate, semanticMethod: 'pnp' }]).covered.size,
    1,
  )
})

async function diskFixture() {
  const root = await mkdtemp(join(tmpdir(), 'seed-monitor-test-'))
  const source = join(root, 'fixtures', fixture.directory)
  const seed = join(root, 'maintenance/evidence/initial-matrix')
  const state = join(root, 'state')
  await mkdir(source, { recursive: true })
  await mkdir(join(seed, 'rows'), { recursive: true })
  await mkdir(join(seed, 'logs'), { recursive: true })
  await mkdir(state)
  await writeFile(join(source, 'package.json'), '{}')
  await writeFile(join(source, fixture.lock), '{"lockfileVersion":3}')
  await writeFile(join(root, 'fixtures/recipes.json'), JSON.stringify([fixture]))
  await writeFile(join(root, 'catalog.json'), JSON.stringify(catalog))
  const inputs = { 'package-lock.json': digest('{"lockfileVersion":3}'), 'package.json': digest('{}') }
  const inputHash = digest(JSON.stringify(inputs))
  const watched = { ...Object.fromEntries(FROZEN_LOCKFILES.map((file) => [file, '<missing>'])), ...inputs }
  const original = observation({
    inputHashes: inputs,
    fixtureHash: inputHash,
    beforeHashes: watched,
    afterHashes: watched,
    platform: 'other-host',
    node: '18.20.8',
    logPath: 'logs/frozen.log',
  })
  const row = {
    id: 'seed-row',
    key: 'seed-key',
    protocol: SEED_PROTOCOL,
    manager: 'npm',
    version: release.version,
    fixtureId: fixture.id,
    fixtureHash: inputHash,
    catalogHash: 'previous-official-snapshot',
    createdAt: '2026-09-09',
    attempt: 1,
    status: 'pass',
    observation: original,
  }
  const raw = JSON.stringify(row)
  await writeFile(join(seed, 'rows/one.json'), raw)
  await writeFile(join(seed, 'logs/frozen.log'), 'actual frozen command evidence\n')
  return { root, seed, state, row, raw, sample: { fixture, hash: inputHash } }
}

test('incremental checks import failed historical attempts without relabeling or rerunning them', async () => {
  const setup = await diskFixture()
  try {
    const failed = {
      ...setup.row,
      catalogHash: digest(JSON.stringify(catalog)),
      status: 'inconclusive',
      observation: { ...setup.row.observation, status: 'inconclusive', exitCode: 1 },
    }
    const raw = JSON.stringify(failed)
    await writeFile(join(setup.seed, 'rows/one.json'), raw)
    await writeFile(join(setup.seed, 'catalog.json'), JSON.stringify(catalog))
    const result = await runReleaseCheck({
      root: setup.root,
      stateDirectory: setup.state,
      catalogPath: join(setup.root, 'catalog.json'),
      maxReleases: 0,
      incremental: true,
    })
    assert.equal(result.exitCode, 0)
    assert.equal(result.history?.recordedReleases, 1)
    assert.equal(result.managers[0].conclusivelyObservedCount, 0)
    const history = JSON.parse(await readFile(join(setup.state, 'history.json'), 'utf8'))
    assert.equal(history[0].outcomes[fixture.id], 'inconclusive')
    assert.equal(await readFile(join(setup.state, history[0].sources[0]), 'utf8'), raw)
    assert.match(await readFile(join(setup.state, 'history.md'), 'utf8'), /inconclusive/)
  } finally {
    await rm(setup.root, { recursive: true, force: true })
  }
})

test('incremental checks record new failures once, discover old-branch patches, and retry only explicitly', async () => {
  const setup = await diskFixture()
  try {
    const options = {
      root: setup.root,
      stateDirectory: setup.state,
      catalogPath: join(setup.root, 'catalog.json'),
      maxReleases: 1,
      incremental: true,
      seedDirectories: [],
    }
    const first = await runReleaseCheck(options)
    assert.equal(first.exitCode, 2, 'a new release without an executable is still a failure')
    const original = await readFile(join(setup.state, 'history.json'), 'utf8')
    const second = await runReleaseCheck(options)
    assert.equal(second.exitCode, 0, 'the recorded failure is historical on the next daily run')
    assert.equal(await readFile(join(setup.state, 'history.json'), 'utf8'), original)
    assert.equal((await runReleaseCheck({ ...options, retryFailed: true })).exitCode, 2)
    await writeFile(
      join(setup.root, 'catalog.json'),
      JSON.stringify({
        ...catalog,
        managers: { ...catalog.managers, npm: [release, { ...release, version: '9.9.9' }] },
      }),
    )
    assert.equal((await runReleaseCheck(options)).exitCode, 2, 'an added old-branch patch must run')
    assert.equal((await runReleaseCheck(options)).exitCode, 0)
    await writeFile(
      join(setup.root, 'catalog.json'),
      JSON.stringify({
        ...catalog,
        managers: { ...catalog.managers, npm: [{ ...release, integrity: 'replaced-artifact' }] },
      }),
    )
    assert.equal(
      (await runReleaseCheck(options)).exitCode,
      2,
      'changed artifact identity invalidates the saved attempt',
    )
  } finally {
    await rm(setup.root, { recursive: true, force: true })
  }
})

test('an exclusion invalidates a previously imported sole success and its completed state during production checks', async () => {
  const setup = await diskFixture()
  try {
    const options = {
      root: setup.root,
      stateDirectory: setup.state,
      catalogPath: join(setup.root, 'catalog.json'),
      maxReleases: 0,
    }
    assert.equal((await runReleaseCheck(options)).exitCode, 0)
    const previous = JSON.parse(await readFile(join(setup.state, 'state.json'), 'utf8')) as { completed: string[] }
    assert.equal(previous.completed.length, 1)
    await writeFile(
      join(setup.seed, 'exclusions.json'),
      JSON.stringify({
        schemaVersion: 1,
        entries: [
          {
            rowId: setup.row.id,
            observationId: setup.row.observation.id,
            rowSha256: digest(setup.raw),
            reason: 'Reviewed historical test accepted a command that ignored the frozen lock',
            reviewedAt: '2026-09-09T12:00:00Z',
          },
        ],
      }),
    )
    const report = await runReleaseCheck(options)
    assert.equal(report.exitCode, 2, JSON.stringify(report))
    assert.equal(report.managers[0].conclusivelyObservedCount, 0)
    assert.ok(report.incomplete.some((item) => item.includes('unprocessed')))
    const current = JSON.parse(await readFile(join(setup.state, 'state.json'), 'utf8')) as { completed: string[] }
    assert.deepEqual(current.completed, [])
    assert.equal(await readFile(join(setup.seed, 'rows/one.json'), 'utf8'), setup.raw)
    assert.equal(await readFile(join(setup.seed, 'logs/frozen.log'), 'utf8'), 'actual frozen command evidence\n')
  } finally {
    await rm(setup.root, { recursive: true, force: true })
  }
})

test('cold scheduled check imports initial facts across hosts and archives source rows and logs without mutation', async () => {
  const setup = await diskFixture()
  try {
    const report = await runReleaseCheck({
      root: setup.root,
      stateDirectory: setup.state,
      catalogPath: join(setup.root, 'catalog.json'),
      maxReleases: 0,
    })
    assert.equal(report.exitCode, 0)
    assert.equal(report.managers[0]?.conclusivelyObservedCount, 1)
    const saved = JSON.parse(await readFile(join(setup.state, 'state.json'), 'utf8'))
    assert.deepEqual(saved.completed, [portableReleaseKey('npm', release, [setup.sample])])
    const archived = await readdir(join(setup.state, 'seed-evidence/rows'))
    assert.equal(await readFile(join(setup.state, 'seed-evidence/rows', archived[0]), 'utf8'), setup.raw)
    const history = JSON.parse(await readFile(join(setup.state, 'observations.json'), 'utf8')) as Observation[]
    assert.equal(history[0]?.platform, 'other-host')
    assert.equal(await readFile(join(setup.state, history[0].logPath), 'utf8'), 'actual frozen command evidence\n')
    assert.equal(await readFile(join(setup.seed, 'rows/one.json'), 'utf8'), setup.raw)
    assert.equal(
      (
        await runReleaseCheck({
          root: setup.root,
          stateDirectory: setup.state,
          catalogPath: join(setup.root, 'catalog.json'),
          maxReleases: 0,
        })
      ).exitCode,
      0,
    )
  } finally {
    await rm(setup.root, { recursive: true, force: true })
  }
})

test('baseline cannot clear unresolved work or cover new versions and fixture bytes', async () => {
  const setup = await diskFixture()
  try {
    await writeFile(
      join(setup.state, 'state.json'),
      JSON.stringify({
        schemaVersion: 1,
        completed: [],
        unresolved: { 'npm@10.0.0:format': 'Previously discovered format remains unresolved' },
      }),
    )
    const pending = await runReleaseCheck({
      root: setup.root,
      stateDirectory: setup.state,
      catalogPath: join(setup.root, 'catalog.json'),
      maxReleases: 0,
    })
    assert.ok(pending.unresolved.includes('Previously discovered format remains unresolved'))
    assert.notEqual(pending.exitCode, 0)
    await writeFile(
      join(setup.root, 'catalog.json'),
      JSON.stringify({
        ...catalog,
        managers: { ...catalog.managers, npm: [release, { ...release, version: '10.0.1' }] },
      }),
    )
    const next = await runReleaseCheck({
      root: setup.root,
      stateDirectory: setup.state,
      catalogPath: join(setup.root, 'catalog.json'),
      maxReleases: 0,
    })
    assert.ok(next.managers[0]?.uncoveredVersions.includes('10.0.1'))
    await writeFile(join(setup.root, 'fixtures', fixture.directory, 'package.json'), '{"changed":true}')
    const changed = await runReleaseCheck({
      root: setup.root,
      stateDirectory: setup.state,
      catalogPath: join(setup.root, 'catalog.json'),
      maxReleases: 0,
    })
    assert.equal(changed.managers[0]?.conclusivelyObservedCount, 0)
  } finally {
    await rm(setup.root, { recursive: true, force: true })
  }
})

test('old seed protocol and missing reproduction logs never become reusable initial facts', async () => {
  const setup = await diskFixture()
  try {
    await writeFile(
      join(setup.seed, 'rows/one.json'),
      JSON.stringify({ ...setup.row, protocol: 'frozen-initial-matrix-v1' }),
    )
    const old = await importSeedMonitor({
      directories: [setup.seed],
      destination: setup.state,
      catalog,
      samples: [setup.sample],
    })
    assert.equal(old.observations.length, 0)
    assert.equal(old.superseded, 1)
    await writeFile(join(setup.seed, 'rows/one.json'), setup.raw)
    await rm(join(setup.seed, 'logs/frozen.log'))
    const missing = await importSeedMonitor({
      directories: [setup.seed],
      destination: setup.state,
      catalog,
      samples: [setup.sample],
    })
    assert.equal(missing.observations.length, 0)
    assert.equal(missing.incomplete.length, 1)
  } finally {
    await rm(setup.root, { recursive: true, force: true })
  }
})

test('portable asset mappings import foreign-host bootstrap and control evidence without changing raw rows', async () => {
  const setup = await diskFixture()
  try {
    const controlledFixture = { ...fixture, controlDependencies: { 'is-number': '6.0.0' } }
    const baseline = setup.row.observation
    const foreign = join(setup.root, 'departed-host/cache')
    const lock = '{"lockfileVersion":3,"packages":{}}\n'
    const manifest = '{"name":"published-tool","devDependencies":{"unused":"1.0.0"}}\n'
    const installation = '{"name":"published-tool"}\n'
    baseline.logPath = join(foreign, 'install.log')
    baseline.bootstrap = {
      protocol: 1,
      node: '24.10.0',
      npmVersion: '11.6.0',
      npmCliHash: 'bootstrap-npm',
      command: ['node', 'npm-cli.js', 'install', '--omit=dev', '--ignore-scripts'],
      lockfilePath: join(foreign, 'package-lock.json'),
      lockfileSha256: digest(lock),
      logPath: join(foreign, 'bootstrap.log'),
      installedTreeSha256: 'installed-tool-tree',
      manifestPreparation: {
        original: { content: manifest, sha256: digest(manifest) },
        installation: { content: installation, sha256: digest(installation) },
      },
    }
    const controlInputs = { ...baseline.inputHashes!, 'package.json': digest('contradictory manifest') }
    const controlHashes = { ...baseline.beforeHashes, 'package.json': controlInputs['package.json'] }
    baseline.frozenControl = {
      ...baseline,
      id: 'control-on-foreign-host',
      inputHashes: controlInputs,
      fixtureHash: digest(JSON.stringify(controlInputs)),
      beforeHashes: controlHashes,
      afterHashes: controlHashes,
      status: 'incompatible',
      exitCode: 1,
      requestedDependencies: controlledFixture.controlDependencies,
      logPath: join(foreign, 'control.log'),
      bootstrap: { ...baseline.bootstrap, logPath: join(foreign, 'control-bootstrap.log') },
    }
    const raw = JSON.stringify(setup.row)
    await writeFile(join(setup.seed, 'rows/one.json'), raw)
    const contents: Record<string, string> = {
      'install.log': 'successful frozen install',
      'control.log': 'explicit contradictory manifest rejection',
      'package-lock.json': lock,
      'bootstrap.log': 'original dependency preparation',
      'control-bootstrap.log': 'control dependency preparation',
    }
    await mkdir(join(setup.seed, 'assets'))
    const assets: Record<string, { path: string; sha256: string }> = {}
    for (const [name, content] of Object.entries(contents)) {
      assets[join(foreign, name)] = { path: `assets/${name}`, sha256: digest(content) }
      await writeFile(join(setup.seed, 'assets', name), content)
    }
    const mapping = JSON.stringify({ schemaVersion: 1, assets })
    await writeFile(join(setup.seed, 'portable-assets.json'), mapping)
    const options = {
      directories: [setup.seed],
      destination: setup.state,
      catalog,
      samples: [{ ...setup.sample, fixture: controlledFixture }],
    }
    const result = await importSeedMonitor(options)
    assert.deepEqual(result.incomplete, [])
    assert.equal(result.observations.length, 1)
    const archived = result.observations[0]
    assert.equal(await readFile(join(setup.state, archived.logPath), 'utf8'), contents['install.log'])
    assert.equal(await readFile(join(setup.state, archived.frozenControl!.logPath), 'utf8'), contents['control.log'])
    assert.equal(await readFile(join(setup.state, archived.bootstrap!.lockfilePath), 'utf8'), lock)
    assert.equal(await readFile(join(setup.state, archived.bootstrap!.logPath), 'utf8'), contents['bootstrap.log'])
    assert.equal(
      await readFile(join(setup.state, archived.frozenControl!.bootstrap!.logPath), 'utf8'),
      contents['control-bootstrap.log'],
    )
    assert.deepEqual(archived.bootstrap!.manifestPreparation, baseline.bootstrap.manifestPreparation)
    assert.equal(await readFile(join(setup.state, 'seed-evidence/rows', `${digest(raw)}.json`), 'utf8'), raw)
    assert.equal(await readFile(join(setup.seed, 'rows/one.json'), 'utf8'), raw)
    assert.equal(
      await readFile(join(setup.state, 'seed-evidence/portable-assets', `${digest(mapping)}.json`), 'utf8'),
      mapping,
    )

    for (const [name, content] of Object.entries(contents)) {
      await writeFile(join(setup.seed, 'assets', name), 'corrupted evidence')
      const corrupted = await importSeedMonitor(options)
      assert.equal(corrupted.observations.length, 0, name)
      assert.match(corrupted.incomplete.join('\n'), /Portable asset digest mismatch/, name)
      await writeFile(join(setup.seed, 'assets', name), content)
    }
    for (const path of ['../outside.log', join(setup.root, 'absolute.log')]) {
      const invalid = { ...assets, [baseline.logPath]: { path, sha256: digest(contents['install.log']) } }
      await writeFile(join(setup.seed, 'portable-assets.json'), JSON.stringify({ schemaVersion: 1, assets: invalid }))
      const escaped = await importSeedMonitor(options)
      assert.equal(escaped.observations.length, 0)
      assert.match(escaped.incomplete.join('\n'), /Portable asset path must stay inside its evidence directory/)
    }
  } finally {
    await rm(setup.root, { recursive: true, force: true })
  }
})

test('imported initial facts do not hide disagreement with a current confirmed rule', async () => {
  const setup = await diskFixture()
  try {
    await mkdir(join(setup.root, 'data'))
    await writeFile(
      join(setup.root, 'data/compatibility.json'),
      JSON.stringify({
        schemaVersion: 1,
        generatedAt: '2026-09-09',
        observations: [],
        rules: [
          {
            id: 'current-boundary',
            manager: 'npm',
            match: { file: fixture.lock, format: 3 },
            range: '<10.0.0',
          },
        ],
      }),
    )
    const report = await runReleaseCheck({
      root: setup.root,
      stateDirectory: setup.state,
      catalogPath: join(setup.root, 'catalog.json'),
      maxReleases: 0,
    })
    assert.notEqual(report.exitCode, 0)
    assert.ok(report.unresolved.some((message) => message.includes('current-boundary')))
  } finally {
    await rm(setup.root, { recursive: true, force: true })
  }
})

test('incremental migration preserves terminal legacy failures but retries interrupted attempts', async () => {
  const setup = await diskFixture()
  try {
    const options = {
      root: setup.root,
      stateDirectory: setup.state,
      catalogPath: join(setup.root, 'catalog.json'),
      maxReleases: 1,
      seedDirectories: [],
    }
    assert.equal((await runReleaseCheck(options)).exitCode, 2)
    const saved = JSON.parse(await readFile(join(setup.state, 'state.json'), 'utf8'))
    delete saved.history
    await writeFile(join(setup.state, 'state.json'), JSON.stringify(saved))
    const migrated = await runReleaseCheck({ ...options, incremental: true })
    assert.equal(migrated.exitCode, 0)
    assert.equal(migrated.history?.checkedThisRun, 0)
    const records = JSON.parse(await readFile(join(setup.state, 'history.json'), 'utf8'))
    assert.equal(records[0].exitCode, 2)
    assert.ok(records[0].sources.some((path: string) => path.startsWith('reports/')))
    delete saved.history
    saved.attempted[portableReleaseKey('npm', release, [setup.sample])] = '2999-01-01T00:00:00Z'
    await writeFile(join(setup.state, 'state.json'), JSON.stringify(saved))
    assert.equal((await runReleaseCheck({ ...options, incremental: true })).history?.checkedThisRun, 1)
  } finally {
    await rm(setup.root, { recursive: true, force: true })
  }
})

test('incremental scheduling treats changed URL as new despite conclusive facts with the same integrity', async () => {
  const setup = await diskFixture()
  try {
    await writeFile(join(setup.seed, 'catalog.json'), JSON.stringify(catalog))
    await writeFile(
      join(setup.seed, 'rows/one.json'),
      JSON.stringify({ ...setup.row, catalogHash: digest(JSON.stringify(catalog)) }),
    )
    const options = {
      root: setup.root,
      stateDirectory: setup.state,
      catalogPath: join(setup.root, 'catalog.json'),
      maxReleases: 0,
      incremental: true,
    }
    assert.equal((await runReleaseCheck(options)).exitCode, 0)
    await writeFile(
      options.catalogPath,
      JSON.stringify({
        ...catalog,
        managers: { ...catalog.managers, npm: [{ ...release, tarball: 'https://invalid.example/new-artifact.tgz' }] },
      }),
    )
    const changed = await runReleaseCheck(options)
    assert.equal(changed.exitCode, 2)
    assert.match(changed.incomplete.join(' '), /unprocessed/)
  } finally {
    await rm(setup.root, { recursive: true, force: true })
  }
})

test('migration cannot pair a terminal old report with a catalog overwritten by an interrupted run', async () => {
  const setup = await diskFixture()
  try {
    const options = {
      root: setup.root,
      stateDirectory: setup.state,
      catalogPath: join(setup.root, 'catalog.json'),
      maxReleases: 1,
      seedDirectories: [],
    }
    assert.equal((await runReleaseCheck(options)).exitCode, 2)
    const changed = {
      ...catalog,
      generatedAt: '2026-09-10',
      managers: { ...catalog.managers, npm: [{ ...release, tarball: 'https://invalid.example/new-artifact.tgz' }] },
    }
    await writeFile(options.catalogPath, JSON.stringify(changed))
    await writeFile(join(setup.state, 'catalog.json'), JSON.stringify(changed))
    const pending = await runReleaseCheck({ ...options, incremental: true, maxReleases: 0 })
    assert.equal(pending.exitCode, 2)
    assert.equal(pending.history?.recordedReleases, 0)
  } finally {
    await rm(setup.root, { recursive: true, force: true })
  }
})
