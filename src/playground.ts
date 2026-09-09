import semver from 'semver'

import { matchesDeclaration } from './constraints.js'
import { resolve } from './resolve.js'
import { createSource, SOURCE_DEFINITIONS } from './sources.js'
import { isStableVersion } from './versions.js'

import type { Catalog, CompatibilityRule, NormalizedSource, Source } from './types.js'
import type { InputState, UiCatalog, UiResult } from '../website/src/ui-types.js'

function sourceKind(source: NormalizedSource): string {
  if (source.lockfile) return 'inferred'
  if (source.exact) return 'exact'
  return source.range === '*' && source.target === 'manager' ? 'type' : 'range'
}
function lockExplanation(source: NormalizedSource): string | undefined {
  if (!source.lockfile) return undefined
  return source.compatibilityKnown
    ? `Bundled compatibility rules: ${(source.ruleIds ?? []).join(', ')}.`
    : 'Unknown lock format: retain manager identity with version range *.'
}
export function playgroundSources(input: InputState): Source[] {
  const sources: Source[] = []
  const add = (
    key: string,
    value: string,
    depth: number,
    index: number,
    sharedWorkspace = false,
    yarnFamily?: string,
  ) => {
    if (!value.trim() || depth > input.searchDepth) return
    const text =
      key === 'toolVersions'
        ? value
            .replace(/^nodejs\s+/, '')
            .split(/\s+/)
            .join(' || ')
        : value
    const source = createSource(key, text, { depth, index })
    if (key === 'pnpmShrinkwrap') source.features = { sharedWorkspace }
    if (key === 'yarnLock' && yarnFamily === 'zpm') source.features = { yarnFamily }
    source.id = `ui:${index}`
    sources.push(source)
  }
  for (const [index, definition] of SOURCE_DEFINITIONS.entries())
    add(
      definition.key,
      input.fields[definition.key] ?? '',
      definition.kind.startsWith('input.') ? -1 : 0,
      index,
      input.fields.pnpmShrinkwrapImporters === 'true',
      input.fields.yarnLockFamily,
    )
  for (const [index, row] of input.additional.entries())
    add(row.key, row.value, row.depth, SOURCE_DEFINITIONS.length + index, row.sharedWorkspace === true, row.yarnFamily)
  return sources
}
export function resolvePlayground(input: InputState, data: UiCatalog, rules: CompatibilityRule[]): UiResult {
  const catalog: Catalog = {
    ...data,
    generatedAt: data.generatedAt ?? '',
    managers: {
      npm: data.managers.npm.map((p) => ({ ...p, node: p.node ?? null })),
      pnpm: data.managers.pnpm.map((p) => ({ ...p, node: p.node ?? null })),
      yarn: data.managers.yarn.map((p) => ({ ...p, node: p.node ?? null })),
    },
  }
  const result = resolve(
    {
      sources: playgroundSources(input),
      runtime: { node: input.runtime.node, npm: input.runtime.npm, pnpm: input.runtime.pnpm, yarn: input.runtime.yarn },
    },
    catalog,
    rules,
  )
  const sourceName = (id?: string) => result.trace.find((t) => t.id === id)?.kind ?? id ?? 'runtime'
  const accepted = result.trace.filter((t) => t.status === 'accepted')
  return {
    node: result.node ? { ...result.node, source: accepted.find((t) => t.target === 'node' && t.exact)?.kind } : null,
    packageManager: result.packageManager
      ? { ...result.packageManager, source: accepted.find((t) => t.target === 'manager' && t.exact)?.kind }
      : null,
    nodeCandidates: result.candidates.nodes,
    pmCandidates: result.candidates.managerVersions,
    nodeConstraints: accepted.filter((t) => t.target === 'node').map((t) => ({ range: t.range, source: t.kind })),
    pmConstraints: accepted
      .filter((t) => t.target === 'manager')
      .flatMap((t) => t.ranges.map((range) => ({ range, source: t.kind, inferred: t.lockfile }))),
    derivedNodeRanges: [...new Set(accepted.flatMap((t) => t.derivedNodeRanges))],
    warnings: [...data.warnings, ...result.warnings].map((w) => ({
      code: w.code,
      source: sourceName(w.sourceId),
      message: w.message,
      blockers: (w.blockers ?? []).map(sourceName),
    })),
    trace: result.trace.map((t) => ({
      key: t.key ?? t.id,
      depth: t.depth,
      order: Number(t.id.split(':')[1]),
      rank: t.rank,
      name: t.kind,
      value: typeof t.value === 'string' ? t.value : JSON.stringify(t.value),
      normalized: t.ranges.join(' ∩ '),
      status: t.status === 'inactive' ? 'skipped' : t.status,
      kind: sourceKind(t),
      detail:
        t.invalid
        ?? t.reason
        ?? (t.status === 'accepted'
          ? 'Retained with higher-priority conditions.'
          : 'Conflicts with higher-priority conditions; ignored together with its derived Node requirements.'),
      inference: lockExplanation(t),
      manager: t.manager,
      blockers: t.blockers?.map(sourceName),
      remainingNodes: t.remainingNodes,
      remainingPMs: t.remainingManagerVersions,
      derivations: t.derivedNodeRanges.map((node) => {
        const records = catalog.managers[t.manager].filter(
          (p) =>
            (isStableVersion(p.version) || matchesDeclaration(t, p.version))
            && p.node === node
            && t.ranges.every((range) => semver.satisfies(p.version, range)),
        )
        return { node, versions: records.map((p) => p.version), count: records.length }
      }),
    })),
    selectionVerified: Boolean(result.node && result.packageManager),
    nodeCompatibility: !result.packageManager || result.packageManager.nodeRange === null ? 'unknown' : 'declared',
  }
}
