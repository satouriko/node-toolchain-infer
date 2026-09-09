import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep, win32 } from 'node:path'

import { isStableVersion } from '../src/versions.js'

import { EvidenceExclusions, exclusionArchivePath } from './evidence-exclusions.js'
import { frozenControlError } from './frozen-control.js'
import { compatibilityOutcome, type KnownBugReview, reviewedBug } from './known-bugs.js'
import { digest, type Fixture, FROZEN_LOCKFILES, FROZEN_PROTOCOL, type Observation, SEED_PROTOCOL } from './model.js'
import { frozenArgs } from './runner.js'

import type { SeedRow } from '../scripts/seed-data.js'
import type { Catalog, Manager, ManagerRelease } from '../src/types.js'
import type { Buffer } from 'node:buffer'

// Reuse historical facts across CI hosts without claiming they were measured on the current host.
// Only v2 seed/observation protocols qualify; original rows and logs are archived immutably.
export interface MonitorSample {
  fixture: Fixture
  hash: string
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    )
  return value
}
const stable = (value: unknown): string => JSON.stringify(canonical(value))
export function monitorFactKey(manager: Manager, release: ManagerRelease, sample: MonitorSample): string {
  return `${manager}@${release.version}:${digest(stable({ protocol: FROZEN_PROTOCOL, integrity: release.integrity, fixtureId: sample.fixture.id, hash: sample.hash, lock: sample.fixture.lock, match: sample.fixture.match, dependencies: sample.fixture.dependencies }))}`
}
export function portableReleaseKey(manager: Manager, release: ManagerRelease, samples: MonitorSample[]): string {
  return `${manager}@${release.version}:${digest(
    JSON.stringify(
      samples
        .filter((sample) => sample.fixture.manager === manager)
        .map((sample) => monitorFactKey(manager, release, sample))
        .sort(),
    ),
  )}`
}
function validFact(
  observation: Observation,
  release: ManagerRelease,
  sample: MonitorSample,
  knownBugs: KnownBugReview[] = [],
): boolean {
  const { fixture, hash } = sample
  const bug = reviewedBug(observation, knownBugs)
  if (
    observation.protocol !== FROZEN_PROTOCOL
    || !observation.inputHashes
    || (!bug && !['pass', 'incompatible', 'rewrite', 'semantic-mismatch'].includes(observation.status))
  )
    return false
  if (
    observation.fixtureId !== fixture.id
    || observation.fixtureHash !== hash
    || observation.manager !== fixture.manager
    || observation.version !== release.version
    || observation.actualVersion !== release.version
    || !release.integrity
    || observation.toolIntegrity !== release.integrity
  )
    return false
  if (
    !observation.node
    || !observation.nodeIntegrity
    || !observation.platform
    || !observation.arch
    || !observation.logPath
  )
    return false
  const inputs = observation.inputHashes
  if (
    !inputs['package.json']
    || !inputs[fixture.lock]
    || Object.values(inputs).includes('<missing>')
    || digest(JSON.stringify(inputs)) !== hash
  )
    return false
  const watched = [...new Set([...Object.keys(inputs), ...FROZEN_LOCKFILES])].sort()
  if (
    stable(Object.keys(observation.beforeHashes).sort()) !== stable(watched)
    || stable(Object.keys(observation.afterHashes).sort()) !== stable(watched)
  )
    return false
  if (watched.some((file) => observation.beforeHashes[file] !== (inputs[file] ?? '<missing>'))) return false
  if (stable(observation.command) !== stable(frozenArgs(fixture.manager, release.version))) return false
  if (bug) return true
  const unchanged = stable(observation.beforeHashes) === stable(observation.afterHashes)
  const installed = Object.entries(fixture.dependencies).every(
    ([name, version]) => observation.installed[name] === version,
  )
  if (frozenControlError(fixture, observation)) return false
  if (observation.status === 'pass') return observation.exitCode === 0 && unchanged && installed && observation.semantic
  if (observation.status === 'rewrite') return observation.exitCode === 0 && !unchanged
  if (observation.status === 'semantic-mismatch' && fixture.manager === 'yarn' && !observation.semanticMethod)
    return false
  if (observation.status === 'semantic-mismatch')
    return observation.exitCode === 0 && unchanged && !installed && !observation.semantic
  return observation.exitCode !== null && observation.exitCode !== 0
}
export function monitorFacts(
  catalog: Catalog,
  samples: MonitorSample[],
  observations: Observation[],
  knownBugs: KnownBugReview[] = [],
): { covered: Set<string>; observations: Observation[]; conflicts: string[] } {
  const groups = new Map<string, Observation[]>()
  const fixtures = new Map(samples.map((sample) => [sample.fixture.id, sample]))
  const releases = new Map(
    (['npm', 'pnpm', 'yarn'] as const).flatMap((manager) =>
      catalog.managers[manager]
        .filter((release) => isStableVersion(release.version))
        .map((release) => [`${manager}@${release.version}`, release] as const),
    ),
  )
  for (const observation of observations) {
    const sample = fixtures.get(observation.fixtureId)
    const release = releases.get(`${observation.manager}@${observation.version}`)
    if (!sample || !release || !validFact(observation, release, sample, knownBugs)) continue
    const key = monitorFactKey(observation.manager, release, sample)
    groups.set(key, [...(groups.get(key) ?? []), observation])
  }
  const covered = new Set<string>()
  const accepted: Observation[] = []
  const conflicts: string[] = []
  for (const [key, points] of groups) {
    accepted.push(...points)
    if (new Set(points.map((point) => compatibilityOutcome(point, knownBugs))).size > 1)
      conflicts.push(`${key}: conflicting initial observations ${points.map((point) => point.id).join(', ')}`)
    else covered.add(key)
  }
  return { covered, observations: accepted, conflicts }
}
export interface SeedMonitorOptions {
  directories: string[]
  destination: string
  catalog: Catalog
  samples: MonitorSample[]
  knownBugs?: KnownBugReview[]
}
async function immutable(path: string, bytes: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  try {
    await writeFile(path, bytes, { flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const existing = await readFile(path)
    if (digest(existing) !== digest(bytes))
      throw new Error(`Refusing to overwrite differing archived evidence: ${path}`, { cause: error })
  }
}
interface PortableAssetReader {
  manifest?: Buffer
  read: (sourcePath: string) => Promise<Buffer>
}
async function portableAssetReader(directory: string): Promise<PortableAssetReader> {
  let manifest: Buffer
  try {
    manifest = await readFile(join(directory, 'portable-assets.json'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { read: (sourcePath) => readFile(resolve(directory, sourcePath)) }
    throw error
  }
  const document = JSON.parse(manifest.toString()) as { schemaVersion?: unknown; assets?: unknown } | null
  if (
    !document
    || document.schemaVersion !== 1
    || !document.assets
    || typeof document.assets !== 'object'
    || Array.isArray(document.assets)
  )
    throw new Error('Invalid portable assets manifest')
  const root = resolve(directory)
  const entries = new Map<string, { path: string; sha256: string }>()
  for (const [sourcePath, value] of Object.entries(document.assets)) {
    const entry = value as { path?: unknown; sha256?: unknown } | null
    if (
      !sourcePath
      || !entry
      || typeof entry.path !== 'string'
      || !entry.path
      || typeof entry.sha256 !== 'string'
      || !/^[a-f\d]{64}$/.test(entry.sha256)
    )
      throw new Error(`Invalid portable asset entry: ${sourcePath}`)
    const path = resolve(root, entry.path)
    if (isAbsolute(entry.path) || win32.isAbsolute(entry.path) || !path.startsWith(`${root}${sep}`))
      throw new Error(`Portable asset path must stay inside its evidence directory: ${sourcePath}`)
    entries.set(sourcePath, { path, sha256: entry.sha256 })
  }
  return {
    manifest,
    async read(sourcePath) {
      const entry = entries.get(sourcePath)
      if (!entry) return readFile(resolve(directory, sourcePath))
      const bytes = await readFile(entry.path)
      if (digest(bytes) !== entry.sha256) throw new Error(`Portable asset digest mismatch: ${sourcePath}`)
      return bytes
    },
  }
}
export async function importSeedMonitor(options: SeedMonitorOptions): Promise<{
  observations: Observation[]
  incomplete: string[]
  superseded: number
  excludedObservationIds: string[]
}> {
  const observations: Observation[] = []
  const incomplete: string[] = []
  let superseded = 0
  const excludedObservationIds = new Set<string>()
  const samples = new Map(options.samples.map((sample) => [sample.fixture.id, sample]))
  const releases = new Map(
    (['npm', 'pnpm', 'yarn'] as const).flatMap((manager) =>
      options.catalog.managers[manager]
        .filter((release) => isStableVersion(release.version))
        .map((release) => [`${manager}@${release.version}`, release] as const),
    ),
  )
  const archivedExclusions: string[] = []
  try {
    for (const entry of await readdir(join(options.destination, 'seed-evidence/exclusions'), { withFileTypes: true }))
      if (entry.isDirectory())
        archivedExclusions.push(join(options.destination, 'seed-evidence/exclusions', entry.name))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  for (const directory of [...archivedExclusions, ...options.directories]) {
    let reviewed: EvidenceExclusions
    try {
      reviewed = await EvidenceExclusions.load(directory)
    } catch (error) {
      incomplete.push(`Evidence exclusions ${directory}: ${String(error)}`)
      continue
    }
    let assets: PortableAssetReader
    try {
      assets = await portableAssetReader(directory)
    } catch (error) {
      incomplete.push(`Portable evidence assets ${directory}: ${String(error)}`)
      continue
    }
    const excludedRows: Array<{ hash: string; bytes: Buffer }> = []
    let names: string[]
    try {
      names = await readdir(join(directory, 'rows'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        try {
          reviewed.finish()
        } catch (problem) {
          incomplete.push(String(problem))
        }
        continue
      }
      throw error
    }
    for (const name of names.filter((filename) => filename.endsWith('.json')).sort()) {
      const source = join(directory, 'rows', name)
      try {
        const bytes = await readFile(source)
        const raw = bytes.toString()
        const row = JSON.parse(raw) as SeedRow
        const excluded = reviewed.check(row, bytes, source)
        if (excluded) {
          excludedRows.push({ hash: excluded.rowSha256, bytes })
          continue
        }
        if (archivedExclusions.includes(directory) || !isStableVersion(row.version)) continue
        if (row.protocol !== SEED_PROTOCOL || (row.observation && row.observation.protocol !== FROZEN_PROTOCOL)) {
          superseded++
          continue
        }
        const original = row.observation
        if (
          !original
          || row.status !== original.status
          || row.manager !== original.manager
          || row.version !== original.version
          || row.fixtureId !== original.fixtureId
          || row.fixtureHash !== original.fixtureHash
        )
          continue
        const sample = samples.get(original.fixtureId)
        const release = releases.get(`${original.manager}@${original.version}`)
        if (!sample || !release || !validFact(original, release, sample, options.knownBugs)) continue
        const log = await assets.read(original.logPath)
        const logPath = `seed-evidence/logs/${digest(log)}.log`
        await immutable(join(options.destination, logPath), log)
        const rowPath = `seed-evidence/rows/${digest(raw)}.json`
        await immutable(join(options.destination, rowPath), raw)
        const portableAssetsPath = assets.manifest
          ? `seed-evidence/portable-assets/${digest(assets.manifest)}.json`
          : undefined
        if (portableAssetsPath) await immutable(join(options.destination, portableAssetsPath), assets.manifest!)
        const observation: Observation = { ...original, logPath }
        if (original.frozenControl) {
          const controlLog = await assets.read(original.frozenControl.logPath)
          const controlLogPath = `seed-evidence/logs/${digest(controlLog)}.log`
          await immutable(join(options.destination, controlLogPath), controlLog)
          observation.frozenControl = { ...original.frozenControl, logPath: controlLogPath }
        }
        if (original.bootstrap) {
          const lock = await assets.read(original.bootstrap.lockfilePath)
          if (digest(lock) !== original.bootstrap.lockfileSha256)
            throw new Error('Bootstrap dependency lock digest mismatch')
          const bootstrapLog = await assets.read(original.bootstrap.logPath)
          const prefix = `seed-evidence/bootstrap/${original.bootstrap.lockfileSha256}`
          const bootstrapLogPath = `${prefix}/${digest(bootstrapLog)}.log`
          await immutable(join(options.destination, prefix, 'package-lock.json'), lock)
          await immutable(join(options.destination, bootstrapLogPath), bootstrapLog)
          observation.bootstrap = {
            ...original.bootstrap,
            lockfilePath: `${prefix}/package-lock.json`,
            logPath: bootstrapLogPath,
          }
          if (original.frozenControl?.bootstrap && observation.frozenControl) {
            const controlBootstrap = original.frozenControl.bootstrap
            if (digest(await assets.read(controlBootstrap.lockfilePath)) !== controlBootstrap.lockfileSha256)
              throw new Error('Frozen control bootstrap dependency lock digest mismatch')
            const controlBootstrapLog = await assets.read(controlBootstrap.logPath)
            const controlBootstrapLogPath = `${prefix}/${digest(controlBootstrapLog)}.log`
            await immutable(join(options.destination, controlBootstrapLogPath), controlBootstrapLog)
            observation.frozenControl.bootstrap = {
              ...controlBootstrap,
              lockfilePath: `${prefix}/package-lock.json`,
              logPath: controlBootstrapLogPath,
            }
          }
        }
        const receipt = {
          source: resolve(source),
          rowId: row.id,
          observationId: original.id,
          rowPath,
          logPath,
          portableAssetsPath,
          bootstrap: observation.bootstrap,
          frozenControl: observation.frozenControl
            ? { id: observation.frozenControl.id, logPath: observation.frozenControl.logPath }
            : undefined,
        }
        await immutable(
          join(options.destination, 'seed-evidence/links', `${digest(stable(receipt))}.json`),
          `${JSON.stringify(receipt, null, 2)}\n`,
        )
        observations.push(observation)
      } catch (error) {
        incomplete.push(`Seed baseline ${source}: ${String(error)}`)
      }
    }
    try {
      const exclusions = reviewed.finish()
      for (const exclusion of exclusions)
        if (exclusion.observationId) excludedObservationIds.add(exclusion.observationId)
      if (reviewed.raw) {
        const archive = exclusionArchivePath(options.destination, reviewed.raw)
        await immutable(join(archive, 'exclusions.json'), reviewed.raw)
        for (const row of excludedRows) await immutable(join(archive, 'rows', `${row.hash}.json`), row.bytes)
        const receipt = { source: reviewed.source, exclusions }
        await immutable(
          join(archive, 'sources', `${digest(reviewed.source)}.json`),
          `${JSON.stringify(receipt, null, 2)}\n`,
        )
      }
    } catch (error) {
      incomplete.push(`Evidence exclusions ${directory}: ${String(error)}`)
    }
  }
  return {
    observations: observations.filter((observation) => !excludedObservationIds.has(observation.id)),
    incomplete,
    superseded,
    excludedObservationIds: [...excludedObservationIds].sort(),
  }
}
