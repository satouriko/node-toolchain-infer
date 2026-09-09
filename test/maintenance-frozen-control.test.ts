import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import test from 'node:test'

import { compileInitial } from '../maintenance/compile-initial.js'
import {
  digest,
  type Fixture,
  FROZEN_LOCKFILES,
  FROZEN_PROTOCOL,
  type Observation,
  SEED_PROTOCOL,
} from '../maintenance/model.js'
import { reusableObservation } from '../maintenance/run-matrix.js'
import { fixtureFiles, frozenArgs, hashes } from '../maintenance/runner.js'
import { importSeedMonitor, monitorFacts } from '../maintenance/seed-monitor.js'

import { makeObservation } from './maintenance-fixture.js'

import type { Tool } from '../maintenance/provision.js'
import type { SeedRow } from '../scripts/seed-data.js'
import type { Catalog } from '../src/types.js'

const fixture: Fixture = {
  id: 'controlled-npm',
  manager: 'npm',
  version: '1.1.0',
  directory: 'npm',
  lock: 'package-lock.json',
  match: { format: 3 },
  dependencies: { 'is-number': '7.0.0' },
  controlDependencies: { 'is-number': '6.0.0' },
}
const catalog: Catalog = {
  schemaVersion: 1,
  generatedAt: '2026-09-09T00:00:00Z',
  sources: [],
  warnings: [],
  nodes: [{ version: '18.20.8' }],
  managers: {
    npm: ['1.0.0', '1.1.0'].map((version) => ({ version, node: '>=18', integrity: `tool-${version}` })),
    pnpm: [],
    yarn: [],
  },
}
const inputs = { 'package-lock.json': 'lock-seven', 'package.json': 'manifest-seven', '.npmrc': 'configuration' }
const watch = (input: Record<string, string>) => ({
  ...Object.fromEntries(FROZEN_LOCKFILES.map((name) => [name, '<missing>'])),
  ...input,
})
const hash = digest(JSON.stringify(inputs))
function sample(version: string, status: 'pass' | 'incompatible'): Observation {
  return makeObservation({
    id: version,
    key: version,
    version,
    actualVersion: version,
    fixtureId: fixture.id,
    fixtureHash: hash,
    nodeArch: 'x64',
    inputHashes: inputs,
    beforeHashes: watch(inputs),
    afterHashes: watch(inputs),
    toolIntegrity: `tool-${version}`,
    status,
    exitCode: status === 'pass' ? 0 : 1,
    command: frozenArgs('npm', version),
    installed: fixture.dependencies,
  })
}
function controlled(): Observation {
  const baseline = sample('1.1.0', 'pass')
  const controlInputs = { ...inputs, 'package.json': 'manifest-six' }
  baseline.frozenControl = {
    ...baseline,
    id: 'counterexample',
    key: 'counterexample',
    fixtureHash: digest(JSON.stringify(controlInputs)),
    inputHashes: controlInputs,
    beforeHashes: watch(controlInputs),
    afterHashes: watch(controlInputs),
    status: 'incompatible',
    exitCode: 1,
    logPath: 'control.log',
    requestedDependencies: { ...fixture.dependencies, ...fixture.controlDependencies },
  }
  return baseline
}

test('a control that keeps the original locked versions also proves lock enforcement', () => {
  const baseline = controlled()
  Object.assign(baseline.frozenControl!, {
    status: 'semantic-mismatch',
    exitCode: 0,
    semantic: false,
    installed: fixture.dependencies,
  })
  assert.equal(monitorFacts(catalog, [{ fixture, hash }], [baseline]).covered.size, 1)
  baseline.frozenControl!.installed = { 'is-number': '6.0.0' }
  assert.equal(monitorFacts(catalog, [{ fixture, hash }], [baseline]).covered.size, 0)
})
function row(observation: Observation): SeedRow {
  return {
    id: observation.id,
    key: observation.key,
    protocol: SEED_PROTOCOL,
    catalogHash: digest(JSON.stringify(catalog)),
    manager: 'npm',
    version: observation.version,
    fixtureId: fixture.id,
    fixtureHash: hash,
    createdAt: '2026-09-09T00:00:00Z',
    attempt: 1,
    status: observation.status,
    observation,
  }
}
function compile(observation: Observation) {
  return compileInitial({
    catalog,
    fixtures: [fixture],
    fixtureHashes: { [fixture.id]: hash },
    rows: [row(sample('1.0.0', 'incompatible')), row(observation)],
  })
}
test('measured frozen rejection of changed manifest is required for pass evidence in compiler and monitor', () => {
  const valid = controlled()
  assert.equal(compile(valid).data.rules[0].range, '>=1.1.0')
  assert.equal(monitorFacts(catalog, [{ fixture, hash }], [valid]).covered.size, 1)
  const old = sample('1.1.0', 'pass')
  assert.equal(compile(old).data.rules.length, 0)
  assert.equal(monitorFacts(catalog, [{ fixture, hash }], [old]).covered.size, 0)
  assert.equal(
    monitorFacts(catalog, [{ fixture, hash }], [sample('1.0.0', 'incompatible')]).covered.size,
    1,
    'historical negative outcomes do not need a pass control',
  )
})
test('runtime, command, input and failed-control identities cannot be substituted in a pass receipt', () => {
  const changes: Array<Partial<Observation>> = [
    { requestedDependencies: undefined },
    { requestedDependencies: { 'is-number': '5.0.0' } },
    { requestedDependencies: { 'is-number': '6.0.0', extra: '1.0.0' } },
    { version: '1.0.0' },
    { actualVersion: '1.0.0' },
    { manager: 'pnpm' },
    { toolIntegrity: 'other-tool' },
    { node: '20.0.0' },
    { nodeIntegrity: 'other-node' },
    { nodeArch: 'arm64' },
    { platform: 'darwin' },
    { arch: 'arm64' },
    { environment: { npm_config_auto_install_peers: 'false' } },
    { command: ['install'] },
    { protocol: 'old' },
    { status: 'inconclusive' },
    { exitCode: 0 },
    { exitCode: null },
    { logPath: '' },
    { inputHashes: inputs },
    { inputHashes: { ...inputs, 'package.json': 'manifest-six', 'package-lock.json': 'changed-lock' } },
    { inputHashes: { ...inputs, 'package.json': 'manifest-six', '.npmrc': 'different-config' } },
    { fixtureHash: 'wrong-control-digest' },
    { beforeHashes: watch(inputs) },
    { beforeHashes: undefined },
  ]
  for (const change of changes) {
    const candidate = controlled()
    Object.assign(candidate.frozenControl!, change)
    assert.equal(compile(candidate).data.rules.length, 0, JSON.stringify(change))
    assert.equal(monitorFacts(catalog, [{ fixture, hash }], [candidate]).covered.size, 0, JSON.stringify(change))
  }
  assert.equal(controlled().frozenControl?.protocol, FROZEN_PROTOCOL)
})

