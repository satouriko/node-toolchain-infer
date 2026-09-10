import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import semver from 'semver'

import { preserveBootstrap } from '../maintenance/bootstrap.js'
import { recordFailure } from '../maintenance/failure.js'
import { generateFixture } from '../maintenance/generate-fixtures.js'
import { compatibilityOutcome, type KnownBugReview, loadKnownBugs, reviewedBug } from '../maintenance/known-bugs.js'
import { digest, evaluate, type Fixture, type Issues, mergeHistory, type Observation } from '../maintenance/model.js'
import { compareBehavior, selectReleaseBatch } from '../maintenance/monitor.js'
import { provision } from '../maintenance/provision.js'
import { readJson, reusableObservation } from '../maintenance/run-matrix.js'
import { fixtureFiles, FormatDetectionError, hashes, runFixture } from '../maintenance/runner.js'
import {
  importSeedMonitor,
  monitorFactKey,
  monitorFacts,
  type MonitorSample,
  portableReleaseKey,
} from '../maintenance/seed-monitor.js'
import { prepareYarnArtifacts, type YarnEnricher } from '../maintenance/yarn-artifacts.js'
import { fetchCatalog } from '../src/catalog.js'
import { isStableVersion } from '../src/versions.js'

import type { Catalog, CompatibilityData, Manager } from '../src/types.js'

