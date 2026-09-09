import semver from 'semver'

import { type MANAGERS, normalizeSource } from './constraints.js'
import { errorMessage, object, optionalObject } from './validation.js'
import { isStableVersion, prereleaseCores } from './versions.js'
import { createWarning } from './warnings.js'

import type {
  Catalog,
  CatalogOptions,
  Fetcher,
  ManagerRelease,
  NodeRelease,
  Source,
  SourceReceipt,
  Warning,
} from './types.js'

export const OFFICIAL_SOURCES = [
  { id: 'node', url: 'https://nodejs.org/dist/index.json' },
  { id: 'npm', url: 'https://registry.npmjs.org/npm' },
  { id: 'pnpm', url: 'https://registry.npmjs.org/pnpm' },
  { id: 'yarn-classic', url: 'https://registry.npmjs.org/yarn' },
  { id: 'yarn-berry', url: 'https://registry.npmjs.org/@yarnpkg%2Fcli-dist' },
  { id: 'yarn-cli', url: 'https://registry.npmjs.org/@yarnpkg%2Fcli' },
  { id: 'yarn-tags', url: 'https://repo.yarnpkg.com/tags' },
  { id: 'yarn-zpm', url: 'https://repo.yarnpkg.com/releases' },
] as const
interface Entry {
  nodes?: NodeRelease[]
  managers?: ManagerRelease[]
  receipt: SourceReceipt
}
interface FetchResult {
  entry: Entry
  warning?: Warning
}
interface Cache {
  entries: Map<string, Entry>
  pending: Map<string, Promise<FetchResult>>
}
const caches = new WeakMap<Fetcher, Cache>()
const defaultFetcher: Fetcher = (url, options) => fetch(url, options)

export class MetadataError extends Error {
  readonly code = 'metadata-unavailable'
  constructor(
    message: string,
    readonly failures: string[],
  ) {
    super(message)
    this.name = 'MetadataError'
  }
}
type VersionSelection = string | ((version: string) => boolean)
function selectsVersion(version: string, selection?: VersionSelection) {
  if (typeof selection === 'function') return selection(version)
  return selection ? version === selection : isStableVersion(version)
}