test('imported pass evidence archives the control command log and cannot survive a missing control log', async () => {
  const root = await mkdtemp(join(tmpdir(), 'frozen-control-import-'))
  try {
    const seed = join(root, 'seed')
    const destination = join(root, 'state')
    await mkdir(join(seed, 'rows'), { recursive: true })
    const baseline = controlled()
    const lock = '{"resolved":"exact-production-graph"}'
    await mkdir(join(seed, 'bootstrap'))
    await writeFile(join(seed, 'bootstrap/lock.json'), lock)
    await writeFile(join(seed, 'bootstrap/install.log'), 'original dependency bootstrap')
    baseline.bootstrap = {
      protocol: 1,
      node: '18.20.8',
      npmVersion: '10.0.0',
      npmCliHash: 'npm-cli',
      command: ['install'],
      lockfilePath: 'bootstrap/lock.json',
      lockfileSha256: digest(lock),
      logPath: 'bootstrap/install.log',
    }
    baseline.frozenControl!.bootstrap = baseline.bootstrap
    await writeFile(join(seed, 'rows/pass.json'), JSON.stringify(row(baseline)))
    await writeFile(join(seed, baseline.logPath), 'baseline frozen install')
    await writeFile(join(seed, baseline.frozenControl!.logPath), 'explicit frozen lock rejection')
    const options = { directories: [seed], destination, catalog, samples: [{ fixture, hash }] }
    const result = await importSeedMonitor(options)
    assert.deepEqual(result.incomplete, [])
    assert.equal(result.observations.length, 1)
    const archived = result.observations[0].frozenControl!
    assert.equal(
      await readFile(join(destination, archived.bootstrap!.logPath), 'utf8'),
      'original dependency bootstrap',
    )
    assert.equal(await readFile(join(destination, archived.bootstrap!.lockfilePath), 'utf8'), lock)
    assert.equal(await readFile(join(destination, archived.logPath), 'utf8'), 'explicit frozen lock rejection')
    await rm(join(seed, baseline.frozenControl!.logPath))
    const missing = await importSeedMonitor({ ...options, destination: join(root, 'without-log') })
    assert.equal(missing.observations.length, 0)
    assert.ok(missing.incomplete.length)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('local matrix reuse cannot bypass a newly required frozen control', async () => {
  const root = await mkdtemp(join(tmpdir(), 'local-control-reuse-'))
  try {
    const source = join(root, fixture.directory)
    await mkdir(source, { recursive: true })
    await writeFile(join(source, 'package.json'), '{}')
    await writeFile(join(source, fixture.lock), '{}')
    const original = sample('1.1.0', 'pass')
    original.fixtureHash = digest(JSON.stringify(await hashes(source, await fixtureFiles(source))))
    original.platform = process.platform
    original.arch = process.arch
    original.nodeArch = process.arch
    const tool: Tool = {
      version: original.version,
      node: process.execPath,
      nodeVersion: original.node,
      nodeIntegrity: original.nodeIntegrity,
      nodeArch: process.arch,
      cli: '/unused',
      integrity: original.toolIntegrity,
      url: original.toolUrl,
    }
    assert.equal(
      await reusableObservation({ ...fixture, controlDependencies: undefined }, tool, root, [original]),
      original,
    )
    assert.equal(await reusableObservation(fixture, tool, root, [original]), undefined)
    const rejected = { ...original, status: 'incompatible' as const, exitCode: 1 }
    assert.equal(await reusableObservation(fixture, tool, root, [rejected]), rejected)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