interface CheckInput {
  catalog: Catalog
  observations: Observation[]
  fixtures: Fixture[]
  manager?: Manager
  now?: string
  knownBugs?: KnownBugReview[]
}
export function checkReleases(input: CheckInput) {
  const managers = (input.manager ? [input.manager] : (['npm', 'pnpm', 'yarn'] as const)).map((manager) => {
    const fixtures = input.fixtures.filter((item) => item.manager === manager)
    const releases = input.catalog.managers[manager]
      .filter((item) => isStableVersion(item.version))
      .map((item) => item.version)
      .sort(semver.compare)
    const uncoveredVersions = releases.filter(
      (version) =>
        !fixtures.length
        || fixtures.some(
          (fixture) =>
            !input.observations.some(
              (item) =>
                item.manager === manager
                && item.version === version
                && item.fixtureId === fixture.id
                && compatibilityOutcome(item, input.knownBugs) !== 'unknown',
            ),
        ),
    )
    return {
      manager,
      releasedStableCount: releases.length,
      conclusivelyObservedCount: releases.length - uncoveredVersions.length,
      uncoveredVersions,
    }
  })
  return {
    schemaVersion: 1 as const,
    generatedAt: input.now ?? new Date().toISOString(),
    catalogGeneratedAt: input.catalog.generatedAt,
    managers,
    knownBugExceptions: input.observations.flatMap((observation) => {
      const bug = reviewedBug(observation, input.knownBugs)
      return bug
        ? [{ bugId: bug.id, observationId: observation.id, status: observation.status, outcome: 'supported' as const }]
        : []
    }),
    promptTemplatePath: 'maintenance/update-compatibility.prompt.md',
  }
}
export async function checkReleasesFromPaths(input: {
  catalogPath: string
  observationsPath: string
  fixtures: Fixture[]
  manager?: Manager
  now?: string
}) {
  const catalog = JSON.parse(await readFile(input.catalogPath, 'utf8')) as Catalog
  const document = JSON.parse(await readFile(input.observationsPath, 'utf8')) as
    Observation[] | { observations: Observation[] }
  return checkReleases({ ...input, catalog, observations: Array.isArray(document) ? document : document.observations })
}
export interface Report extends ReturnType<typeof checkReleases>, Issues {
  exitCode: 0 | 1 | 2
}
export async function writeReport(directory: string, report: Report): Promise<void> {
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  const lines = [
    `# Compatibility release check`,
    '',
    `Generated: ${report.generatedAt}`,
    '',
    `Exit code: ${report.exitCode} (0 complete, 1 maintenance required, 2 incomplete)`,
    '',
    ...report.managers.map(
      (item) =>
        `- ${item.manager}: ${item.conclusivelyObservedCount}/${item.releasedStableCount} stable releases have conclusive observations for every recipe.`,
    ),
  ]
  for (const key of ['unknownFormats', 'mismatches', 'unresolved', 'incomplete'] as const)
    lines.push('', `## ${key}`, '', ...(report[key].length ? report[key].map((item) => `- ${item}`) : ['None.']))
  lines.push(
    '',
    'Reproduce with the catalog.json, observations.json, state.json and logs in this artifact; see maintenance/update-compatibility.prompt.md. Historical point observations do not establish compatibility boundaries.',
    '',
  )
  await writeFile(join(directory, 'report.md'), lines.join('\n'))
}
interface State {
  schemaVersion: 1
  completed: string[]
  attempted?: Record<string, string>
  batches?: number
  unresolved: Record<string, string>
  generation?: Record<string, { match: Fixture['match']; directory: string; lock?: string } | undefined>
}
export async function runReleaseCheck(
  options: {
    root?: string
    stateDirectory?: string
    catalogPath?: string
    maxReleases?: number
    manager?: Manager
    seedDirectories?: string[]
    enrichYarn?: YarnEnricher
  } = {},
): Promise<Report> {
  const root = options.root ?? process.cwd()
  const directory = options.stateDirectory ?? join(root, 'maintenance/results')
  const seedDirectories =
    options.seedDirectories
    ?? [
      'initial-matrix',
      'yarn-supplement',
      'initial-boundaries',
      'yarn-pnp-matrix',
      'yarn-distributions',
      'yarn-boundaries',
      'legacy-pnpm-boundaries',
      'npm-v3-controls',
      'gap-audit/pnpm',
      'gap-audit/yarn',
    ].map((name) => join(root, 'maintenance/evidence', name))
  await mkdir(directory, { recursive: true })
  const fixtures = await readJson<Fixture[]>(join(root, 'fixtures/recipes.json'), [])
  const rules = await readJson<CompatibilityData>(join(root, 'data/compatibility.json'), {
    schemaVersion: 1,
    generatedAt: '',
    rules: [],
    observations: [],
  })
  const baseline = await readJson<Observation[]>(join(root, 'maintenance/evidence/observations.json'), [])
  const knownBugs = await loadKnownBugs(join(root, 'maintenance/known-bugs.json'))
  let history = mergeHistory(baseline, await readJson<Observation[]>(join(directory, 'observations.json'), []))
  const state = await readJson<State>(join(directory, 'state.json'), {
    schemaVersion: 1,
    completed: [],
    unresolved: {},
    generation: {},
  })
  state.generation ??= {}
  state.attempted ??= Object.fromEntries(state.completed.map((key) => [key, '']))
  state.batches ??= 0
  try {
    await cp(join(root, 'maintenance/evidence/logs'), join(directory, 'logs'), { recursive: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const issues: Issues = { unknownFormats: [], mismatches: [], unresolved: [], incomplete: [] }
  let catalog: Catalog = {
    schemaVersion: 1,
    generatedAt: '',
    sources: [],
    nodes: [],
    managers: { npm: [], pnpm: [], yarn: [] },
    warnings: [],
  }
  let samples: MonitorSample[] = []
  const temporary = await mkdtemp(join(tmpdir(), 'toolchain-releases-'))
  try {
    catalog = options.catalogPath
      ? (JSON.parse(await readFile(options.catalogPath, 'utf8')) as Catalog)
      : await fetchCatalog()
    const artifacts = await prepareYarnArtifacts({
      catalog,
      stateDirectory: directory,
      seedDirectories,
      enrich: options.enrichYarn,
    })
    catalog = artifacts.catalog
    for (const manager of ['npm', 'pnpm', 'yarn'] as const)
      catalog.managers[manager] = catalog.managers[manager].filter((release) => isStableVersion(release.version))
    catalog.nodes = catalog.nodes.filter((release) => isStableVersion(release.version))
    for (const key of Object.keys(state.unresolved)) {
      const version = /^(?:npm|pnpm|yarn)@([^:]+):/.exec(key)?.[1]
      if (version && !isStableVersion(version)) delete state.unresolved[key]
    }
    issues.incomplete.push(...artifacts.incomplete)
    await writeFile(join(directory, 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`)
    if (catalog.warnings.length)
      issues.incomplete.push(...catalog.warnings.map((item) => `Catalog ${item.code}: ${item.message}`))
    samples = await Promise.all(
      fixtures.map(async (fixture) => {
        const source = join(root, 'fixtures', fixture.directory)
        return { fixture, hash: digest(JSON.stringify(await hashes(source, await fixtureFiles(source)))) }
      }),
    )
    const seeded = await importSeedMonitor({
      directories: seedDirectories,
      destination: directory,
      catalog,
      samples,
      knownBugs,
    })
    const excluded = new Set(seeded.excludedObservationIds)
    history = mergeHistory(history, seeded.observations).filter((observation) => !excluded.has(observation.id))
    issues.incomplete.push(...seeded.incomplete)
    const facts = monitorFacts(catalog, samples, history, knownBugs)
    let referenceHistory = [...facts.observations]
    for (const key of facts.covered) delete state.unresolved[`${key}:seed-conflict`]
    for (const conflict of facts.conflicts)
      state.unresolved[`${conflict.split(': conflicting')[0]}:seed-conflict`] = conflict
    for (const observation of facts.observations) {
      const prerelease = semver.prerelease(observation.version)
      const bug = reviewedBug(observation, knownBugs)
      if (prerelease) continue
      const sample = samples.find((item) => item.fixture.id === observation.fixtureId)!
      const matching = rules.rules.filter(
        (rule) =>
          rule.range !== null
          && rule.manager === observation.manager
          && String(rule.match.format) === String(sample.fixture.match.format)
          && (rule.match.file === undefined || rule.match.file === sample.fixture.lock)
          && (rule.match.classic === undefined || rule.match.classic === sample.fixture.match.classic),
      )
      if (
        matching.length
        && matching.every((rule) => semver.satisfies(observation.version, rule.range!))
          !== (compatibilityOutcome(observation, knownBugs) === 'supported')
      ) {
        const release = catalog.managers[observation.manager].find((item) => item.version === observation.version)!
        const key = monitorFactKey(observation.manager, release, sample)
        state.unresolved[`${key}:baseline-rule`] =
          `${observation.manager}@${observation.version} ${sample.fixture.id}: initial observation ${observation.id} (${observation.status}) disagrees with current rule ${matching.map((rule) => rule.id).join(', ')}; ${observation.logPath}`
      } else if (bug) {
        const release = catalog.managers[observation.manager].find((item) => item.version === observation.version)!
        const factKey = monitorFactKey(observation.manager, release, sample)
        if (facts.covered.has(factKey)) {
          delete state.unresolved[`${factKey}:baseline-rule`]
          delete state.unresolved[
            `${portableReleaseKey(observation.manager, release, samples)}:${sample.fixture.id}:behavior`
          ]
        }
      }
    }
    // Rebuild coverage from current valid facts: exclusions may revoke an earlier completion.
    const completed = new Set<string>()
    const pendingIssue = (manager: Manager, version: string): boolean =>
      Object.keys(state.unresolved).some((key) => key.startsWith(`${manager}@${version}:`))
    for (const manager of ['npm', 'pnpm', 'yarn'] as const) {
      for (const release of catalog.managers[manager]) {
        const relevant = samples.filter((sample) => sample.fixture.manager === manager)
        if (
          relevant.length
          && relevant.every((sample) => facts.covered.has(monitorFactKey(manager, release, sample)))
          && !pendingIssue(manager, release.version)
        )
          completed.add(portableReleaseKey(manager, release, samples))
      }
    }
    state.completed = [...completed]
    const queue = (['npm', 'pnpm', 'yarn'] as const)
      .filter((manager) => !options.manager || options.manager === manager)
      .flatMap((manager) =>
        catalog.managers[manager].map((release) => ({
          manager,
          release,
          key: portableReleaseKey(manager, release, samples),
        })),
      )
      .filter(
        (item) =>
          !completed.has(item.key)
          || Object.keys(state.unresolved).some((key) => key.startsWith(`${item.manager}@${item.release.version}:`)),
      )
    // Recent releases first, with old-branch patches still in the queue, not hidden behind a maximum version.
    queue.sort(
      (a, b) =>
        (b.release.releasedAt ?? '').localeCompare(a.release.releasedAt ?? '')
        || semver.rcompare(a.release.version, b.release.version),
    )
    const selected = selectReleaseBatch(queue, state.attempted, options.maxReleases ?? 8, state.batches)
    state.batches++
    if (queue.length > selected.length)
      issues.incomplete.push(
        `${queue.length - selected.length} unprocessed release combinations remain; increase --max-releases or rerun with this state directory.`,
      )
    for (const { manager, release, key } of selected) {
      state.attempted[key] = new Date().toISOString()
      await writeFile(join(directory, 'state.json'), `${JSON.stringify(state, null, 2)}\n`)
      console.log(`Checking ${manager}@${release.version}`)
      const currentIssues: Record<string, string> = {}
      let conclusive = true
      const relevant = samples
        .filter(
          (sample) =>
            sample.fixture.manager === manager
            && (pendingIssue(manager, release.version) || !facts.covered.has(monitorFactKey(manager, release, sample))),
        )
        .map((sample) => sample.fixture)
      if (!relevant.length) currentIssues[`${key}:recipe`] = `No recipe for ${manager}@${release.version}`
      try {
        const provisionOptions = {
          bootstrapDependencies: true,
          cacheDirectory: join(root, '.cache/maintenance'),
          timeoutMs: 120_000,
        }
        const tool = await provision(manager, release, catalog, join(temporary, 'tools'), undefined, provisionOptions)
        if (tool.bootstrap) tool.bootstrap = await preserveBootstrap(tool.bootstrap, directory)
        // Generate each recipe shape with the exact new version; detect new formats before matrix testing.
        for (const fixture of relevant) {
          const generationKey = `${key}:${fixture.id}`
          let generated = state.generation[generationKey]
          if (!generated) {
            generated = await generateFixture(
              {
                ...fixture,
                version: release.version,
                node: fixture.version === release.version ? fixture.node : undefined,
              },
              catalog,
              join(directory, 'generated', digest(generationKey)),
              provisionOptions,
            )
            state.generation[generationKey] = generated
          }
          const known = fixtures.some(
            (candidate) =>
              candidate.manager === manager
              && candidate.lock === (generated.lock ?? fixture.lock)
              && JSON.stringify(candidate.match) === JSON.stringify(generated.match),
          )
          if (!known) {
            const message = `${manager}@${release.version} generated unknown format ${JSON.stringify(generated.match)} using ${fixture.id}`
            issues.unknownFormats.push(message)
            currentIssues[`${generationKey}:format`] = message
          }
          const observation =
            (await reusableObservation(fixture, tool, join(root, 'fixtures'), history))
            ?? (await runFixture(fixture, tool, join(root, 'fixtures'), join(temporary, 'project'), directory))
          history = mergeHistory(history, [observation])
          await writeFile(join(directory, 'observations.json'), `${JSON.stringify(history, null, 2)}\n`)
          const matching = rules.rules.filter(
            (rule) =>
              rule.manager === manager
              && String(rule.match.format) === String(fixture.match.format)
              && (rule.match.file === undefined || rule.match.file === fixture.lock)
              && (rule.match.classic === undefined || rule.match.classic === fixture.match.classic),
          )
          referenceHistory = mergeHistory(
            referenceHistory,
            monitorFacts(catalog, samples, [observation], knownBugs).observations,
          )
          const comparison = compareBehavior(observation, referenceHistory, matching, knownBugs)
          const bug = reviewedBug(observation, knownBugs)
          if (observation.status === 'inconclusive' && !bug) {
            conclusive = false
            issues.incomplete.push(`${manager}@${release.version} ${fixture.id}: ${observation.logPath}`)
          } else if (
            (!bug && (observation.status === 'rewrite' || observation.status === 'semantic-mismatch'))
            || comparison.mismatch
          ) {
            const message = `${manager}@${release.version} ${fixture.id}: ${observation.status}, expected ${String(comparison.expected)} (${comparison.basis}${comparison.evidenceId ? ` ${comparison.evidenceId}` : ''}); ${observation.logPath}`
            issues.mismatches.push(message)
            currentIssues[`${generationKey}:behavior`] = message
          }
        }
      } catch (error) {
        const failureLog = await recordFailure(directory, `${manager}@${release.version}`, error)
        if (error instanceof FormatDetectionError) {
          const message = `${manager}@${release.version}: ${String(error)}; inspect generated candidate receipts/logs`
          issues.unknownFormats.push(message)
          currentIssues[`${key}:parser`] = message
        } else {
          conclusive = false
          issues.incomplete.push(`${manager}@${release.version}: ${String(error)}; ${failureLog}`)
        }
      }
      if (conclusive) {
        for (const issueKey of Object.keys(state.unresolved))
          if (issueKey.startsWith(`${manager}@${release.version}:`)) delete state.unresolved[issueKey]
        completed.add(key)
      }
      Object.assign(state.unresolved, currentIssues)
      state.completed = [...completed]
      await writeFile(join(directory, 'state.json'), `${JSON.stringify(state, null, 2)}\n`)
    }
  } catch (error) {
    const failureLog = await recordFailure(directory, 'Release check setup', error)
    issues.incomplete.push(`${String(error)}; ${failureLog}`)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
  // A retry can resolve operational issues, but cannot erase contradictory preserved facts.
  const finalFacts = monitorFacts(catalog, samples, history, knownBugs)
  for (const conflict of finalFacts.conflicts)
    state.unresolved[`${conflict.split(': conflicting')[0]}:seed-conflict`] = conflict
  issues.unresolved = Object.values(state.unresolved)
  const report = {
    ...checkReleases({
      catalog,
      observations: finalFacts.observations,
      fixtures,
      manager: options.manager,
      knownBugs,
    }),
    ...evaluate(issues),
  }
  // Persist discovered work even when metadata, provisioning or a later fixture fails.
  await writeFile(join(directory, 'state.json'), `${JSON.stringify(state, null, 2)}\n`)
  await writeFile(join(directory, 'observations.json'), `${JSON.stringify(history, null, 2)}\n`)
  await writeReport(directory, report)
  return report
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const argument = (name: string): string | undefined => {
    const index = process.argv.indexOf(name)
    return index === -1 ? undefined : process.argv[index + 1]
  }
  const maxReleases = Number(argument('--max-releases') ?? '8')
  if (!Number.isInteger(maxReleases) || maxReleases < 0) throw new Error('--max-releases must be a nonnegative integer')
  const manager = argument('--manager')
  if (manager && !['npm', 'pnpm', 'yarn'].includes(manager)) throw new Error('--manager must be npm, pnpm or yarn')
  runReleaseCheck({
    stateDirectory: argument('--state-dir'),
    catalogPath: argument('--catalog'),
    maxReleases,
    manager: manager as Manager | undefined,
    seedDirectories: process.argv.includes('--seed-dir')
      ? process.argv.flatMap((value, index) =>
          value === '--seed-dir' && process.argv[index + 1] ? [process.argv[index + 1]] : [],
        )
      : undefined,
  })
    .then((report) => {
      console.log(`Report: ${argument('--state-dir') ?? 'maintenance/results'}/report.md`)
      process.exitCode = report.exitCode
    })
    .catch((error: unknown) => {
      console.error(error)
      process.exitCode = 2
    })
}
