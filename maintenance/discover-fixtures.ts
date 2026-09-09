import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import semver from 'semver'
import { parse } from 'yaml'

import { isStableVersion } from '../src/versions.js'

import { formatManifest, generateFixture } from './generate-fixtures.js'
import { digest, type Fixture } from './model.js'
import { provision, type ProvisionOptions, selectHistoricalNode } from './provision.js'
import { execute, hashes, runFixture } from './runner.js'

import type { BootstrapReceipt } from './bootstrap.js'
import type { Catalog, Manager } from '../src/types.js'

interface Probe {
  manager: Manager
  version: string
  lock: string
  sharedWorkspace?: boolean
}
const root = fileURLToPath(new URL('../', import.meta.url))
const discovery = join(root, 'maintenance/evidence/format-discovery')
const catalogPath = join(root, 'maintenance/evidence/initial-matrix/catalog.json')
async function preserveBootstrap(
  bootstrap: BootstrapReceipt | undefined,
  receiptDirectory: string,
): Promise<BootstrapReceipt | undefined> {
  if (!bootstrap) return undefined
  const destination = join(discovery, 'bootstrap', bootstrap.lockfileSha256)
  await mkdir(destination, { recursive: true })
  await cp(bootstrap.lockfilePath, join(destination, 'package-lock.json'))
  await cp(bootstrap.logPath, join(destination, 'bootstrap.log'))
  return {
    ...bootstrap,
    lockfilePath: relative(receiptDirectory, join(destination, 'package-lock.json')),
    logPath: relative(receiptDirectory, join(destination, 'bootstrap.log')),
  }
}
export function fixtureIdentity(probe: Probe, match: Fixture['match']): { id: string; directory: string } {
  const format = String(match.format)
  let family = `lock-v${format}`
  if (probe.manager === 'pnpm' && probe.lock === 'shrinkwrap.yaml') family = `legacy-shrinkwrap-v${format}`
  if (probe.manager === 'npm')
    family = `${probe.lock === 'npm-shrinkwrap.json' ? 'shrinkwrap' : 'package-lock'}-v${format}`
  if (probe.manager === 'yarn') {
    let yarnFamily = match.classic ? 'classic' : 'modern'
    if (match.features?.yarnFamily === 'zpm') yarnFamily = 'zpm'
    family = `${yarnFamily}-v${format}`
  }
  return { id: `${probe.manager}-${family}`, directory: `${probe.manager}/${family}/basic` }
}
async function generateSharedLegacy(
  fixture: Fixture,
  catalog: Catalog,
  destination: string,
  options: ProvisionOptions,
): Promise<{ directory: string; match: Fixture['match'] }> {
  const release = catalog.managers.pnpm.find((item) => item.version === fixture.version)
  if (!release) throw new Error('Missing official pnpm release')
  const temporary = await mkdtemp(join(tmpdir(), 'toolchain-shared-legacy-'))
  try {
    const tool = await provision('pnpm', release, catalog, join(temporary, 'tools'), fixture.node, options)
    const project = join(temporary, 'project')
    await mkdir(project)
    await writeFile(
      join(project, 'package.json'),
      await formatManifest(
        `${JSON.stringify({ name: 'compatibility-fixture', version: '1.0.0', private: true, dependencies: fixture.dependencies }, null, 2)}\n`,
      ),
    )
    await writeFile(join(project, '.npmrc'), 'shared-workspace-shrinkwrap=true\n')
    await writeFile(join(project, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n')
    const command = ['install', '--ignore-scripts', '--shared-workspace-shrinkwrap']
    const result = await execute(tool, command, project)
    await mkdir(destination, { recursive: true })
    await writeFile(join(destination, 'generation.log'), result.output)
    if (result.exitCode !== 0) throw new Error(`Shared workspace generation failed; ${destination}/generation.log`)
    const files = ['package.json', '.npmrc', 'pnpm-workspace.yaml', fixture.lock]
    for (const file of files) await cp(join(project, file), join(destination, file))
    const document = parse(await readFile(join(destination, fixture.lock), 'utf8')) as { shrinkwrapVersion?: unknown }
    if (typeof document.shrinkwrapVersion !== 'number') throw new Error('No generated shrinkwrapVersion')
    const match = { format: String(document.shrinkwrapVersion), features: { sharedWorkspace: true } }
    const fileHashes = await hashes(destination, files)
    await writeFile(
      join(destination, 'receipt.json'),
      `${JSON.stringify({ generatedAt: new Date().toISOString(), manager: 'pnpm', version: tool.version, node: tool.nodeVersion, nodeArch: tool.nodeArch, nodeIntegrity: tool.nodeIntegrity, toolIntegrity: tool.integrity, toolUrl: tool.url, bootstrap: await preserveBootstrap(tool.bootstrap, destination), platform: process.platform, arch: process.arch, command, match, files: fileHashes, fixtureHash: digest(JSON.stringify(fileHashes)), logPath: 'generation.log', sourceInspection: { tarball: release.tarball, integrity: release.integrity, bundledFile: 'package/lib/node_modules/@pnpm/config/lib/index.js', option: 'shared-workspace-shrinkwrap' } }, null, 2)}\n`,
    )
    return { directory: destination, match }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}
export async function discoverFixtures(probes: Probe[]): Promise<void> {
  const stableProbes = probes.filter((probe) => isStableVersion(probe.version))
  if (!stableProbes.length) return
  const catalogText = await readFile(catalogPath, 'utf8')
  const catalog = JSON.parse(catalogText) as Catalog
  await mkdir(discovery, { recursive: true })
  await writeFile(
    join(discovery, 'catalog-receipt.json'),
    `${JSON.stringify({ path: relative(discovery, catalogPath), sha256: digest(catalogText), generatedAt: catalog.generatedAt, sources: catalog.sources }, null, 2)}\n`,
  )
  let index = 0
  const completed: Array<{ probe: Probe; match?: Fixture['match']; fixtureId?: string; status: string; log: string }> =
    []
  async function worker(): Promise<void> {
    for (;;) {
      const probe = stableProbes.at(index++)
      if (!probe) return
      const probeId = `${probe.manager}-${probe.version}-${probe.lock}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
      const directory = join(discovery, 'probes', probeId)
      const candidate = join(directory, 'candidate')
      await mkdir(directory, { recursive: true })
      const temporary = await mkdtemp(join(tmpdir(), 'toolchain-discovery-'))
      console.log(`Probe ${probe.manager}@${probe.version} ${probe.lock}`)
      try {
        const release = catalog.managers[probe.manager].find((item) => item.version === probe.version)
        if (!release) throw new Error('Exact release is absent from frozen official catalog')
        const node = selectHistoricalNode(release, catalog)
        const options: ProvisionOptions = {
          cacheDirectory: join(root, '.cache/maintenance'),
          nodeArch:
            process.platform === 'darwin' && semver.major(node) < 16 ? 'x64' : (process.arch as 'arm64' | 'x64'),
          bootstrapDependencies: true,
          timeoutMs: 120_000,
        }
        const recipe: Fixture = {
          id: probeId,
          manager: probe.manager,
          version: probe.version,
          directory: relative(discovery, candidate),
          lock: probe.lock,
          match: {},
          dependencies: { 'is-number': '7.0.0' },
          node,
        }
        let generated: Awaited<ReturnType<typeof generateFixture>>
        let collectorSupported = probe.lock !== 'shrinkwrap.yaml'
        try {
          generated = probe.sharedWorkspace
            ? await generateSharedLegacy(recipe, catalog, candidate, options)
            : await generateFixture(recipe, catalog, candidate, options)
        } catch (error) {
          if (probe.manager !== 'pnpm' || probe.lock !== 'shrinkwrap.yaml') throw error
          const document = parse(await readFile(join(candidate, probe.lock), 'utf8')) as { shrinkwrapVersion?: unknown }
          const format = document.shrinkwrapVersion
          if (typeof format !== 'number' && typeof format !== 'string') throw error
          generated = { directory: candidate, match: { format: String(format) } }
          collectorSupported = false
        }
        const identity = fixtureIdentity(probe, generated.match)
        const fixture: Fixture = { ...recipe, ...identity, match: generated.match }
        const tool = await provision(probe.manager, release, catalog, join(temporary, 'tools'), node, options)
        const observation = await runFixture(
          { ...fixture, directory: relative(discovery, candidate) },
          tool,
          discovery,
          join(temporary, 'project'),
          discovery,
        )
        observation.bootstrap = await preserveBootstrap(observation.bootstrap, discovery)
        await writeFile(join(directory, 'observation.json'), `${JSON.stringify(observation, null, 2)}\n`)
        let adopted = { status: observation.status as string, fixtureId: fixture.id }
        if (observation.status === 'pass')
          adopted = collectorSupported
            ? await adoptFixture(fixture, candidate)
            : { status: 'unsupported-collector-pass', fixtureId: fixture.id }
        const { status } = adopted
        const result = {
          probe,
          node,
          match: generated.match,
          fixtureId: adopted.fixtureId,
          status,
          observationId: observation.id,
          collectorSupported,
          log: observation.logPath,
        }
        await writeFile(join(directory, 'result.json'), `${JSON.stringify(result, null, 2)}\n`)
        completed.push(result)
        console.log(`${probe.manager}@${probe.version}: ${JSON.stringify(generated.match)} ${status}`)
      } catch (error) {
        const result = {
          probe,
          status: 'incomplete',
          log: relative(discovery, directory),
          error: String(error),
          stack: error instanceof Error ? error.stack : undefined,
        }
        await writeFile(join(directory, 'result.json'), `${JSON.stringify(result, null, 2)}\n`)
        completed.push(result)
        console.log(`${probe.manager}@${probe.version}: incomplete ${String(error).slice(0, 180)}`)
      } finally {
        await rm(temporary, { recursive: true, force: true })
      }
    }
  }
  await Promise.all([worker(), worker()])
  await writeFile(join(discovery, `batch-${Date.now()}.json`), `${JSON.stringify(completed, null, 2)}\n`)
}
let adoption: Promise<void> = Promise.resolve()
function adoptFixture(fixture: Fixture, candidate: string): Promise<{ status: string; fixtureId: string }> {
  const pending = adoption.then(async () => {
    const path = join(root, 'fixtures/recipes.json')
    const recipes = JSON.parse(await readFile(path, 'utf8')) as Fixture[]
    const known = recipes.find(
      (item) => item.manager === fixture.manager && JSON.stringify(item.match) === JSON.stringify(fixture.match),
    )
    if (known) return { status: 'known-format-pass', fixtureId: known.id }
    const destination = join(root, 'fixtures', fixture.directory)
    await cp(candidate, destination, { recursive: true, errorOnExist: true, force: false })
    const receipt = JSON.parse(await readFile(join(destination, 'receipt.json'), 'utf8')) as {
      bootstrap?: BootstrapReceipt
    }
    receipt.bootstrap = await preserveBootstrap(receipt.bootstrap, destination)
    await writeFile(join(destination, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`)
    recipes.push(fixture)
    await writeFile(path, `${JSON.stringify(recipes, null, 2)}\n`)
    return { status: 'added', fixtureId: fixture.id }
  })
  adoption = pending.then(
    () => {},
    () => {},
  )
  return pending
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const probes = process.argv.slice(2).map((argument) => {
    const [tool, specifiedLock, mode] = argument.split(':')
    const [manager, version] = tool.split('@')
    if (!['npm', 'pnpm', 'yarn'].includes(manager) || !version || !semver.valid(version))
      throw new Error(`Use manager@exact-version:lockfile, received ${argument}`)
    let lock = 'yarn.lock'
    if (manager === 'npm') lock = 'npm-shrinkwrap.json'
    if (manager === 'pnpm') lock = 'pnpm-lock.yaml'
    if (specifiedLock) lock = specifiedLock
    return { manager: manager as Manager, version, lock, sharedWorkspace: mode === 'shared' }
  })
  discoverFixtures(probes).catch((error: unknown) => {
    console.error(error)
    process.exitCode = 2
  })
}