export function parseNodes(value: unknown, selection?: VersionSelection): NodeRelease[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('Node index: expected a nonempty release array.')
  return value.flatMap((item): NodeRelease[] => {
    const row = object(item, 'Node release')
    const version = typeof row.version === 'string' && semver.valid(row.version)
    if (!version) throw new Error(`Node index: invalid version ${String(row.version)}`)
    if (!selectsVersion(version, selection)) return []
    const npm =
      row.npm === null || row.npm === undefined || row.npm === ''
        ? null
        : typeof row.npm === 'string' && semver.valid(row.npm)
    if (npm === false || (npm === null && row.npm !== null && row.npm !== undefined && row.npm !== ''))
      throw new Error(`Node ${version}: invalid npm version ${String(row.npm)}`)
    return [
      {
        version,
        npm,
        lts: typeof row.lts === 'string' ? row.lts : false,
        ...(typeof row.date === 'string' ? { date: row.date } : {}),
      },
    ]
  })
}
export function parseRegistry(
  value: unknown,
  source: { id: string; url: string },
  selection?: VersionSelection,
): ManagerRelease[] {
  const data = object(value, source.id)
  const versions = object(data.versions, `${source.id}.versions`)
  if (!Object.keys(versions).length) throw new Error(`${source.id}: no published versions in response.`)
  const times = optionalObject(data.time)
  const records: ManagerRelease[] = []
  for (const [key, item] of Object.entries(versions)) {
    const version = semver.valid(key)
    if (!version) throw new Error(`${source.id}: invalid published version key ${key}`)
    if (!selectsVersion(version, selection)) continue
    if ((source.id === 'yarn-berry' || source.id === 'yarn-cli') && semver.major(version) < 2) continue
    const manifest = object(item, `${source.id}@${key}`)
    if (manifest.version !== key)
      throw new Error(`${source.id}: registry key ${key} differs from manifest.version ${String(manifest.version)}`)
    const engines = optionalObject(manifest.engines)
    const declared = 'node' in engines
    const raw = engines.node
    if (declared && (typeof raw !== 'string' || !semver.validRange(raw)))
      throw new Error(`${source.id}@${key}: invalid engines.node ${String(raw)}`)
    const dist = optionalObject(manifest.dist)
    records.push({
      version,
      node: declared ? String(raw) : null,
      sourceUrl: source.url,
      ...(typeof times[key] === 'string' ? { releasedAt: times[key] } : {}),
      ...(source.id !== 'yarn-cli' && typeof dist.tarball === 'string' ? { tarball: dist.tarball } : {}),
      ...(source.id !== 'yarn-cli' && typeof dist.integrity === 'string' ? { integrity: dist.integrity } : {}),
    })
  }
  return records.sort((a, b) => semver.rcompare(a.version, b.version))
}
function parseTags(value: unknown, url: string, selection?: VersionSelection): ManagerRelease[] {
  const data = object(value, 'Yarn tags')
  if (!Array.isArray(data.tags) || !data.tags.length) throw new Error('Yarn tags: expected a nonempty version array')
  return [...new Set(data.tags)].flatMap((version: unknown): ManagerRelease[] => {
    if (typeof version !== 'string' || !semver.valid(version))
      throw new Error(`Yarn tags: invalid version ${String(version)}`)
    return selectsVersion(version, selection) ? [{ version, node: null, sourceUrl: url }] : []
  })
}
function parseNativeYarn(value: unknown, url: string, selection?: VersionSelection): ManagerRelease[] {
  const data = object(value, 'Yarn native releases')
  const lines = object(data.releaseLines, 'Yarn native releaseLines')
  const zpm = object(lines.zpm, 'Yarn zpm release line')
  if (!Array.isArray(zpm.tags)) throw new Error('Yarn zpm: expected a version array in tags.')
  const versions = [...zpm.tags, ...[zpm.stable, zpm.canary].filter((version) => version !== undefined)]
  return [...new Set(versions)]
    .flatMap((version: unknown): ManagerRelease[] => {
      if (typeof version !== 'string' || semver.valid(version) !== version || semver.major(version) < 6)
        throw new Error(`Yarn zpm: invalid native version ${String(version)}`)
      // Channel labels may point to an RC. Stability is a property of the version itself.
      return selectsVersion(version, selection) ? [{ version, node: '*', runtime: 'native', sourceUrl: url }] : []
    })
    .sort((a, b) => semver.rcompare(a.version, b.version))
}
async function browserHash(body: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(body))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
function withSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const abort = () => {
      reject(signal.reason)
    }
    signal.addEventListener('abort', abort, { once: true })
    promise
      .then(resolve, reject)
      .finally(() => {
        signal.removeEventListener('abort', abort)
      })
      .catch(() => {})
  })
}
interface MetadataOptions extends CatalogOptions {
  hash?: (body: string) => Promise<string>
}

