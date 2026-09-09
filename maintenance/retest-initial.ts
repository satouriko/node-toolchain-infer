import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import semver from 'semver'

import { isStableVersion } from '../src/versions.js'

import { digest, type Fixture, FROZEN_PROTOCOL, type Observation, SEED_PROTOCOL } from './model.js'
import { provision, type Tool } from './provision.js'
import { fixtureEnvironment, fixtureFiles, hashes, runFixture, sameEnvironment } from './runner.js'
import { monitorFacts } from './seed-monitor.js'

import type { InitialReport, InitialRetest } from './compile-initial.js'
import type { SeedRow } from '../scripts/seed-data.js'
import type { Catalog, Manager, ManagerRelease } from '../src/types.js'
import type { Buffer } from 'node:buffer'

/**
 * Independent pair experiments; never changes the original matrix or fixture inputs.
 * CLI: --report report.json --catalog catalog.json --output separate/evidence
 * Optional: --recipes fixtures/recipes.json --fixtures-root fixtures --concurrency 2
 * Repeat --fixture / --version to filter; either version selects the entire pair.
 * --retry-incomplete appends retries; successful sides are reused only on the same verified Node.
 * --node-arch x64 supports official historical macOS runtimes through Rosetta.
 * --node 19.7.0 overrides report candidates, still requiring catalog membership and both engines.
 * To compile later, pass both original and retest directories via compile-initial --evidence.
 */
