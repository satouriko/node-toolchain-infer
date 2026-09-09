import bundled from '../../data/compatibility.json' with { type: 'json' }
import { rulesFrom } from '../../src/data-validation.js'
import { fetchExplicitMetadata } from '../../src/metadata.js'
import { playgroundSources, resolvePlayground } from '../../src/playground.js'

import { browserMetadataFetcher } from './fetcher.js'

import type { InputState, UiCatalog } from './ui-types.js'
import type { Catalog, CatalogOptions } from '../../src/types.js'

const rules = rulesFrom(bundled)
export async function resolveLive(input: InputState, catalog: UiCatalog, options: CatalogOptions = {}) {
  if (options.signal?.aborted) throw options.signal.reason
  const complete: Catalog = {
    ...catalog,
    generatedAt: catalog.generatedAt ?? '',
    managers: {
      npm: catalog.managers.npm.map((p) => ({ ...p, node: p.node ?? null })),
      pnpm: catalog.managers.pnpm.map((p) => ({ ...p, node: p.node ?? null })),
      yarn: catalog.managers.yarn.map((p) => ({ ...p, node: p.node ?? null })),
    },
  }
  const selected = await fetchExplicitMetadata(complete, playgroundSources(input), {
    ...options,
    fetcher: options.fetcher ?? browserMetadataFetcher,
  })
  return {
    ...resolvePlayground(input, selected, rules),
    versionData: { fetchedAt: selected.generatedAt, sources: selected.sources },
  }
}