function createLoader({ fetcher = defaultFetcher, signal, onSource, hash = browserHash }: MetadataOptions = {}) {
  if (signal?.aborted) throw signal.reason
  let cache = caches.get(fetcher)
  if (!cache) {
    cache = { entries: new Map(), pending: new Map() }
    caches.set(fetcher, cache)
  }
  const activeCache = cache
  const load = async (
    source: { id: string; url: string },
    parser?: (data: unknown) => Pick<Entry, 'nodes' | 'managers'>,
  ): Promise<FetchResult> => {
    onSource?.({ ...source, status: 'loading' })
    const key = `${source.id}:${source.url}`
    let request = activeCache.pending.get(key)
    if (!request) {
      request = (async (): Promise<FetchResult> => {
        const previous = activeCache.entries.get(key)
        try {
          const headers: Record<string, string> = { Accept: 'application/json' }
          if (previous?.receipt.etag) headers['If-None-Match'] = previous.receipt.etag
          if (previous?.receipt.lastModified) headers['If-Modified-Since'] = previous.receipt.lastModified
          const response = await fetcher(source.url, { headers, signal: AbortSignal.timeout(20_000) })
          const now = new Date().toISOString()
          if (response.status === 304) {
            if (!previous) throw new Error(`${source.id}: HTTP 304 without a cached response.`)
            const entry = { ...previous, receipt: { ...previous.receipt, checkedAt: now } }
            activeCache.entries.set(key, entry)
            return { entry }
          }
          if (!response.ok) throw new Error(`${source.id}: HTTP ${response.status}`)
          const body = await response.text()
          let data: unknown
          try {
            data = JSON.parse(body)
          } catch {
            throw new Error(`${source.id}: invalid JSON response.`)
          }
          const receipt: SourceReceipt = { ...source, fetchedAt: now, checkedAt: now, sha256: await hash(body) }
          const etag = response.headers.get('etag')
          const modified = response.headers.get('last-modified')
          if (etag) receipt.etag = etag
          if (modified) receipt.lastModified = modified
          const entry: Entry = { receipt }
          if (parser) Object.assign(entry, parser(data))
          else if (source.id === 'node') entry.nodes = parseNodes(data)
          else if (source.id === 'yarn-tags') entry.managers = parseTags(data, source.url)
          else if (source.id === 'yarn-zpm') entry.managers = parseNativeYarn(data, source.url)
          else entry.managers = parseRegistry(data, source)
          activeCache.entries.set(key, entry)
          return { entry }
        } catch (error) {
          if (!previous) throw error
          return {
            entry: previous,
            warning: createWarning(
              'stale-metadata',
              {
                source: source.id,
                detail: errorMessage(error),
                fetchedAt: previous.receipt.fetchedAt,
              },
              { path: source.url, fetchedAt: previous.receipt.fetchedAt },
            ),
          }
        }
      })()
      activeCache.pending.set(key, request)
      request
        .finally(() => {
          activeCache.pending.delete(key)
        })
        .catch(() => {})
    }
    try {
      const result = await withSignal(request, signal)
      onSource?.({
        ...source,
        status: result.warning ? 'stale' : 'ready',
        count: result.entry.nodes?.length ?? result.entry.managers?.length,
        fetchedAt: result.entry.receipt.fetchedAt,
      })
      return result
    } catch (error) {
      onSource?.({ ...source, status: 'error', error: errorMessage(error) })
      throw error
    }
  }
  return load
}