export interface RetestToolRequest {
  manager: Manager
  release: ManagerRelease
  catalog: Catalog
  directory: string
  node: string
  nodeArch: 'x64' | 'arm64'
  cache: string
}
export interface RetestInstallRequest {
  fixture: Fixture
  tool: Tool
  root: string
  directory: string
  evidence: string
}
export interface RetestOptions {
  report: InitialReport
  catalog: Catalog
  fixtures: Fixture[]
  fixtureRoot: string
  output: string
  concurrency?: number
  fixtureIds?: string[]
  versions?: string[]
  retryIncomplete?: boolean
  cacheDirectory?: string
  node?: string
  nodeArch?: 'x64' | 'arm64'
  provisionTool?: (request: RetestToolRequest) => Promise<Tool>
  installFixture?: (request: RetestInstallRequest) => Promise<Observation>
}
export interface RetestSummary {
  selectedPairs: number
  completePairs: number
  incompletePairs: number
  reusedSides: number
  writtenRows: number
  exitCode: 0 | 2
}
interface PairResult {
  id: string
  key: string
  fixtureId: string
  fixtureHash: string
  catalogHash: string
  beforeVersion: string
  afterVersion: string
  node: string | null
  nodeArch: string
  rows: string[]
  complete: boolean
  errors: string[]
}
const exec = promisify(execFile)
async function immutable(path: string, bytes: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  try {
    await writeFile(path, bytes, { flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    if (digest(await readFile(path)) !== digest(bytes))
      throw new Error(`Refusing to replace immutable evidence ${path}`, { cause: error })
  }
}
const json = (path: string, value: unknown): Promise<void> => immutable(path, `${JSON.stringify(value, null, 2)}\n`)
async function readRows(directory: string): Promise<SeedRow[]> {
  const rows: SeedRow[] = []
  for (const name of (await readdir(directory)).filter((item) => item.endsWith('.json')).sort())
    rows.push(JSON.parse(await readFile(join(directory, name), 'utf8')) as SeedRow)
  return rows
}
async function defaultProvision(request: RetestToolRequest): Promise<Tool> {
  return provision(request.manager, request.release, request.catalog, request.directory, request.node, {
    cacheDirectory: request.cache,
    nodeArch: request.nodeArch,
    bootstrapDependencies: true,
    timeoutMs: 120_000,
  })
}
function commonNode(task: InitialRetest, fixture: Fixture, catalog: Catalog, override?: string): string | undefined {
  const before = catalog.managers[fixture.manager].find((release) => release.version === task.beforeVersion)
  const after = catalog.managers[fixture.manager].find((release) => release.version === task.afterVersion)
  if (!before?.node || !after?.node) return undefined
  return (override === undefined ? task.nodeCandidates : [override]).find(
    (node) =>
      isStableVersion(node)
      && catalog.nodes.some((release) => release.version === node)
      && semver.satisfies(node, before.node!)
      && semver.satisfies(node, after.node!),
  )
}
async function verifyNode(tool: Tool, request: RetestToolRequest): Promise<void> {
  if (
    tool.version !== request.release.version
    || tool.integrity !== request.release.integrity
    || tool.nodeVersion !== request.node
    || tool.nodeArch !== request.nodeArch
  )
    throw new Error('Provisioned tool or Node does not match the requested pair experiment')
  const bytes = await readFile(tool.node)
  const binarySha256 = digest(bytes)
  const integrity = `sha256-${createHash('sha256').update(bytes).digest('base64')}`
  if (tool.nodeBinarySha256 ? binarySha256 !== tool.nodeBinarySha256 : integrity !== tool.nodeIntegrity)
    throw new Error('Actual Node executable differs from its integrity receipt')
  const result = await exec(tool.node, ['-p', 'JSON.stringify([process.versions.node, process.arch])'], {
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  })
  const actual = JSON.parse(result.stdout.trim()) as [string, string]
  if (actual[0] !== request.node) throw new Error(`Actual Node version does not match requested ${request.node}`)
  if (actual[1] !== request.nodeArch)
    throw new Error(`Actual Node architecture does not match requested ${request.nodeArch}`)
}
async function preserveBootstrap<T extends Pick<Observation, 'bootstrap'>>(observation: T, output: string): Promise<T> {
  if (!observation.bootstrap) return observation
  const { bootstrap } = observation
  const lock = await readFile(bootstrap.lockfilePath)
  if (digest(lock) !== bootstrap.lockfileSha256) throw new Error('Bootstrap lock checksum mismatch')
  const log = await readFile(bootstrap.logPath)
  const prefix = `bootstrap/${bootstrap.lockfileSha256}`
  const logPath = `${prefix}/${digest(log)}.log`
  await immutable(join(output, prefix, 'package-lock.json'), lock)
  await immutable(join(output, logPath), log)
  return { ...observation, bootstrap: { ...bootstrap, lockfilePath: `${prefix}/package-lock.json`, logPath } }
}
export async function retestInitial(options: RetestOptions): Promise<RetestSummary> {
  const concurrency = options.concurrency ?? 2
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16)
    throw new Error('Concurrency must be an integer from 1 through 16')
  const catalogHash = digest(JSON.stringify(options.catalog))
  if (options.report.catalogHash !== catalogHash)
    throw new Error('Retest report and full official catalog snapshots differ')
  const output = resolve(options.output)
  await mkdir(join(output, 'rows'), { recursive: true })
  await json(join(output, 'catalog.json'), options.catalog)
  await json(join(output, 'sources', `${digest(JSON.stringify(options.report))}.json`), options.report)
  const history = await readRows(join(output, 'rows'))
  const selected = [
    ...new Map(
      options.report.retests
        .filter(
          (task) =>
            isStableVersion(task.beforeVersion)
            && isStableVersion(task.afterVersion)
            && (!options.fixtureIds?.length || options.fixtureIds.includes(task.fixtureId))
            && (!options.versions?.length
              || options.versions.includes(task.beforeVersion)
              || options.versions.includes(task.afterVersion)),
        )
        .map((task) => [`${task.fixtureId}:${task.beforeVersion}:${task.afterVersion}`, task]),
    ).values(),
  ]
  const summary: RetestSummary = {
    selectedPairs: selected.length,
    completePairs: 0,
    incompletePairs: 0,
    reusedSides: 0,
    writtenRows: 0,
    exitCode: 0,
  }
  const temporary = await mkdtemp(join(tmpdir(), 'toolchain-retest-'))
  const provisionTool = options.provisionTool ?? defaultProvision
  const install =
    options.installFixture
    ?? ((request: RetestInstallRequest) =>
      runFixture(request.fixture, request.tool, request.root, request.directory, request.evidence))
  let cursor = 0
  async function runPair(task: InitialRetest): Promise<void> {
    const selectedFixture = options.fixtures.find((item) => item.id === task.fixtureId)
    if (!selectedFixture) throw new Error(`Retest references unknown fixture ${task.fixtureId}`)
    const fixture: Fixture = selectedFixture
    const source = join(options.fixtureRoot, fixture.directory)
    const fixtureHash = digest(JSON.stringify(await hashes(source, await fixtureFiles(source))))
    const environment = await fixtureEnvironment(fixture, source)
    const node = commonNode(task, fixture, options.catalog, options.node)
    const nodeArch =
      options.nodeArch ?? (process.platform === 'darwin' && node && semver.major(node) < 16 ? 'x64' : process.arch)
    const versions = [task.beforeVersion, task.afterVersion]
    const releases = versions.map((version) =>
      options.catalog.managers[fixture.manager].find((release) => release.version === version),
    )
    const key = digest(
      JSON.stringify({
        protocol: SEED_PROTOCOL,
        purpose: 'paired-boundary-v1',
        manager: fixture.manager,
        fixtureId: fixture.id,
        fixtureHash,
        dependencies: fixture.dependencies,
        catalogHash,
        versions,
        integrities: releases.map((release) => release?.integrity),
        node,
        requestedNode: options.node,
        nodeArch,
        platform: process.platform,
        arch: process.arch,
      }),
    )
    const pair: PairResult = {
      id: randomUUID(),
      key,
      fixtureId: fixture.id,
      fixtureHash,
      catalogHash,
      beforeVersion: task.beforeVersion,
      afterVersion: task.afterVersion,
      node: node ?? null,
      nodeArch,
      rows: [],
      complete: false,
      errors: [],
    }
    const sideKey = (version: string): string => digest(`${key}:${version}`)
    async function historical(version: string, integrity?: string): Promise<SeedRow | undefined> {
      for (const row of history
        .filter((item) => item.key === sideKey(version))
        .sort((a, b) => b.attempt - a.attempt || b.createdAt.localeCompare(a.createdAt))) {
        const { observation } = row
        if (
          !observation
          || row.manager !== fixture.manager
          || row.version !== version
          || observation.version !== version
          || row.protocol !== SEED_PROTOCOL
          || row.catalogHash !== catalogHash
          || row.fixtureId !== fixture.id
          || row.fixtureHash !== fixtureHash
          || row.status !== observation.status
          || observation.node !== node
          || observation.nodeArch !== nodeArch
          || !sameEnvironment(observation.environment, environment)
          || (integrity && observation.nodeIntegrity !== integrity)
        )
          continue
        if (!monitorFacts(options.catalog, [{ fixture, hash: fixtureHash }], [observation]).covered.size) continue
        try {
          await readFile(join(output, observation.logPath))
          if (observation.frozenControl) await readFile(join(output, observation.frozenControl.logPath))
          if (observation.bootstrap) {
            if (
              digest(await readFile(join(output, observation.bootstrap.lockfilePath)))
              !== observation.bootstrap.lockfileSha256
            )
              continue
            await readFile(join(output, observation.bootstrap.logPath))
          }
          return row
        } catch {}
      }
      return undefined
    }
    const saved = await Promise.all(versions.map((version) => historical(version)))
    const blocked = versions.map(
      (version, index) =>
        !saved[index]
        && !options.retryIncomplete
        && history.some(
          (row) =>
            row.key === sideKey(version)
            && row.status === 'inconclusive'
            && (!row.observation || sameEnvironment(row.observation.environment, environment)),
        ),
    )
    let tools: Tool[] = []
    let failure: Error | undefined
    const ready =
      saved.every((row) => row?.observation)
      && saved[0]!.observation!.nodeIntegrity === saved[1]!.observation!.nodeIntegrity
    if (!ready && !blocked.some(Boolean)) {
      try {
        if (!node)
          throw new Error(
            `No published ${options.node ? `Node override ${options.node}` : 'report candidate'} satisfies both declared engines.node ranges; no host fallback is permitted`,
          )
        if (nodeArch !== 'x64' && nodeArch !== 'arm64') throw new Error(`Unsupported Node architecture ${nodeArch}`)
        for (let index = 0; index < versions.length; index++) {
          const release = releases[index]
          if (!release?.integrity) throw new Error(`Official release artifact is unavailable for ${versions[index]}`)
          const request: RetestToolRequest = {
            manager: fixture.manager,
            release,
            catalog: options.catalog,
            directory: join(temporary, pair.id, 'tools', String(index)),
            node,
            nodeArch,
            cache: resolve(options.cacheDirectory ?? join(dirname(options.fixtureRoot), '.cache/maintenance')),
          }
          const tool = await provisionTool(request)
          await json(join(output, 'provision', pair.id, `${index}.json`), await preserveBootstrap(tool, output))
          await verifyNode(tool, request)
          if (tools[0] && (tool.nodeIntegrity !== tools[0].nodeIntegrity || tool.nodeArch !== tools[0].nodeArch))
            throw new Error('Both sides must use the same verified Node executable and architecture')
          tools.push(tool)
        }
        tools = tools.map((tool) => ({ ...tool, node: tools[0].node }))
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error), { cause: error })
        pair.errors.push(String(error))
      }
    }
    const outcomes: SeedRow[] = []
    for (let index = 0; index < versions.length; index++) {
      const version = versions[index]
      const previous = tools[index] ? await historical(version, tools[index].nodeIntegrity) : saved[index]
      if (previous) {
        outcomes.push(previous)
        pair.rows.push(previous.id)
        summary.reusedSides++
        continue
      }
      if (blocked[index]) {
        pair.errors.push(`${version}: incomplete history requires --retry-incomplete`)
        continue
      }
      const id = randomUUID()
      const attemptPrefix = `attempts/${id}`
      const row: SeedRow = {
        id,
        key: sideKey(version),
        protocol: SEED_PROTOCOL,
        manager: fixture.manager,
        version,
        fixtureId: fixture.id,
        fixtureHash,
        catalogHash,
        createdAt: new Date().toISOString(),
        attempt:
          1 + Math.max(0, ...history.filter((item) => item.key === sideKey(version)).map((item) => item.attempt)),
        status: 'inconclusive',
      }
      try {
        if (failure) throw failure
        if (!tools[index])
          throw new Error('Pair provisioning is deferred until incomplete attempts are explicitly retried')
        const measured = await install({
          fixture,
          tool: tools[index],
          root: options.fixtureRoot,
          directory: join(temporary, pair.id, 'projects', String(index)),
          evidence: join(output, attemptPrefix),
        })
        const observation = await preserveBootstrap(
          {
            ...measured,
            logPath: `${attemptPrefix}/${measured.logPath}`,
            ...(measured.frozenControl
              ? {
                  frozenControl: await preserveBootstrap(
                    {
                      ...measured.frozenControl,
                      logPath: `${attemptPrefix}/${measured.frozenControl.logPath}`,
                    },
                    output,
                  ),
                }
              : {}),
          },
          output,
        )
        if (
          observation.version !== version
          || observation.protocol !== FROZEN_PROTOCOL
          || observation.node !== node
          || observation.nodeArch !== nodeArch
          || observation.nodeIntegrity !== tools[0].nodeIntegrity
          || observation.fixtureHash !== fixtureHash
          || !sameEnvironment(observation.environment, environment)
          || (observation.status !== 'inconclusive'
            && !monitorFacts(options.catalog, [{ fixture, hash: fixtureHash }], [observation]).covered.size)
        ) {
          await json(join(output, attemptPrefix, 'rejected-observation.json'), observation)
          throw new Error('Observation did not satisfy the selected fixture, Node and v2 experiment contract')
        }
        row.observation = observation
        row.status = observation.status
        row.logPath = observation.logPath
      } catch (error) {
        row.error = String(error)
        row.logPath = `${attemptPrefix}/failure.log`
        await immutable(join(output, row.logPath), error instanceof Error ? (error.stack ?? row.error) : row.error)
        pair.errors.push(`${version}: ${row.error}`)
      }
      await json(join(output, 'rows', `${row.id}.json`), row)
      history.push(row)
      outcomes.push(row)
      pair.rows.push(row.id)
      summary.writtenRows++
    }
    pair.complete =
      outcomes.length === 2
      && outcomes.every((row) => row.status !== 'inconclusive' && row.observation)
      && outcomes[0].observation!.nodeIntegrity === outcomes[1].observation!.nodeIntegrity
    if (pair.complete) summary.completePairs++
    else {
      summary.incompletePairs++
      summary.exitCode = 2
    }
    await json(join(output, 'pairs', `${pair.id}.json`), pair)
  }
  async function worker(): Promise<void> {
    for (;;) {
      const task = selected.at(cursor++)
      if (!task) return
      await runPair(task)
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, selected.length) }, () => worker()))
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
  await json(join(output, 'reports', `${randomUUID()}.json`), {
    ...summary,
    catalogHash,
    reportHash: digest(JSON.stringify(options.report)),
    generatedAt: new Date().toISOString(),
  })
  return summary
}

