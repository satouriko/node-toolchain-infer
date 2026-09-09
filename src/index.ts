import { fetchCatalog, fetchExplicitCatalog, loadRules } from './catalog.js'
import { collect } from './collect.js'
import { resolve } from './resolve.js'
import { detectRuntime } from './runtime.js'
import { errorMessage } from './validation.js'
import { createWarning } from './warnings.js'

import type {
  Catalog,
  CatalogOptions,
  CollectOptions,
  CompatibilityRule,
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
export interface InferOptions extends CollectOptions, CatalogOptions {
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
  const [collection, stableCatalog, rules] = await Promise.all([
    collect(options),
    options.catalog
      ?? fetchCatalog(options).catch((error: unknown): Catalog => {
        if (options.signal?.aborted) throw options.signal.reason
        warnings.push(createWarning('metadata-unavailable', { detail: errorMessage(error) }))
        return {
          schemaVersion: 1,
          generatedAt: new Date().toISOString(),
          nodes: [],
          managers: { npm: [], pnpm: [], yarn: [] },
          sources: [],
          warnings: [],
        }
      }),
    options.rules ?? loadRules(),
  ])
  const catalog = options.catalog
    ? stableCatalog
    : await fetchExplicitCatalog(stableCatalog, collection.sources, options)
  const detected = options.runtime ? { runtime: options.runtime, warnings: [] } : await detectRuntime({ catalog })
  const result = resolve({ sources: collection.sources, runtime: detected.runtime }, catalog, rules)
  return {
    ...result,
    directories: collection.directories,
    root: collection.root,
    warnings: [...warnings, ...catalog.warnings, ...collection.warnings, ...detected.warnings, ...result.warnings],
  }
}
