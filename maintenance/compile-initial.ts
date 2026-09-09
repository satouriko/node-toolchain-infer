import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import semver from 'semver'

import { isStableVersion } from '../src/versions.js'

import { compileRanges } from './compile-ranges.js'
import { EvidenceExclusions, type ExclusionAudit } from './evidence-exclusions.js'
import { frozenControlError } from './frozen-control.js'
import {
  bugSummary,
  type KnownBugReview,
  loadKnownBugs,
  reviewedBug,
  stableBugRange,
  validateKnownBugs,
} from './known-bugs.js'
import { digest, type Fixture, FROZEN_LOCKFILES, FROZEN_PROTOCOL, type Observation, SEED_PROTOCOL } from './model.js'
import { fixtureFiles, frozenArgs, hashes } from './runner.js'

import type { SeedRow } from '../scripts/seed-data.js'
import type { Catalog, CompatibilityData, CompatibilityRule } from '../src/types.js'

export interface InitialOptions {
  catalog: Catalog
  evidenceCatalogs?: Catalog[]
  fixtures: Fixture[]
  fixtureHashes: Record<string, string>
  rows: SeedRow[]
  knownBugs?: KnownBugReview[]
  generatedAt?: string
}
export interface InitialIssue {
  code: string
  versions: string[]
  evidenceIds: string[]
  detail: string
}
export interface InitialPoint {
  version: string
  prerelease: boolean
  outcome: 'supported' | 'unsupported' | 'unknown'
  evidenceIds: string[]
  rowIds: string[]
  exceptions?: Array<{ bugId: string; observationId: string; status: Observation['status'] }>
}
export interface InitialBoundary {
  before: string
  after: string
  direction: 'lower' | 'upper'
  evidenceIds: string[]
}
export interface InitialFixtureReport {
  fixtureId: string
  fixtureHash: string
  match: CompatibilityRule['match']
  range: string | null
  points: InitialPoint[]
  boundaries: InitialBoundary[]
  issues: InitialIssue[]
}
export interface RetestEnvironment {
  node: string
  nodeArch: string
  nodeIntegrity: string
  platform: string
  arch: string
  protocol: string
  evidenceId: string
  environment?: Record<string, string>
}
export interface InitialRetest {
  fixtureId: string
  beforeVersion: string
  afterVersion: string
  reason: string
  existingBefore: RetestEnvironment[]
  existingAfter: RetestEnvironment[]
  nodeCandidates: string[]
  nodeCandidateNote: string
}
export interface InitialReport {
  catalogHash: string
  evidenceCatalogHashes?: string[]
  exclusions?: ExclusionAudit[]
  knownBugs?: KnownBugReview[]
  fixtures: InitialFixtureReport[]
  issues: InitialIssue[]
  retests: InitialRetest[]
  exitCode: 0 | 1 | 2
}
interface ValidSample {
  row: SeedRow
  observation: Observation
  outcome: 'supported' | 'unsupported'
  knownBug?: string
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
const sorted = (value: unknown): string => JSON.stringify(canonical(value))
function matchKey(fixture: Fixture): string {
  // Match feature key ordering must not create separate rules for the same feature set.
  return sorted({ manager: fixture.manager, match: { ...fixture.match, file: fixture.lock } })
}
function issue(code: string, detail: string, versions: string[] = [], evidenceIds: string[] = []): InitialIssue {
  return { code, detail, versions, evidenceIds }
}
function verify(
  row: SeedRow,
  fixture: Fixture,
  fixtureHash: string,
  catalog: Catalog,
  evidenceCatalogs: Map<string, Catalog>,
  knownBugs: KnownBugReview[] = [],
): ValidSample | string {
  const { observation } = row
  const bug = observation && reviewedBug(observation, knownBugs)
  if (!['pass', 'rewrite', 'semantic-mismatch', 'incompatible', 'inconclusive'].includes(row.status))
    return 'Unknown observation outcome'
  const originalCatalog = evidenceCatalogs.get(row.catalogHash)
  if (!originalCatalog) return 'Record belongs to a catalog snapshot that was not supplied with its evidence'
  if (!observation || (row.status === 'inconclusive' && !bug))
    return 'Attempt is inconclusive or has no executed observation'
  if (row.fixtureHash !== fixtureHash || observation.fixtureHash !== fixtureHash)
    return 'Fixture hash differs from the selected current bytes'
  if (
    row.fixtureId !== fixture.id
    || observation.fixtureId !== fixture.id
    || row.manager !== fixture.manager
    || observation.manager !== fixture.manager
    || row.version !== observation.version
    || observation.actualVersion !== row.version
    || observation.status !== row.status
  )
    return 'Row and observation identities disagree'
  const release = catalog.managers[fixture.manager].find((item) => item.version === row.version)
  const originalRelease = originalCatalog.managers[fixture.manager].find((item) => item.version === row.version)
  if (
    !originalRelease?.integrity
    || originalRelease.integrity !== release?.integrity
    || originalRelease.tarball !== release.tarball
    || sorted(originalRelease.bundle) !== sorted(release.bundle)
  )
    return 'Original and selected catalogs do not identify the same released artifact'
  if (release.integrity !== observation.toolIntegrity)
    return 'Tool integrity does not match the frozen official catalog'
  if (
    !observation.nodeIntegrity
    || !observation.node
    || !observation.platform
    || !observation.arch
    || !observation.logPath
    || !row.protocol
  )
    return 'Missing runtime, protocol or reproduction evidence'
  if (JSON.stringify(observation.command) !== JSON.stringify(frozenArgs(fixture.manager, row.version)))
    return 'Observation did not execute the required frozen command'
  const inputs = observation.inputHashes
  if (
    !inputs
    || !inputs['package.json']
    || !inputs[fixture.lock]
    || Object.values(inputs).includes('<missing>')
    || digest(JSON.stringify(inputs)) !== fixtureHash
  )
    return 'Input hashes do not identify the selected manifest and lock bytes'
  const watched = [...new Set([...Object.keys(inputs), ...FROZEN_LOCKFILES])].sort()
  if (
    sorted(Object.keys(observation.beforeHashes).sort()) !== sorted(watched)
    || sorted(Object.keys(observation.afterHashes).sort()) !== sorted(watched)
    || watched.some((file) => observation.beforeHashes[file] !== (inputs[file] ?? '<missing>'))
  )
    return 'Frozen observation does not cover original inputs and every root lock candidate'
  if (bug) return { row, observation, outcome: 'supported', knownBug: bug.id }
  const unchanged = sorted(observation.beforeHashes) === sorted(observation.afterHashes)
  const installed = Object.entries(fixture.dependencies).every(
    ([name, version]) => observation.installed[name] === version,
  )
  const controlError = frozenControlError(fixture, observation)
  if (controlError) return controlError
  if (observation.status === 'pass')
    return observation.exitCode === 0 && unchanged && installed && observation.semantic
      ? { row, observation, outcome: 'supported' }
      : 'Pass does not satisfy exit, byte and installed dependency checks'
  if (observation.status === 'rewrite')
    return observation.exitCode === 0 && !unchanged
      ? { row, observation, outcome: 'unsupported' }
      : 'Rewrite lacks a successful command with changed bytes'
  if (observation.status === 'semantic-mismatch' && fixture.manager === 'yarn' && !observation.semanticMethod)
    return 'Historical Yarn dependency verification did not account for PnP; retest with the current verifier'
  if (observation.status === 'semantic-mismatch')
    return observation.exitCode === 0 && unchanged && !installed && !observation.semantic
      ? { row, observation, outcome: 'unsupported' }
      : 'Semantic mismatch lacks verified missing or incorrect dependencies'
  return observation.exitCode !== null && observation.exitCode !== 0
    ? { row, observation, outcome: 'unsupported' }
    : 'Incompatibility lacks a completed rejected command'
}
function comparable(before: ValidSample, after: ValidSample): boolean {
  const a = before.observation
  const b = after.observation
  return (
    before.row.protocol === after.row.protocol
    && a.fixtureHash === b.fixtureHash
    && a.node === b.node
    && a.nodeIntegrity === b.nodeIntegrity
    && a.platform === b.platform
    && a.arch === b.arch
    && (a.nodeArch ?? a.arch) === (b.nodeArch ?? b.arch)
    && sorted(a.environment ?? {}) === sorted(b.environment ?? {})
  )
}
function compileFixture(
  options: InitialOptions,
  fixture: Fixture,
  evidenceCatalogs: Map<string, Catalog>,
): InitialFixtureReport {
  const fixtureHash = options.fixtureHashes[fixture.id] ?? ''
  const report: InitialFixtureReport = {
    fixtureId: fixture.id,
    fixtureHash,
    match: { ...fixture.match, file: fixture.lock },
    range: null,
    points: [],
    boundaries: [],
    issues: [],
  }
  const releases = [
    ...new Set(
      options.catalog.managers[fixture.manager]
        .filter((item) => isStableVersion(item.version))
        .map((item) => item.version),
    ),
  ].sort(semver.compare)
  const candidates = new Map<string, ValidSample[]>()
  const indexed = new Map<string, SeedRow[]>()
  for (const row of options.rows)
    if (row.fixtureId === fixture.id && row.manager === fixture.manager)
      indexed.set(row.version, [...(indexed.get(row.version) ?? []), row])
  for (const version of releases) {
    const rows = indexed.get(version) ?? []
    const samples: ValidSample[] = []
    const firstIssue = report.issues.length
    for (const row of rows) {
      if (row.protocol !== SEED_PROTOCOL || (row.observation && row.observation.protocol !== FROZEN_PROTOCOL)) {
        report.issues.push(
          issue(
            'superseded',
            'Old experiment protocol retained for history; it cannot prove the current frozen-install contract',
            [version],
            row.observation ? [row.observation.id] : [],
          ),
        )
        continue
      }
      const result = verify(row, fixture, fixtureHash, options.catalog, evidenceCatalogs, options.knownBugs)
      if (typeof result === 'string')
        report.issues.push(
          issue(
            row.status === 'inconclusive' ? 'inconclusive' : 'invalid-evidence',
            result,
            [version],
            row.observation ? [row.observation.id] : [],
          ),
        )
      else samples.push(result)
    }
    if (samples.length) {
      for (const previousIssue of report.issues.slice(firstIssue)) {
        if (previousIssue.code !== 'inconclusive' && previousIssue.code !== 'invalid-evidence') continue
        previousIssue.detail = `Historical ${previousIssue.code}: ${previousIssue.detail}; a valid conclusive attempt exists for the current fixture and release`
        previousIssue.code = 'historical-attempt'
      }
    }
    const outcomes = new Set(samples.map((sample) => sample.outcome))
    const outcome = outcomes.size === 1 ? samples[0].outcome : 'unknown'
    const evidenceIds = [...new Set(rows.flatMap((row) => (row.observation ? [row.observation.id] : [])))]
    if (outcomes.size > 1)
      report.issues.push(
        issue(
          'contradictory-outcomes',
          'Preserved attempts disagree; explicit reviewed resolution or a different experiment protocol is required',
          [version],
          evidenceIds,
        ),
      )
    if (
      !rows.length
      || rows.every(
        (row) => row.protocol !== SEED_PROTOCOL || (row.observation && row.observation.protocol !== FROZEN_PROTOCOL),
      )
    )
      report.issues.push(issue('unmeasured', 'No current-protocol observation for this published release', [version]))
    report.points.push({
      version,
      prerelease: !!semver.prerelease(version),
      outcome,
      evidenceIds,
      rowIds: rows.map((row) => row.id),
      ...(samples.some((sample) => sample.knownBug)
        ? {
            exceptions: samples
              .filter((sample) => sample.knownBug)
              .map((sample) => ({
                bugId: sample.knownBug!,
                observationId: sample.observation.id,
                status: sample.observation.status,
              })),
          }
        : {}),
    })
    if (outcome !== 'unknown')
      report.points.at(-1)!.evidenceIds = [...new Set(samples.map((sample) => sample.observation.id))]
    if (outcome !== 'unknown') candidates.set(version, samples)
  }
  const stable = report.points.filter((point) => !point.prerelease)
  let previous: InitialPoint | undefined
  let previousIndex = -1
  let unresolvedTransition = report.issues.some((item) => item.code === 'contradictory-outcomes')
  if (fixture.match.format === undefined) {
    unresolvedTransition = true
    report.issues.push(
      issue('unknown-format', 'No parsed format; retain unknown (*) instead of a broad filename-only restriction'),
    )
  }
  for (let index = 0; index < stable.length; index++) {
    const point = stable[index]
    if (point.outcome === 'unknown') continue
    if (previous && previous.outcome !== point.outcome) {
      const pair = (candidates.get(previous.version) ?? [])
        .flatMap((a) =>
          (candidates.get(point.version) ?? []).filter((b) => comparable(a, b)).map((b) => [a, b] as const),
        )
        .at(0)
      if (previousIndex !== index - 1) {
        unresolvedTransition = true
        report.issues.push(
          issue(
            'unconfirmed-transition',
            'Opposite outcomes have intervening unmeasured or inconclusive published stable releases',
            [previous.version, point.version],
            [...previous.evidenceIds, ...point.evidenceIds],
          ),
        )
      } else if (!pair) {
        unresolvedTransition = true
        report.issues.push(
          issue(
            'incomparable-transition',
            'Adjacent outcomes need the same fixture, protocol, Node integrity, runtime architecture and platform',
            [previous.version, point.version],
            [...previous.evidenceIds, ...point.evidenceIds],
          ),
        )
      } else
        report.boundaries.push({
          before: previous.version,
          after: point.version,
          direction: point.outcome === 'supported' ? 'lower' : 'upper',
          evidenceIds: pair.map((sample) => sample.observation.id),
        })
    }
    previous = point
    previousIndex = index
  }
  const intervals: Array<{ lower: string; upper?: string }> = []
  let open: { lower: string; upper?: string } | undefined
  for (const boundary of report.boundaries) {
    if (boundary.direction === 'lower') {
      open = { lower: boundary.after }
      intervals.push(open)
    } else if (open) {
      open.upper = boundary.after
      open = undefined
    } else unresolvedTransition = true
  }
  if (!intervals.length)
    report.issues.push(
      issue(
        'unknown-lower-bound',
        'No confirmed unsupported-to-supported stable release boundary; inference must retain unknown (*)',
      ),
    )
  const range = intervals
    .map((interval) => `>=${interval.lower}${interval.upper ? ` <${interval.upper}` : ''}`)
    .join(' || ')
  // A later confirmed island must not silently discard earlier support or admit measured rejection.
  if (
    range
    && stable.some(
      (point) =>
        point.outcome !== 'unknown' && semver.satisfies(point.version, range) !== (point.outcome === 'supported'),
    )
  ) {
    unresolvedTransition = true
    report.issues.push(
      issue('range-contradicts-observation', 'Candidate intervals disagree with at least one measured stable outcome'),
    )
  }
  if (range && !unresolvedTransition) {
    report.range = compileRanges(intervals)
  }
  return report
}
function retestTasks(options: InitialOptions, reports: InitialFixtureReport[]): InitialRetest[] {
  const tasks = new Map<string, InitialRetest>()
  for (const report of reports) {
    const fixture = options.fixtures.find((item) => item.id === report.fixtureId)!
    const stable = options.catalog.managers[fixture.manager]
      .filter((item) => !semver.prerelease(item.version))
      .sort((a, b) => semver.compare(a.version, b.version))
    for (const problem of report.issues.filter((item) =>
      ['unconfirmed-transition', 'incomparable-transition'].includes(item.code),
    )) {
      const start = stable.findIndex((item) => item.version === problem.versions[0])
      const end = stable.findIndex((item) => item.version === problem.versions[1])
      for (let index = start; index < end; index++) {
        const before = stable[index]
        const after = stable[index + 1]
        const environments = (version: string): RetestEnvironment[] =>
          options.rows
            .filter((row) => row.fixtureId === fixture.id && row.version === version && row.observation)
            .map((row) => {
              const observation = row.observation!
              return {
                node: observation.node,
                nodeArch: observation.nodeArch ?? observation.arch,
                nodeIntegrity: observation.nodeIntegrity,
                platform: observation.platform,
                arch: observation.arch,
                protocol: row.protocol,
                evidenceId: observation.id,
                ...(observation.environment ? { environment: observation.environment } : {}),
              }
            })
        const existingBefore = environments(before.version)
        const existingAfter = environments(after.version)
        const enginesKnown = before.node !== null && after.node !== null
        const compatible = enginesKnown
          ? options.catalog.nodes
              .filter(
                (node) =>
                  !semver.prerelease(node.version)
                  && semver.satisfies(node.version, before.node!)
                  && semver.satisfies(node.version, after.node!),
              )
              .map((node) => node.version)
              .sort(semver.rcompare)
          : []
        const observed = [...existingBefore, ...existingAfter]
          .map((item) => item.node)
          .filter((version) => compatible.includes(version))
        tasks.set(`${fixture.id}:${before.version}:${after.version}`, {
          fixtureId: fixture.id,
          beforeVersion: before.version,
          afterVersion: after.version,
          reason: problem.code,
          existingBefore,
          existingAfter,
          nodeCandidates: [...new Set([...observed, ...compatible])].slice(0, 3),
          nodeCandidateNote: enginesKnown
            ? 'Published versions satisfying both declared engines; candidates still need executable/platform and real command verification. Re-run both sides under one identical protocol and runtime.'
            : 'At least one engines.node is unknown; no common runtime is asserted. Inspect official tool metadata and verify an executable before re-running both sides.',
        })
      }
    }
  }
  return [...tasks.values()]
}
export function compileInitial(options: InitialOptions): { data: CompatibilityData; report: InitialReport } {
  validateKnownBugs({ schemaVersion: 1, bugs: options.knownBugs ?? [] })
  const catalogHash = digest(JSON.stringify(options.catalog))
  const evidenceCatalogs = new Map(
    [options.catalog, ...(options.evidenceCatalogs ?? [])].map((catalog) => [digest(JSON.stringify(catalog)), catalog]),
  )
  const report: InitialReport = {
    catalogHash,
    evidenceCatalogHashes: [...evidenceCatalogs.keys()],
    knownBugs: (options.knownBugs ?? []).filter((bug) => semver.minVersion(stableBugRange(bug.range)) !== null),
    fixtures: options.fixtures.map((fixture) => compileFixture(options, fixture, evidenceCatalogs)),
    issues: [],
    retests: [],
    exitCode: 0,
  }
  report.retests = retestTasks(options, report.fixtures)
  const groups = new Map<string, Fixture[]>()
  for (const fixture of options.fixtures)
    groups.set(matchKey(fixture), [...(groups.get(matchKey(fixture)) ?? []), fixture])
  const rules: CompatibilityRule[] = []
  for (const [key, fixtures] of groups) {
    const results = fixtures.map((fixture) => report.fixtures.find((item) => item.fixtureId === fixture.id)!)
    const ranges = new Set(results.map((item) => item.range))
    const range = ranges.size === 1 ? results[0].range : null
    if (ranges.size > 1)
      report.issues.push(
        issue(
          'fixture-disagreement',
          'Fixtures with the same manager, filename, format and features cannot establish one shared range',
          [],
          results.flatMap((item) => item.points.flatMap((point) => point.evidenceIds)),
        ),
      )
    if (range === null) continue
    const bugIds = new Set(
      results.flatMap((item) => item.points.flatMap((point) => point.exceptions?.map((entry) => entry.bugId) ?? [])),
    )
    rules.push({
      id: `initial-${digest(key).slice(0, 16)}`,
      manager: fixtures[0].manager,
      match: results[0].match,
      range,
      ...(bugIds.size ? { knownBugs: options.knownBugs!.filter((bug) => bugIds.has(bug.id)).map(bugSummary) } : {}),
    })
  }
  const issues = [...report.issues, ...report.fixtures.flatMap((fixture) => fixture.issues)].filter(
    (item) => !['superseded', 'historical-attempt'].includes(item.code),
  )
  if (issues.length) report.exitCode = 1
  if (issues.some((item) => ['inconclusive', 'unmeasured', 'invalid-evidence'].includes(item.code))) report.exitCode = 2
  return {
    data: { schemaVersion: 1, generatedAt: options.generatedAt ?? new Date().toISOString(), rules, observations: [] },
    report,
  }
}

export interface InitialPaths {
  catalog: string
  recipes: string
  fixturesRoot: string
  evidence: string[]
  output: string
  knownBugs?: string
}
export async function compileInitialPaths(paths: InitialPaths): Promise<ReturnType<typeof compileInitial>> {
  const catalog = JSON.parse(await readFile(paths.catalog, 'utf8')) as Catalog
  const fixtures = JSON.parse(await readFile(paths.recipes, 'utf8')) as Fixture[]
  const rows: SeedRow[] = []
  const evidenceCatalogs: Catalog[] = []
  const exclusions: ExclusionAudit[] = []
  for (const directory of paths.evidence) {
    const reviewed = await EvidenceExclusions.load(directory)
    try {
      evidenceCatalogs.push(JSON.parse(await readFile(join(directory, 'catalog.json'), 'utf8')) as Catalog)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    for (const name of (await readdir(join(directory, 'rows')))
      .filter((filename) => filename.endsWith('.json'))
      .sort()) {
      const path = join(directory, 'rows', name)
      const raw = await readFile(path)
      const row = JSON.parse(raw.toString()) as SeedRow
      if (!reviewed.check(row, raw, path)) rows.push(row)
    }
    exclusions.push(...reviewed.finish())
  }
  const fixtureHashes: Record<string, string> = {}
  for (const fixture of fixtures) {
    const directory = join(paths.fixturesRoot, fixture.directory)
    fixtureHashes[fixture.id] = digest(JSON.stringify(await hashes(directory, await fixtureFiles(directory))))
  }
  const excludedObservationIds = new Set(
    exclusions.flatMap((entry) => (entry.observationId ? [entry.observationId] : [])),
  )
  const result = compileInitial({
    catalog,
    evidenceCatalogs,
    fixtures,
    fixtureHashes,
    rows: rows.filter((row) => !row.observation || !excludedObservationIds.has(row.observation.id)),
    knownBugs: paths.knownBugs ? await loadKnownBugs(paths.knownBugs) : [],
  })
  result.report.exclusions = exclusions
  await mkdir(paths.output, { recursive: true })
  await writeFile(join(paths.output, 'compatibility.json'), `${JSON.stringify(result.data, null, 2)}\n`)
  await writeFile(join(paths.output, 'report.json'), `${JSON.stringify(result.report, null, 2)}\n`)
  const summary = [
    '# Initial compatibility compilation',
    '',
    `Catalog SHA-256: ${result.report.catalogHash}`,
    '',
    ...result.report.fixtures.flatMap((fixture) => [
      `## ${fixture.fixtureId}`,
      '',
      `Range: ${fixture.range ?? 'unknown (*)'}`,
      '',
      ...fixture.points.flatMap((point) =>
        (point.exceptions ?? []).map(
          (entry) =>
            `- known-bug-compatible: ${point.version}; raw ${entry.status}; ${entry.bugId}; observation ${entry.observationId}`,
        ),
      ),
      ...fixture.issues.map((item) => `- ${item.code}: ${item.versions.join(' → ')} ${item.detail}`),
      '',
    ]),
    ...result.report.issues.map((item) => `- ${item.code}: ${item.detail}`),
    '',
    '## Reviewed evidence exclusions',
    '',
    ...exclusions.map(
      (entry) =>
        `- ${entry.rowId} (${entry.observationId ?? 'no observation'}), SHA-256 ${entry.rowSha256}: ${entry.reason}; reviewed ${entry.reviewedAt}; ${entry.source}`,
    ),
    '',
    '## Retest tasks',
    '',
    ...result.report.retests.map(
      (task) =>
        `- ${task.fixtureId}: ${task.beforeVersion} → ${task.afterVersion}; Node candidates: ${task.nodeCandidates.join(', ') || 'unknown'}. ${task.nodeCandidateNote}`,
    ),
    '',
    `Exit code: ${result.report.exitCode}`,
    '',
  ]
  await writeFile(join(paths.output, 'report.md'), summary.join('\n'))
  return result
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const values = (name: string): string[] =>
    process.argv.flatMap((argument, index) =>
      argument === name && process.argv[index + 1] ? [process.argv[index + 1]] : [],
    )
  const required = (name: string): string => {
    const value = values(name)[0]
    if (!value) throw new Error(`Required ${name}`)
    return resolve(value)
  }
  Promise.resolve()
    .then(async () => {
      const evidence = values('--evidence').map((path) => resolve(path))
      if (!evidence.length) throw new Error('Required --evidence; repeat to combine immutable attempts')
      const result = await compileInitialPaths({
        catalog: required('--catalog'),
        recipes: required('--recipes'),
        fixturesRoot: required('--fixtures-root'),
        output: required('--output'),
        evidence,
        knownBugs: resolve(values('--known-bugs')[0] ?? 'maintenance/known-bugs.json'),
      })
      process.exitCode = result.report.exitCode
    })
    .catch((error: unknown) => {
      console.error(error)
      process.exitCode = 2
    })
}