export async function retestInitialFromPaths(
  paths: { report: string; catalog: string; recipes: string; fixturesRoot: string; output: string },
  options: Omit<RetestOptions, 'report' | 'catalog' | 'fixtures' | 'fixtureRoot' | 'output'> = {},
): Promise<RetestSummary> {
  if (resolve(paths.output) === dirname(resolve(paths.catalog)))
    throw new Error('Use a separate retest evidence directory, not the source matrix')
  return retestInitial({
    ...options,
    report: JSON.parse(await readFile(paths.report, 'utf8')) as InitialReport,
    catalog: JSON.parse(await readFile(paths.catalog, 'utf8')) as Catalog,
    fixtures: JSON.parse(await readFile(paths.recipes, 'utf8')) as Fixture[],
    fixtureRoot: resolve(paths.fixturesRoot),
    output: resolve(paths.output),
  })
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const values = (name: string): string[] =>
    process.argv.flatMap((argument, index) =>
      argument === name && process.argv[index + 1] ? [process.argv[index + 1]] : [],
    )
  const required = (name: string): string => {
    const value = values(name)[0]
    if (!value) throw new Error(`Required ${name}`)
    return value
  }
  Promise.resolve()
    .then(async () => {
      const nodeArch = values('--node-arch').at(0)
      if (nodeArch !== undefined && nodeArch !== 'x64' && nodeArch !== 'arm64')
        throw new Error('--node-arch must be x64 or arm64')
      const result = await retestInitialFromPaths(
        {
          report: required('--report'),
          catalog: required('--catalog'),
          recipes: values('--recipes')[0] ?? 'fixtures/recipes.json',
          fixturesRoot: values('--fixtures-root')[0] ?? 'fixtures',
          output: required('--output'),
        },
        {
          concurrency: Number(values('--concurrency')[0] ?? 2),
          fixtureIds: values('--fixture'),
          versions: values('--version'),
          retryIncomplete: process.argv.includes('--retry-incomplete'),
          nodeArch,
          node: values('--node').at(0),
          cacheDirectory: values('--cache-dir')[0],
        },
      )
      console.log(JSON.stringify(result))
      process.exitCode = result.exitCode
    })
    .catch((error: unknown) => {
      console.error(error)
      process.exitCode = 2
    })
}
