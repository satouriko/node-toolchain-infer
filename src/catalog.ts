import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { validateCatalog, validateCompatibility } from './data-validation.js'
import { fetchExplicitMetadata, fetchMetadata } from './metadata.js'

import type { Catalog, CatalogOptions, CompatibilityRule, Source } from './types.js'

export { MetadataError, OFFICIAL_SOURCES } from './metadata.js'
export function fetchCatalog(options: CatalogOptions = {}): Promise<Catalog> {
  return fetchMetadata({ ...options, hash: (body) => Promise.resolve(createHash('sha256').update(body).digest('hex')) })
}
export function fetchExplicitCatalog(
  catalog: Catalog,
  sources: Source[],
  options: CatalogOptions = {},
): Promise<Catalog> {
  return fetchExplicitMetadata(catalog, sources, {
    ...options,
    hash: (body) => Promise.resolve(createHash('sha256').update(body).digest('hex')),
  })
}
export async function loadCatalog(path: string): Promise<Catalog> {
  return validateCatalog(JSON.parse(await readFile(path, 'utf8')))
}
export async function loadRules({
  compatibilityPath = new URL('../data/compatibility.json', import.meta.url),
}: { compatibilityPath?: string | URL } = {}): Promise<CompatibilityRule[]> {
  return validateCompatibility(JSON.parse(await readFile(compatibilityPath, 'utf8'))).rules
}
