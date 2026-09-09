import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import semver from 'semver'

import { frozenControlError } from '../maintenance/frozen-control.js'
import { digest, type Fixture, type Observation, type Outcome, SEED_PROTOCOL } from '../maintenance/model.js'
import { provision, selectHistoricalNode, type Tool } from '../maintenance/provision.js'
import { readJson } from '../maintenance/run-matrix.js'
import {
  fixtureEnvironment,
  fixtureFiles,
  frozenArgs,
  hashes,
  runFixture,
  sameEnvironment,
} from '../maintenance/runner.js'
import { fetchCatalog, loadCatalog } from '../src/catalog.js'
import { errorMessage } from '../src/validation.js'
import { isStableVersion } from '../src/versions.js'

import type { Catalog, Manager, ManagerRelease } from '../src/types.js'

// Bump when the experiment contract changes. Old observations remain in their original run.
const protocol = SEED_PROTOCOL
interface Sample {
  fixture: Fixture
  hash: string
  environment: Record<string, string>
}
export interface SeedRow {
  id: string
  key: string
  protocol: string
  manager: Manager
  version: string
  fixtureId: string
  fixtureHash: string
  catalogHash: string
  createdAt: string
  attempt: number
  status: Outcome
  observation?: Observation
  error?: string
  logPath?: string
}
export interface SeedSummary {
  protocol: string
  catalogHash: string
  updatedAt: string
  totalReleases: number
  totalCombinations: number
  attempted: number
  unattempted: number
  historyRows: number
  statuses: Record<Outcome, number>
  managers: Record<Manager, { releases: number; combinations: number; attempted: number }>
  exitCode: 0 | 2
}
interface ToolRequest {
  manager: Manager
  release: ManagerRelease
  catalog: Catalog
  directory: string
  cache: string
  historical: boolean
}
interface InstallRequest {
  fixture: Fixture
  tool: Tool
  root: string
  directory: string
  evidence: string
}
export function needsHistoricalRuntime(output: string): boolean {
  return (
    /SyntaxError|TypeError|ReferenceError|Cannot read propert(?:y|ies)|Actual tool version mismatch:|ERR_INVALID_THIS|ERR_REQUIRE_ESM|ERR_UNKNOWN_BUILTIN_MODULE|ERR_PACKAGE_PATH_NOT_EXPORTED|MODULE_NOT_FOUND|Cannot find module|primordials|Unsupported engine|EBADENGINE|requires? (?:a |at least )?Node|Node[^\n]*(?:not supported|unsupported|too old)/i.test(
      output,
    ) || /^[^\n]*(?:npm-cli|pnpm|yarn)[^\n]* (?:ci|install) [^\n]+\n\s*$/.test(output)
  )
}
export interface SeedOptions {
  root?: string
  output?: string
  catalog?: Catalog
  concurrency?: number
  limit?: number
  versions?: string[]
  retryIncomplete?: boolean
  quiet?: boolean
  provisionTool?: (request: ToolRequest) => Promise<Tool>
  installFixture?: (request: InstallRequest) => Promise<Observation>
}
function errorEvidence(error: unknown): string {
  const parts: string[] = []
  const visited = new Set<unknown>()
  let current = error
  while (current && !visited.has(current)) {
    visited.add(current)
    if (current instanceof Error) parts.push(current.stack ?? current.message)
    else parts.push(typeof current === 'string' ? current : 'Non-Error cause')
    if (typeof current !== 'object') break
    const details = current as { stdout?: unknown; stderr?: unknown; cause?: unknown }
    for (const output of [details.stdout, details.stderr]) if (typeof output === 'string') parts.push(output)
    current = details.cause
  }
  return parts.join('\n')
}
async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`)
  await rename(temporary, path)
}
export async function readSeedRows(evidence: string): Promise<SeedRow[]> {
  const directory = join(evidence, 'rows')
  await mkdir(directory, { recursive: true })
  const files = (await readdir(directory)).filter((name) => name.endsWith('.json'))
  const rows: SeedRow[] = []
  // Avoid opening thousands of files at once.
  for (let offset = 0; offset < files.length; offset += 64) {
    rows.push(
      ...(await Promise.all(
        files
          .slice(offset, offset + 64)
          .map(async (name) => JSON.parse(await readFile(join(directory, name), 'utf8')) as SeedRow),
      )),
    )
  }
  return rows.sort(
    (a, b) => a.attempt - b.attempt || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  )
}
function combinationKey(manager: Manager, release: ManagerRelease, sample: Sample): string {
  return digest(
    JSON.stringify({
      protocol,
      manager,
      version: release.version,
      integrity: release.integrity,
      fixture: sample.fixture.id,
      hash: sample.hash,
      expectedDependencies: sample.fixture.dependencies,
      platform: process.platform,
      arch: process.arch,
      hostNode: process.versions.node,
    }),
  )
}
async function defaultProvision(request: ToolRequest): Promise<Tool> {
  const historical = request.historical ? selectHistoricalNode(request.release, request.catalog) : undefined
  const nodeArch = historical && semver.major(historical) < 16 && process.platform === 'darwin' ? 'x64' : undefined
  return provision(request.manager, request.release, request.catalog, request.directory, historical, {
    cacheDirectory: request.cache,
    nodeArch,
    timeoutMs: 120_000,
    bootstrapDependencies: true,
  })
}
async function defaultInstall(request: InstallRequest): Promise<Observation> {
  const observation = await runFixture(
    request.fixture,
    request.tool,
    join(request.root, 'fixtures'),
    request.directory,
    request.evidence,
  )
  if (observation.bootstrap) {
    const prefix = `bootstrap/${observation.bootstrap.lockfileSha256}`
    const logName = `${digest(await readFile(observation.bootstrap.logPath))}.log`
    await mkdir(join(request.evidence, prefix), { recursive: true })
    await cp(observation.bootstrap.lockfilePath, join(request.evidence, prefix, 'package-lock.json'))
    await cp(observation.bootstrap.logPath, join(request.evidence, prefix, logName))
    observation.bootstrap = {
      ...observation.bootstrap,
      lockfilePath: `${prefix}/package-lock.json`,
      logPath: `${prefix}/${logName}`,
    }
    if (observation.frozenControl?.bootstrap) observation.frozenControl.bootstrap = observation.bootstrap
  }
  return observation
}
export async function seedData(options: SeedOptions = {}): Promise<SeedSummary> {
  const root = options.root ?? process.cwd()
  const evidence = options.output ?? join(root, 'maintenance/evidence/initial-matrix')
  await mkdir(evidence, { recursive: true })
  await mkdir(join(evidence, 'logs'), { recursive: true })
  const snapshot = join(evidence, 'catalog.json')
  const savedCatalog = await readJson<Catalog | null>(snapshot, null)
  const catalog = options.catalog ?? savedCatalog ?? (await fetchCatalog())
  const catalogHash = digest(JSON.stringify(catalog))
  if (savedCatalog && digest(JSON.stringify(savedCatalog)) !== catalogHash) {
    throw new Error(
      'This matrix is pinned to a different catalog. Use a new --output directory; preserve the previous snapshot.',
    )
  }
  if (!savedCatalog) await atomicJson(snapshot, catalog)
  const fixtures = await readJson<Fixture[]>(join(root, 'fixtures/recipes.json'), [])
  if (!fixtures.length) throw new Error('No fixture recipes')
  const samples = await Promise.all(
    fixtures.map(async (fixture): Promise<Sample> => {
      const directory = join(root, 'fixtures', fixture.directory)
      return {
        fixture,
        hash: digest(JSON.stringify(await hashes(directory, await fixtureFiles(directory)))),
        environment: await fixtureEnvironment(fixture, directory),
      }
    }),
  )
  const previous = await readSeedRows(evidence)
  const latest = new Map(previous.map((row) => [row.key, row]))
  let historyRows = previous.filter((row) => isStableVersion(row.version)).length
  const managers: Manager[] = ['npm', 'pnpm', 'yarn']
  const jobs = managers
    .flatMap((manager) =>
      catalog.managers[manager]
        .filter(
          (release) =>
            isStableVersion(release.version)
            && (!options.versions || options.versions.includes(`${manager}@${release.version}`)),
        )
        .map((release) => ({
          manager,
          release,
          samples: samples.filter((sample) => sample.fixture.manager === manager),
        })),
    )
    .sort((a, b) => semver.rcompare(a.release.version, b.release.version) || a.manager.localeCompare(b.manager))
  if (!jobs.length) throw new Error('No matching published releases')
  const controlsRequired = new Map(
    jobs.flatMap((job) =>
      job.samples
        .filter((sample) => sample.fixture.controlDependencies)
        .map(
          (sample) =>
            [
              combinationKey(job.manager, job.release, sample),
              JSON.stringify({ ...sample.fixture.dependencies, ...sample.fixture.controlDependencies }),
            ] as const,
        ),
    ),
  )
  const controlledFixtures = new Map(
    jobs.flatMap((job) =>
      job.samples.map((sample) => [combinationKey(job.manager, job.release, sample), sample.fixture] as const),
    ),
  )
  const needsControlRecheck = (key: string): boolean => {
    const row = latest.get(key)
    const fixture = controlledFixtures.get(key)
    const observation = row?.observation
    return Boolean(
      row?.status === 'inconclusive'
      && fixture?.controlDependencies
      && observation?.frozenControl
      && observation.exitCode === 0
      && observation.semantic
      && !frozenControlError(fixture, { ...observation, status: 'pass' }),
    )
  }
  const needsCommandRecheck = (key: string): boolean => {
    const row = latest.get(key)
    return Boolean(
      row?.observation
      && JSON.stringify(row.observation.command) !== JSON.stringify(frozenArgs(row.manager, row.version)),
    )
  }
  const environments = new Map(
    jobs.flatMap((job) =>
      job.samples.map((sample) => [combinationKey(job.manager, job.release, sample), sample.environment] as const),
    ),
  )
  const needsEnvironmentRecheck = (key: string): boolean => {
    const observation = latest.get(key)?.observation
    return Boolean(observation && !sameEnvironment(observation.environment, environments.get(key)))
  }
  const needed = (key: string): boolean =>
    !latest.has(key)
    || needsCommandRecheck(key)
    || needsEnvironmentRecheck(key)
    || needsControlRecheck(key)
    || (Boolean(options.retryIncomplete) && latest.get(key)?.status === 'inconclusive')
    || (controlsRequired.has(key)
      && latest.get(key)?.status === 'pass'
      && JSON.stringify(latest.get(key)?.observation?.frozenControl?.requestedDependencies)
        !== controlsRequired.get(key))
  const pending = jobs.filter((job) =>
    job.samples.some((sample) => needed(combinationKey(job.manager, job.release, sample))),
  )
  const selected = options.limit === undefined ? pending : pending.slice(0, options.limit)
  const concurrency = options.concurrency ?? 4
  if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 0))
    throw new Error('Limit must be a nonnegative integer')
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16)
    throw new Error('Concurrency must be an integer from 1 through 16')
  const temporary = await mkdtemp(join(tmpdir(), 'toolchain-seed-'))
  const makeSummary = (): SeedSummary => {
    const statuses: Record<Outcome, number> = {
      pass: 0,
      incompatible: 0,
      rewrite: 0,
      'semantic-mismatch': 0,
      inconclusive: 0,
    }
    const counts = Object.fromEntries(
      managers.map((name) => [name, { releases: 0, combinations: 0, attempted: 0 }]),
    ) as SeedSummary['managers']
    let totalCombinations = 0
    let attempted = 0
    for (const job of jobs) {
      counts[job.manager].releases++
      for (const sample of job.samples) {
        totalCombinations++
        counts[job.manager].combinations++
        const key = combinationKey(job.manager, job.release, sample)
        const row = latest.get(key)
        if (row && !needsCommandRecheck(key) && !needsEnvironmentRecheck(key)) {
          attempted++
          counts[job.manager].attempted++
          statuses[row.status]++
        }
      }
    }
    return {
      protocol,
      catalogHash,
      updatedAt: new Date().toISOString(),
      totalReleases: jobs.length,
      totalCombinations,
      attempted,
      unattempted: totalCombinations - attempted,
      historyRows,
      statuses,
      managers: counts,
      exitCode: totalCombinations === attempted && statuses.inconclusive === 0 ? 0 : 2,
    }
  }
  let reportChain = Promise.resolve()
  const report = (): Promise<void> => {
    reportChain = reportChain.then(async () => atomicJson(join(evidence, 'summary.json'), makeSummary()))
    return reportChain
  }
  const persist = async (
    manager: Manager,
    release: ManagerRelease,
    sample: Sample,
    result: Pick<SeedRow, 'status' | 'observation' | 'error' | 'logPath'>,
  ): Promise<void> => {
    const row: SeedRow = {
      id: randomUUID(),
      key: combinationKey(manager, release, sample),
      protocol,
      manager,
      version: release.version,
      fixtureId: sample.fixture.id,
      fixtureHash: sample.hash,
      catalogHash,
      createdAt: new Date().toISOString(),
      attempt: (latest.get(combinationKey(manager, release, sample))?.attempt ?? 0) + 1,
      ...result,
    }
    await atomicJson(join(evidence, 'rows', `${row.id}.json`), row)
    latest.set(row.key, row)
    historyRows++
  }
  let cursor = 0
  let finished = 0
  const provisionTool = options.provisionTool ?? defaultProvision
  const installFixture = options.installFixture ?? defaultInstall
  const worker = async (workerIndex: number): Promise<void> => {
    while (cursor < selected.length) {
      const job = selected[cursor++]
      const directory = join(temporary, String(workerIndex))
      const remaining = job.samples.filter((sample) => needed(combinationKey(job.manager, job.release, sample)))
      const request: ToolRequest = {
        manager: job.manager,
        release: job.release,
        catalog,
        directory: join(directory, 'tools'),
        cache: join(root, '.cache/maintenance'),
        historical: false,
      }
      const attempt = async (targets: Sample[], historical: boolean): Promise<Sample[]> => {
        let tool: Tool
        try {
          tool = await provisionTool({ ...request, historical })
        } catch (error) {
          const logPath = `logs/provision-${job.manager}-${job.release.version}-${randomUUID()}.log`
          await writeFile(join(evidence, logPath), errorEvidence(error))
          for (const sample of targets)
            await persist(job.manager, job.release, sample, {
              status: 'inconclusive',
              error: errorMessage(error),
              logPath,
            })
          return needsHistoricalRuntime(errorMessage(error)) ? targets : []
        }
        const retry: Sample[] = []
        for (const sample of targets) {
          try {
            const observation = await installFixture({
              fixture: sample.fixture,
              tool,
              root,
              directory: join(directory, 'project'),
              evidence,
            })
            await persist(job.manager, job.release, sample, { status: observation.status, observation })
            if (
              observation.status === 'inconclusive'
              && needsHistoricalRuntime(await readFile(join(evidence, observation.logPath), 'utf8'))
            )
              retry.push(sample)
          } catch (error) {
            await persist(job.manager, job.release, sample, { status: 'inconclusive', error: errorMessage(error) })
            if (needsHistoricalRuntime(errorMessage(error))) retry.push(sample)
          }
        }
        return retry
      }
      try {
        const retry = await attempt(remaining, false)
        // Retry historical runtimes only for real execution/provisioning failures. Never erase a rejection.
        if (
          retry.length
          && !options.provisionTool
          && selectHistoricalNode(job.release, catalog) !== process.versions.node
        )
          await attempt(retry, true)
      } catch (error) {
        for (const sample of remaining.filter(
          (candidate) => !latest.has(combinationKey(job.manager, job.release, candidate)),
        ))
          await persist(job.manager, job.release, sample, { status: 'inconclusive', error: errorMessage(error) })
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
      finished++
      await report()
      if (!options.quiet)
        console.log(
          `[${finished}/${selected.length}] ${job.manager}@${job.release.version}: ${remaining.map((sample) => `${sample.fixture.id}=${latest.get(combinationKey(job.manager, job.release, sample))?.status}`).join(', ')}`,
        )
    }
  }
  try {
    await report()
    const completed = await Promise.allSettled(
      Array.from({ length: Math.min(concurrency, selected.length) }, (_, index) => worker(index)),
    )
    await report()
    const failures = completed.filter((result) => result.status === 'rejected')
    if (failures.length)
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        'Matrix workers failed; completed rows and summary were preserved.',
      )
    return makeSummary()
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const argument = (name: string): string | undefined => {
    const index = process.argv.indexOf(name)
    return index === -1 ? undefined : process.argv[index + 1]
  }
  const catalogPath = argument('--catalog')
  const options: SeedOptions = {
    output: argument('--output'),
    concurrency: Number(argument('--concurrency') ?? 4),
    retryIncomplete: process.argv.includes('--retry-incomplete'),
    ...(argument('--limit') ? { limit: Number(argument('--limit')) } : {}),
    ...(argument('--versions') ? { versions: argument('--versions')!.split(',') } : {}),
  }
  Promise.resolve(catalogPath ? loadCatalog(catalogPath) : undefined)
    .then((catalog) => seedData({ ...options, catalog }))
    .then((summary) => {
      console.log(JSON.stringify(summary, null, 2))
      process.exitCode = summary.exitCode
    })
    .catch((error: unknown) => {
      console.error(error)
      process.exitCode = 2
    })
}
