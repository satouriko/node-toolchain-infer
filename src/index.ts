import { fetchCatalog, fetchExplicitCatalog, loadRules, MetadataError } from './catalog.js'
import { collect } from './collect.js'
import { MANAGERS } from './constraints.js'
import { managerCandidates, managerForSource, mayChangeSelection } from './metadata-plan.js'
import { resolve } from './resolve.js'
import { detectRuntime } from './runtime.js'
import { errorMessage } from './validation.js'
import { createWarning } from './warnings.js'

import type {
  Catalog,
  CatalogOptions,
  CollectOptions,
  CompatibilityRule,
  Manager,
  ResolveResult,
  Runtime,
  Warning,
} from './types.js'

export { fetchCatalog, loadCatalog, loadRules, MetadataError, OFFICIAL_SOURCES } from './catalog.js'
export { collect } from './collect.js'
export { resolve } from './resolve.js'
export { detectRuntime } from './runtime.js'
export { createSource, SOURCE_DEFINITIONS } from './sources.js'
export * from './types.js'
export { formatWarning } from './warnings.js'
export type { RuntimeDetection, RuntimeOptions } from './runtime.js'
export type { WarningCode, WarningLocale, WarningParamsByCode } from './warnings.js'
export interface InferOptions extends CollectOptions, Omit<CatalogOptions, 'tools' | 'allowPartial'> {
  runtime?: Runtime
  catalog?: Catalog
  rules?: CompatibilityRule[]
}
export interface InferResult extends ResolveResult {
  directories: string[]
  root: string
}
export async function infer(options: InferOptions = {}): Promise<InferResult> {
  const warnings: Warning[] = []
  const [collection, rules] = await Promise.all([collect(options), options.rules ?? loadRules()])
  const possibleManagers = managerCandidates(collection.sources, rules)
  const loaded = new Set<Manager>([possibleManagers[0]])
  const load = async (tools: Array<'node' | Manager>, previous?: Catalog): Promise<Catalog> => {
    const fetched = await fetchCatalog({ ...options, tools, allowPartial: true }).catch((error: unknown): Catalog => {
      if (options.signal?.aborted) throw options.signal.reason
      const failures = error instanceof MetadataError ? error.diagnostics : []
      return {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        nodes: [],
        managers: { npm: [], pnpm: [], yarn: [] },
        sources: [],
        warnings: failures.length
          ? failures.map((failure, index) =>
              createWarning(
                'metadata-source-unavailable',
                {
                  source: failure.sourceId,
                  detail: error instanceof MetadataError ? error.failures[index] : errorMessage(error),
                },
                { path: failure.url, requestFailures: [failure] },
              ),
            )
          : [createWarning('metadata-unavailable', { detail: errorMessage(error) })],
      }
    })
    if (previous) {
      fetched.nodes.unshift(...previous.nodes)
      for (const manager of MANAGERS) fetched.managers[manager].unshift(...previous.managers[manager])
      fetched.sources.unshift(...previous.sources)
      fetched.warnings.unshift(...previous.warnings)
    }
    const sources = collection.sources.filter((source) => {
      if (source.target === 'node') return tools.includes('node')
      const manager = managerForSource(source, rules)
      return manager !== undefined && tools.includes(manager)
    })
    return fetchExplicitCatalog(fetched, sources, options)
  }
  let catalog = options.catalog ?? (await load(['node', possibleManagers[0]]))
  const detected = options.runtime
    ? { runtime: options.runtime, warnings: [] }
    : await detectRuntime({ catalog, cwd: collection.directories[0] })
  let result = resolve({ sources: collection.sources, runtime: detected.runtime }, catalog, rules)
  if (!options.catalog) {
    for (;;) {
      const current = result
      const next = possibleManagers.find((manager) => !loaded.has(manager) && mayChangeSelection(manager, current))
      if (!next) break
      loaded.add(next)
      catalog = await load([next], catalog)
      result = resolve({ sources: collection.sources, runtime: detected.runtime }, catalog, rules)
    }
    if (!catalog.sources.length) {
      const failures = catalog.warnings.filter((warning) => warning.code === 'metadata-source-unavailable')
      if (failures.length) {
        warnings.push(
          createWarning(
            'metadata-unavailable',
            {
              detail: failures.map((warning) => warning.params?.detail ?? warning.message).join('; '),
            },
            { requestFailures: failures.flatMap((warning) => warning.requestFailures ?? []) },
          ),
        )
        catalog.warnings = catalog.warnings.filter((warning) => warning.code !== 'metadata-source-unavailable')
      }
    }
  }
  return {
    ...result,
    directories: collection.directories,
    root: collection.root,
    warnings: [...warnings, ...catalog.warnings, ...collection.warnings, ...detected.warnings, ...result.warnings],
  }
}
