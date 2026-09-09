import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { validateCatalog } from '../src/data-validation.js'
import { isStableVersion } from '../src/versions.js'

import { enrichYarnCatalog, type EnrichYarnOptions, type EnrichYarnSummary } from './enrich-yarn-catalog.js'
import { digest } from './model.js'
import { isNativeYarnRelease } from './provision.js'

import type { Catalog, ManagerRelease } from '../src/types.js'

export type YarnEnricher = (options: EnrichYarnOptions) => Promise<EnrichYarnSummary>
export interface YarnArtifactOptions {
  catalog: Catalog
  stateDirectory: string
  seedDirectories: string[]
  enrich?: YarnEnricher
}
interface Diagnostic {
  version: string
  integrity?: string
  message: string
}
const identity = (release: ManagerRelease): string =>
  JSON.stringify({
    integrity: release.integrity,
    url: release.bundle?.url,
    commit: release.bundle?.commit,
    tag: release.bundle?.tag,
    size: release.bundle?.size,
  })
function validBundle(release: ManagerRelease): boolean {
  const { bundle, integrity } = release
  return Boolean(
    bundle
    && !release.tarball
    && integrity
    && /^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity)
    && Buffer.from(integrity.slice(7), 'base64').length === 64
    && /^[a-f\d]{40}$/.test(bundle.commit)
    && bundle.tag === `@yarnpkg/cli/${release.version}`
    && Number.isSafeInteger(bundle.size)
    && bundle.size > 0
    && bundle.url
      === `https://raw.githubusercontent.com/yarnpkg/berry/${bundle.commit}/packages/yarnpkg-cli/bin/yarn.js`,
  )
}
async function immutable(path: string, raw: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  try {
    await writeFile(path, raw, { flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    if ((await readFile(path, 'utf8')) !== raw) throw new Error(`Refusing to overwrite ${path}`, { cause: error })
  }
}
async function files(path: string): Promise<string[]> {
  try {
    return (await readdir(path))
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => join(path, name))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}
/** Fresh registry metadata remains authoritative. Reused bundle identities are explicit artifacts,
 * never registry tarballs/SRIs. Prior catalog bytes and all new enrichment attempts are immutable.
 * Conflicting artifacts and failed version checks remain visible across subsequent monitor runs.
 */
export async function prepareYarnArtifacts(
  options: YarnArtifactOptions,
): Promise<{ catalog: Catalog; incomplete: string[] }> {
  if (!options.catalog.managers.yarn.length) return { catalog: options.catalog, incomplete: [] }
  const directory = join(options.stateDirectory, 'yarn-artifacts')
  const archives = join(directory, 'catalogs')
  const diagnosticsDirectory = join(directory, 'diagnostics')
  const incomplete: string[] = []
  const snapshots: Catalog[] = []
  const archivePaths: string[] = []
  async function archiveCatalog(path: string): Promise<void> {
    try {
      const raw = await readFile(path, 'utf8')
      const catalog = validateCatalog(JSON.parse(raw))
      const archived = join(archives, `${digest(raw)}.json`)
      await immutable(archived, raw)
      snapshots.push(catalog)
      archivePaths.push(archived)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        incomplete.push(`Yarn artifact catalog ${path}: ${String(error)}`)
    }
  }
  async function preserveFailure(diagnostic: Diagnostic): Promise<void> {
    const raw = JSON.stringify(diagnostic)
    await immutable(join(diagnosticsDirectory, `${digest(raw)}.json`), raw)
  }
  const paths = [
    ...(await files(archives)),
    join(options.stateDirectory, 'catalog.json'),
    ...options.seedDirectories.map((seed) => join(seed, 'catalog.json')),
  ]
  for (const path of new Set(paths)) await archiveCatalog(path)
  for (const seed of options.seedDirectories) {
    try {
      const report = JSON.parse(await readFile(join(seed, 'report.json'), 'utf8')) as {
        failures?: Array<{ version: string; error: string }>
      }
      if (!Array.isArray(report.failures)) continue
      const source = validateCatalog(JSON.parse(await readFile(join(seed, 'catalog.json'), 'utf8')))
      for (const failure of report.failures) {
        const release = source.managers.yarn.find((item) => item.version === failure.version)
        if (isStableVersion(failure.version) && release?.bundle)
          await preserveFailure({ version: failure.version, integrity: release.integrity, message: failure.error })
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        incomplete.push(`Yarn artifact diagnostics ${seed}: ${String(error)}`)
    }
  }
  const blocked = new Set<string>()
  const sources = new Map(options.catalog.sources.map((source) => [`${source.url}:${source.sha256}`, source]))
  const yarn = options.catalog.managers.yarn
    .filter((release) => isStableVersion(release.version))
    .map((fresh) => {
      if (fresh.runtime === 'native') {
        if (!isNativeYarnRelease(fresh)) {
          blocked.add(fresh.version)
          incomplete.push(`yarn@${fresh.version}: invalid official native release descriptor`)
        }
        return fresh
      }
      if (fresh.tarball) return fresh
      const candidates = [
        fresh,
        ...snapshots.flatMap((snapshot) =>
          snapshot.managers.yarn.filter((release) => release.version === fresh.version),
        ),
      ].filter((release) => release.bundle)
      for (const candidate of candidates)
        if (!validBundle(candidate)) {
          blocked.add(fresh.version)
          incomplete.push(`yarn@${fresh.version}: invalid immutable bundle identity in saved catalog`)
        }
      const identities = new Map(candidates.filter(validBundle).map((release) => [identity(release), release]))
      if (identities.size > 1) {
        blocked.add(fresh.version)
        incomplete.push(
          `yarn@${fresh.version}: conflicting immutable bundle artifacts ${[...identities.keys()].join(' versus ')}`,
        )
      }
      if (blocked.has(fresh.version)) return fresh
      const saved = [...identities.values()].at(0)
      if (!saved) return fresh
      for (const snapshot of snapshots)
        for (const source of snapshot.sources)
          if (source.url === saved.bundle!.url) sources.set(`${source.url}:${source.sha256}`, source)
      return { ...fresh, bundle: saved.bundle, integrity: saved.integrity }
    })
  let catalog: Catalog = {
    ...options.catalog,
    sources: [...sources.values()],
    managers: { ...options.catalog.managers, yarn },
  }
  const missing = yarn
    .filter(
      (release) =>
        !isNativeYarnRelease(release)
        && !blocked.has(release.version)
        && (!release.integrity || (!release.tarball && !release.bundle)),
    )
    .map((release) => release.version)
  if (missing.length) {
    const output = join(directory, 'enrichment', randomUUID())
    try {
      const report = await (options.enrich ?? enrichYarnCatalog)({
        catalog,
        output,
        versions: missing,
        cacheDirectory: join(directory, 'cache'),
      })
      await archiveCatalog(join(output, 'catalog.json'))
      const enriched = validateCatalog(JSON.parse(await readFile(join(output, 'catalog.json'), 'utf8')))
      const supplied = new Map(enriched.managers.yarn.map((release) => [release.version, release]))
      catalog = {
        ...catalog,
        sources: [
          ...catalog.sources,
          ...enriched.sources.filter(
            (source) => !catalog.sources.some((known) => known.url === source.url && known.sha256 === source.sha256),
          ),
        ],
        managers: {
          ...catalog.managers,
          yarn: catalog.managers.yarn.map((fresh) => {
            if (!missing.includes(fresh.version)) return fresh
            const candidate = supplied.get(fresh.version)
            if (!candidate || !validBundle(candidate)) {
              incomplete.push(`yarn@${fresh.version}: enrichment did not provide an immutable executable bundle`)
              return fresh
            }
            return { ...fresh, bundle: candidate.bundle, integrity: candidate.integrity }
          }),
        },
      }
      for (const failure of report.failures)
        await preserveFailure({
          version: failure.version,
          integrity: supplied.get(failure.version)?.integrity,
          message: failure.error,
        })
      if (report.exitCode !== 0 && !report.failures.length)
        incomplete.push(`Yarn artifact enrichment incomplete; ${output}`)
    } catch (error) {
      const message = `Yarn artifact enrichment ${output}: ${String(error)}`
      incomplete.push(message)
      await immutable(join(output, 'failure.json'), JSON.stringify({ versions: missing, message }))
    }
  }
  for (const path of await files(diagnosticsDirectory)) {
    const diagnostic = JSON.parse(await readFile(path, 'utf8')) as Diagnostic
    if (
      catalog.managers.yarn.some(
        (release) =>
          release.version === diagnostic.version
          && (!diagnostic.integrity || release.integrity === diagnostic.integrity),
      )
    )
      incomplete.push(`yarn@${diagnostic.version}: preserved artifact diagnostic: ${diagnostic.message}; ${path}`)
  }
  await immutable(
    join(directory, 'runs', `${randomUUID()}.json`),
    JSON.stringify({
      catalogGeneratedAt: catalog.generatedAt,
      archives: [...new Set(archivePaths)],
      enrichedVersions: missing,
      incomplete,
    }),
  )
  return { catalog, incomplete: [...new Set(incomplete)] }
}