export async function fetchMetadata(options: MetadataOptions = {}): Promise<Catalog> {
  const { signal } = options
  const load = createLoader(options)
  const results = await Promise.allSettled(OFFICIAL_SOURCES.map((source) => load(source)))
  if (signal?.aborted) throw signal.reason
  const failures = results.flatMap((result) => (result.status === 'rejected' ? [errorMessage(result.reason)] : []))
  if (failures.length) throw new MetadataError(failures.join('; '), failures)
  const values = results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []))
  const entries = new Map(values.map((value) => [value.entry.receipt.id, value.entry]))
  // Native releases have their own official channel; Berry tags fill registry omissions.
  const yarn = new Map(
    [
      ...(entries.get('yarn-cli')?.managers ?? []),
      ...(entries.get('yarn-classic')?.managers ?? []),
      ...(entries.get('yarn-berry')?.managers ?? []),
      ...(entries.get('yarn-zpm')?.managers ?? []),
    ].map((release) => [release.version, release]),
  )
  const tagWarnings: Warning[] = []
  await Promise.all(
    (entries.get('yarn-tags')?.managers ?? [])
      .filter((release) => !yarn.has(release.version))
      .map(async (release) => {
        const url = `https://raw.githubusercontent.com/yarnpkg/berry/${encodeURIComponent(`@yarnpkg/cli/${release.version}`)}/packages/yarnpkg-cli/package.json`
        yarn.set(release.version, release)
        try {
          const result = await load({ id: `yarn-tag-${release.version}`, url }, (data) => {
            const manifest = object(data, `Yarn ${release.version} manifest`)
            if (manifest.version !== release.version)
              throw new Error(`Yarn ${release.version}: mismatched tag manifest version`)
            const { node } = optionalObject(manifest.engines)
            if (node !== undefined && (typeof node !== 'string' || !semver.validRange(node)))
              throw new Error(`Yarn ${release.version}: invalid tag manifest engines.node`)
            return {
              managers: [{ version: release.version, node: typeof node === 'string' ? node : null, sourceUrl: url }],
            }
          })
          values.push(result)
          const resolved = result.entry.managers![0]
          yarn.set(release.version, resolved)
          if (resolved.node === null)
            tagWarnings.push(createWarning('missing-yarn-tag-engines', { version: release.version }, { path: url }))
        } catch (error) {
          if (signal?.aborted) throw signal.reason
          tagWarnings.push(
            createWarning(
              'unavailable-yarn-tag-manifest',
              {
                version: release.version,
                detail: errorMessage(error),
              },
              { path: url },
            ),
          )
        }
      }),
  )
  if (signal?.aborted) throw signal.reason
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sources: values.map((v) => v.entry.receipt),
    nodes: entries.get('node')?.nodes ?? [],
    managers: {
      npm: entries.get('npm')?.managers ?? [],
      pnpm: entries.get('pnpm')?.managers ?? [],
      yarn: [...yarn.values()].sort((a, b) => semver.rcompare(a.version, b.version)),
    },
    warnings: [...values.flatMap((value) => (value.warning ? [value.warning] : [])), ...tagWarnings],
  }
}

