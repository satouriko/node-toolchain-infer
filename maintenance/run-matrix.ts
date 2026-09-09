import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import { fetchCatalog } from '../src/catalog.js'
import { isStableVersion } from '../src/versions.js'

import { frozenControlError } from './frozen-control.js'
import { digest, type Fixture, FROZEN_PROTOCOL, mergeHistory, type Observation } from './model.js'
import { provision, type Tool } from './provision.js'
import { fixtureEnvironment, fixtureFiles, frozenArgs, hashes, runFixture, sameEnvironment } from './runner.js'

import type { Catalog } from '../src/types.js'

export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    throw error
  }
}
export async function reusableObservation(
  fixture: Fixture,
  tool: Tool,
  root: string,
  history: Observation[],
): Promise<Observation | undefined> {
  const source = join(root, fixture.directory)
  const hash = digest(JSON.stringify(await hashes(source, await fixtureFiles(source))))
  const environment = await fixtureEnvironment(fixture, source)
  return history.find(
    (item) =>
      item.protocol === FROZEN_PROTOCOL
      && sameEnvironment(item.environment, environment)
      && JSON.stringify(item.command) === JSON.stringify(frozenArgs(fixture.manager, tool.version))
      && item.fixtureHash === hash
      && item.fixtureId === fixture.id
      && item.manager === fixture.manager
      && item.version === tool.version
      && item.node === tool.nodeVersion
      && item.nodeIntegrity === tool.nodeIntegrity
      && (item.nodeArch ?? item.arch) === tool.nodeArch
      && item.toolIntegrity === tool.integrity
      && item.native?.integrity === tool.native?.integrity
      && item.native?.binarySha256 === tool.native?.binarySha256
      && item.bootstrap?.lockfileSha256 === tool.bootstrap?.lockfileSha256
      && item.platform === process.platform
      && item.arch === process.arch
      && item.status !== 'inconclusive'
      && !frozenControlError(fixture, item)
      && !(item.manager === 'yarn' && item.status === 'semantic-mismatch' && !item.semanticMethod),
  )
}
export async function runMatrix(
  root = process.cwd(),
  evidence = join(root, 'maintenance/evidence'),
): Promise<Observation[]> {
  const catalogArgument = process.argv.indexOf('--catalog')
  const catalog: Catalog =
    catalogArgument !== -1
      ? (JSON.parse(await readFile(process.argv[catalogArgument + 1], 'utf8')) as Catalog)
      : await fetchCatalog()
  const fixtureArg = process.argv.indexOf('--fixture')
  let recipes = (await readJson<Fixture[]>(join(root, 'fixtures/recipes.json'), [])).filter(
    (item) => fixtureArg === -1 || item.id === process.argv[fixtureArg + 1],
  )
  const nodeArg = process.argv.indexOf('--node')
  if (nodeArg !== -1) recipes = recipes.map((fixture) => ({ ...fixture, node: process.argv[nodeArg + 1] }))
  const versionsArg = process.argv.indexOf('--versions')
  if (versionsArg !== -1) {
    const requested = process.argv[versionsArg + 1].split(',')
    recipes = recipes.flatMap((fixture) =>
      requested
        .filter((value) => value.startsWith(`${fixture.manager}@`))
        .map((value) => ({ ...fixture, version: value.slice(fixture.manager.length + 1) })),
    )
  }
  recipes = recipes.filter((fixture) => isStableVersion(fixture.version))
  if (!recipes.length) throw new Error('No matching stable fixture releases')
  const previous = await readJson<Observation[]>(join(evidence, 'observations.json'), [])
  let history = previous
  const results: Observation[] = []
  const temporary = await mkdtemp(join(tmpdir(), 'toolchain-matrix-'))
  await mkdir(evidence, { recursive: true })
  try {
    for (const fixture of recipes) {
      const release = catalog.managers[fixture.manager].find((item) => item.version === fixture.version)
      if (!release) throw new Error(`Missing release ${fixture.manager}@${fixture.version}`)
      const tool = await provision(fixture.manager, release, catalog, join(temporary, 'tools'), fixture.node)
      const saved = await reusableObservation(fixture, tool, join(root, 'fixtures'), history)
      if (saved) {
        results.push(saved)
        console.log(`Preserved ${fixture.id}: ${saved.status}`)
        continue
      }
      const observation = await runFixture(fixture, tool, join(root, 'fixtures'), join(temporary, 'project'), evidence)
      results.push(observation)
      history = mergeHistory(history, [observation])
      await writeFile(join(evidence, 'observations.json'), `${JSON.stringify(history, null, 2)}\n`)
      console.log(`${fixture.id} ${fixture.manager}@${tool.version}: ${observation.status}`)
    }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
  return results
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runMatrix()
    .then((records) => {
      process.exitCode = 0
      if (records.some((item) => item.status !== 'pass')) process.exitCode = 1
      if (records.some((item) => item.status === 'inconclusive')) process.exitCode = 2
    })
    .catch((error: unknown) => {
      console.error(error)
      process.exitCode = 2
    })
}