/** Add prereleases admitted by explicit declarations. Ordinary catalog fetching stays stable-only. */
export async function fetchExplicitMetadata(
  catalog: Catalog,
  sources: Source[],
  options: MetadataOptions = {},
): Promise<Catalog> {
  const load = createLoader(options)
  const requests = new Map<
    string,
    { source: Source; target: 'node' | 'manager'; manager: (typeof MANAGERS)[number]; version: string }
  >()
  for (const [index, source] of sources.entries()) {
    try {
      const normalized = normalizeSource({ ...source, index }, [], [])
      if (normalized.lockfile || !prereleaseCores(normalized.range).length) continue
      const version = normalized.exact ?? normalized.range
      const target = normalized.target === 'node' ? 'node' : 'manager'
      const { manager } = normalized
      if ((target === 'node' ? catalog.nodes : catalog.managers[manager]).some((row) => row.version === version))
        continue
      const id = `${target === 'node' ? 'node' : manager}@${version}`
      if (!requests.has(id)) requests.set(id, { source, target, manager, version })
    } catch {
      // Declaration validation and conflict warnings belong to the resolver.
    }
  }
  if (!requests.size) return catalog
  const result: Catalog = {
    ...catalog,
    nodes: [...catalog.nodes],
    managers: { npm: [...catalog.managers.npm], pnpm: [...catalog.managers.pnpm], yarn: [...catalog.managers.yarn] },
    sources: [...catalog.sources],
    warnings: [...catalog.warnings],
  }
  await Promise.all(
    [...requests].map(async ([id, { source, target, manager, version }]) => {
      try {
        let fetched: FetchResult | undefined
        if (!semver.valid(version)) {
          const selected = (candidate: string) => !isStableVersion(candidate) && semver.satisfies(candidate, version)
          const cores = prereleaseCores(version)
          const endpoints: Array<{ id: string; url: string }> = []
          if (target === 'node') {
            endpoints.push(
              ...OFFICIAL_SOURCES.filter((endpoint) => endpoint.id === 'node'),
              ...['rc', 'nightly', 'v8-canary', 'test'].map((channel) => ({
                id: `node-${channel}`,
                url: `https://nodejs.org/download/${channel}/index.json`,
              })),
            )
          } else if (manager !== 'yarn') {
            endpoints.push({ id: manager, url: `https://registry.npmjs.org/${manager}` })
          } else {
            if (cores.some((core) => semver.major(core) < 2))
              endpoints.push(...OFFICIAL_SOURCES.filter((endpoint) => endpoint.id === 'yarn-classic'))
            if (cores.some((core) => semver.major(core) >= 2 && semver.major(core) < 6))
              for (const sourceId of ['yarn-cli', 'yarn-classic', 'yarn-berry', 'yarn-tags'])
                endpoints.push(...OFFICIAL_SOURCES.filter((endpoint) => endpoint.id === sourceId))
            if (cores.some((core) => semver.major(core) >= 6))
              endpoints.push(...OFFICIAL_SOURCES.filter((endpoint) => endpoint.id === 'yarn-zpm'))
          }
          const entries = await Promise.all(
            [...new Map(endpoints.map((endpoint) => [endpoint.id, endpoint])).values()].map(async (endpoint) => {
              const entry = await load({ id: `explicit-${id}-${endpoint.id}`, url: endpoint.url }, (data) => {
                if (target === 'node') return { nodes: parseNodes(data, selected) }
                if (endpoint.id === 'yarn-zpm') return { managers: parseNativeYarn(data, endpoint.url, selected) }
                const registrySelected = (candidate: string) =>
                  selected(candidate) && (manager !== 'yarn' || semver.major(candidate) < 6)
                if (endpoint.id === 'yarn-tags') return { managers: parseTags(data, endpoint.url, registrySelected) }
                return { managers: parseRegistry(data, endpoint, registrySelected) }
              })
              return { endpoint, ...entry }
            }),
          )
          const managers = new Map(
            entries
              .filter((entry) => entry.endpoint.id !== 'yarn-tags')
              .flatMap((entry) => (entry.entry.managers ?? []).map((release) => [release.version, release] as const)),
          )
          const tags = entries
            .filter((entry) => entry.endpoint.id === 'yarn-tags')
            .flatMap((entry) => entry.entry.managers ?? [])
            .filter((release) => !managers.has(release.version))
          const manifests = await Promise.all(
            tags.map(async (release) => {
              const url = `https://raw.githubusercontent.com/yarnpkg/berry/${encodeURIComponent(`@yarnpkg/cli/${release.version}`)}/packages/yarnpkg-cli/package.json`
              return load({ id: `explicit-yarn@${release.version}-manifest`, url }, (data) => {
                const manifest = object(data, `Yarn ${release.version} tag manifest`)
                if (manifest.name !== '@yarnpkg/cli' || manifest.version !== release.version)
                  throw new Error(`Yarn ${release.version}: mismatched tag manifest identity.`)
                return {
                  managers: parseRegistry(
                    { versions: { [release.version]: manifest } },
                    { id: 'yarn-cli', url },
                    release.version,
                  ),
                }
              })
            }),
          )
          for (const entry of manifests)
            for (const release of entry.entry.managers ?? []) managers.set(release.version, release)
          const values = [...entries, ...manifests]
          result.nodes.push(...values.flatMap((entry) => entry.entry.nodes ?? []))
          result.managers[manager].push(...managers.values())
          result.sources.push(...values.map((entry) => entry.entry.receipt))
          result.warnings.push(...values.flatMap((entry) => (entry.warning ? [entry.warning] : [])))
          return
        } else if (target === 'node') {
          let channel = 'rc'
          if (version.includes('nightly')) channel = 'nightly'
          else if (version.includes('v8-canary')) channel = 'v8-canary'
          else if (version.includes('-test')) channel = 'test'
          const url = `https://nodejs.org/download/${channel}/index.json`
          fetched = await load({ id: `explicit-${id}`, url }, (data) => {
            const nodes = parseNodes(data, version)
            if (!nodes.length) throw new Error(`Node ${version} is absent from the official ${channel} index.`)
            return { nodes }
          })
          result.nodes.push(...(fetched.entry.nodes ?? []))
        } else if (manager === 'yarn' && semver.major(version) >= 6) {
          const url = 'https://repo.yarnpkg.com/releases'
          fetched = await load({ id: `explicit-${id}-zpm`, url }, (data) => {
            const managers = parseNativeYarn(data, url, version)
            if (!managers.length) throw new Error(`Yarn ${version} is absent from the official native release line.`)
            return { managers }
          })
          result.managers.yarn.push(...(fetched.entry.managers ?? []))
        } else {
          const names =
            manager === 'yarn' && semver.major(version) >= 2 ? ['@yarnpkg/cli-dist', 'yarn', '@yarnpkg/cli'] : [manager]
          const failures: string[] = []
          for (const name of names) {
            const url = `https://registry.npmjs.org/${name.replace('/', '%2F')}/${encodeURIComponent(version)}`
            try {
              fetched = await load({ id: `explicit-${id}-${name}`, url }, (data) => {
                const manifest = object(data, `${name}@${version}`)
                if (manifest.name !== name || manifest.version !== version)
                  throw new Error(`${name}@${version}: mismatched registry manifest identity.`)
                let parserId: string = manager
                if (name === '@yarnpkg/cli') parserId = 'yarn-cli'
                else if (name === '@yarnpkg/cli-dist') parserId = 'yarn-berry'
                return {
                  managers: parseRegistry({ versions: { [version]: manifest } }, { id: parserId, url }, version),
                }
              })
              break
            } catch (error) {
              if (options.signal?.aborted) throw options.signal.reason
              failures.push(errorMessage(error))
            }
          }
          if (!fetched && manager === 'yarn' && semver.major(version) >= 2) {
            const url = 'https://repo.yarnpkg.com/tags'
            const tag = await load({ id: `explicit-${id}-tag`, url }, (data) => {
              const managers = parseTags(data, url, version)
              if (!managers.length) throw new Error(`Yarn ${version} is absent from the official version list.`)
              return { managers }
            })
            result.sources.push(tag.entry.receipt)
            if (tag.warning) result.warnings.push(tag.warning)
            const manifestUrl = `https://raw.githubusercontent.com/yarnpkg/berry/${encodeURIComponent(`@yarnpkg/cli/${version}`)}/packages/yarnpkg-cli/package.json`
            fetched = await load({ id: `explicit-${id}-manifest`, url: manifestUrl }, (data) => {
              const manifest = object(data, `Yarn ${version} tag manifest`)
              if (manifest.name !== '@yarnpkg/cli' || manifest.version !== version)
                throw new Error(`Yarn ${version}: mismatched tag manifest identity.`)
              return {
                managers: parseRegistry(
                  { versions: { [version]: manifest } },
                  { id: 'yarn-cli', url: manifestUrl },
                  version,
                ),
              }
            })
          }
          if (!fetched) throw new Error(failures.join('; '))
          result.managers[manager].push(...(fetched.entry.managers ?? []))
        }
        result.sources.push(fetched.entry.receipt)
        if (fetched.warning) result.warnings.push(fetched.warning)
      } catch (error) {
        if (options.signal?.aborted) throw options.signal.reason
        result.warnings.push(
          createWarning(
            'explicit-version-unavailable',
            {
              id,
              detail: errorMessage(error),
            },
            { sourceId: source.id, path: source.path },
          ),
        )
      }
    }),
  )
  result.nodes = [...new Map(result.nodes.map((release) => [release.version, release])).values()]
  for (const name of ['npm', 'pnpm', 'yarn'] as const)
    result.managers[name] = [...new Map(result.managers[name].map((release) => [release.version, release])).values()]
  result.sources = [...new Map(result.sources.map((receipt) => [receipt.id, receipt])).values()]
  return result
}
