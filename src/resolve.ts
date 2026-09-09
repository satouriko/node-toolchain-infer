import semver from 'semver'

import { MANAGERS, matchesDeclaration, normalizeSource } from './constraints.js'
import { errorMessage, isAbsent } from './validation.js'
import { isStableVersion } from './versions.js'
import {
  createWarning,
  DeclarationError,
  type WarningCode,
  type WarningContext,
  type WarningParamsByCode,
} from './warnings.js'

import type {
  Catalog,
  CompatibilityRule,
  Manager,
  ManagerRelease,
  NodeRelease,
  NormalizedSource,
  ResolveInput,
  ResolveResult,
  Source,
  TraceEntry,
  Warning,
} from './types.js'

const descending = (a: { version: string }, b: { version: string }) => semver.rcompare(a.version, b.version)
const sourceOrder = (a: Source & { index: number }, b: Source & { index: number }) =>
  a.depth - b.depth || a.rank - b.rank || a.index - b.index

/** Resolve ordered declarations over concrete runnable Node/manager pairs. No I/O. */
export function resolve(input: ResolveInput, catalog: Catalog, rules: CompatibilityRule[] = []): ResolveResult {
  const warnings: Warning[] = []
  const trace: TraceEntry[] = []
  const warn = <C extends WarningCode>(
    code: C,
    source: Source | null,
    params: WarningParamsByCode[C],
    detail: WarningContext = {},
  ) => warnings.push(createWarning(code, params, { sourceId: source?.id ?? 'runtime', path: source?.path, ...detail }))
  const runtime = {
    node: semver.valid(input.runtime.node),
    npm: semver.valid(input.runtime.npm),
    pnpm: semver.valid(input.runtime.pnpm ?? ''),
    yarn: semver.valid(input.runtime.yarn ?? ''),
  }
  if (!runtime.node || !runtime.npm) {
    warn('runtime-unavailable', null, {})
    return {
      node: null,
      packageManager: null,
      candidates: { nodes: [], managerVersions: [] },
      warnings,
      trace,
      constraints: [],
      dataTimestamp: catalog.generatedAt,
    }
  }
  const runningNode = runtime.node
  const raw = (input.sources || []).map((s, index) => ({ ...s, index })).sort(sourceOrder)
  const aliasNodes = catalog.nodes.filter((n) => isStableVersion(n.version))
  if (isStableVersion(runningNode) && !aliasNodes.some((n) => n.version === runningNode))
    aliasNodes.push({ version: runningNode, npm: runtime.npm })
  aliasNodes.sort(descending)
  const invalidParams = new Map<number, WarningParamsByCode['invalid-declaration']>()
  const parsed: NormalizedSource[] = raw.map((source) => {
    try {
      return normalizeSource(source, aliasNodes, rules)
    } catch (error) {
      invalidParams.set(
        source.index,
        error instanceof DeclarationError
          ? { reason: error.reason, value: error.value }
          : { reason: 'unexpected', value: errorMessage(error) },
      )
      return {
        manager: 'npm' as Manager,
        range: '*',
        ranges: [],
        exact: null,
        derivedNodeRanges: [],
        ...source,
        invalid: errorMessage(error),
      }
    }
  })
  const releaseVersions: Record<'node' | Manager, string[]> = {
    node: [...catalog.nodes.map((n) => n.version), runtime.node],
    npm: [],
    pnpm: [],
    yarn: [],
  }
  for (const name of MANAGERS)
    releaseVersions[name] = [...catalog.managers[name].map((p) => p.version), ...(runtime[name] ? [runtime[name]] : [])]
  const declarationVersions = new Map(
    parsed.map((source) => [
      source,
      (source.invalid ? [] : releaseVersions[source.target === 'node' ? 'node' : source.manager]).filter(
        (version) => !isStableVersion(version) && matchesDeclaration(source, version),
      ),
    ]),
  )
  const explicitVersions = (sources: NormalizedSource[], target: 'node' | 'manager', manager?: Manager) =>
    new Set(
      sources
        .filter((s) => !s.invalid && s.target === target && (target === 'node' || s.manager === manager))
        .flatMap((s) => declarationVersions.get(s) ?? []),
    )
  const explicitNodes = explicitVersions(parsed, 'node')
  const explicitManagers = Object.fromEntries(
    MANAGERS.map((name) => [name, explicitVersions(parsed, 'manager', name)]),
  ) as Record<Manager, Set<string>>
  const nodeMap = new Map<string, NodeRelease>(
    catalog.nodes
      .filter((n) => isStableVersion(n.version) || explicitNodes.has(n.version))
      .map((n) => [n.version, { ...n }]),
  )
  for (const [name, version] of Object.entries(runtime))
    if (
      version
      && !isStableVersion(version)
      && !(name === 'node' ? explicitNodes : explicitManagers[name as Manager]).has(version)
    )
      warn('prerelease-excluded', null, { name, version })
  if (isStableVersion(runtime.node) || explicitNodes.has(runtime.node))
    nodeMap.set(runtime.node, {
      ...nodeMap.get(runtime.node),
      version: runtime.node,
      npm: runtime.npm,
    })
  const nodes = [...nodeMap.values()].sort(descending)
  const managerData = Object.fromEntries(
    MANAGERS.map((name) => {
      const local = runtime[name]
      const records = catalog.managers[name]
        .filter(
          (p) =>
            (isStableVersion(p.version) || explicitManagers[name].has(p.version))
            && (isAbsent(p.node) || semver.validRange(p.node)),
        )
        .map((p) => ({ ...p }))
      if (
        local
        && (isStableVersion(local) || explicitManagers[name].has(local))
        && nodeMap.has(runningNode)
        && !records.some((p) => p.version === local)
      ) {
        records.push({ version: local, node: runningNode, observedRuntime: true })
      }
      return [name, records.sort(descending)]
    }),
  ) as Record<Manager, ManagerRelease[]>
  const rangeCache = new Map<string, semver.Range>()
  const satisfies = (version: string, range: string) => {
    if (!rangeCache.has(range)) rangeCache.set(range, new semver.Range(range))
    return rangeCache.get(range)?.test(version) ?? false
  }
  const nodeSupportCache = new Map<string, Set<string>>()
  const supportedNodes = (range: string) => {
    if (!nodeSupportCache.has(range))
      nodeSupportCache.set(
        range,
        new Set(
          nodes.filter((n) => semver.satisfies(n.version, range, { includePrerelease: true })).map((n) => n.version),
        ),
      )
    return nodeSupportCache.get(range) ?? new Set<string>()
  }
  const supportsNode = (p: ManagerRelease, n: NodeRelease) => isAbsent(p.node) || supportedNodes(p.node).has(n.version)
  const matchingVersions = (p: ManagerRelease, source: NormalizedSource) =>
    (source.lockfile && !source.compatibilityKnown) || source.ranges.every((r) => satisfies(p.version, r))
  for (const source of parsed) {
    const candidates =
      source.target === 'manager' && !source.invalid
        ? managerData[source.manager].filter(
            (p) => (isStableVersion(p.version) || matchesDeclaration(source, p.version)) && matchingVersions(p, source),
          )
        : []
    source.derivedNodeRanges = [...new Set(candidates.flatMap((p) => (isAbsent(p.node) ? [] : [p.node])))]
  }

  function evaluate(conditions: NormalizedSource[], manager: Manager, remaining: NormalizedSource[] = []) {
    if (conditions.some((s) => s.target === 'manager' && !s.conditional && s.manager !== manager))
      return { viable: false, nodes: [], managers: [] }
    const nodeConditions = conditions.filter((s) => s.target === 'node')
    const managerConditions = conditions.filter(
      (s) => s.target === 'manager' && (!s.conditional || s.manager === manager),
    )
    // Future declarations remain possible during priority merging. Only retained direct
    // declarations admit matching prereleases; lockfiles and the other tool cannot opt in.
    const possible = [...conditions, ...remaining]
    const nodeExplicit = explicitVersions(possible, 'node')
    const managerExplicit = explicitVersions(possible, 'manager', manager)
    const allowedNodes = nodes.filter(
      (n) =>
        (isStableVersion(n.version) || nodeExplicit.has(n.version))
        && nodeConditions.every((c) => satisfies(n.version, c.range)),
    )
    const allowedManagers = managerData[manager].filter(
      (p) =>
        (isStableVersion(p.version) || managerExplicit.has(p.version))
        && managerConditions.every((c) => matchingVersions(p, c)),
    )
    const engines = [...new Set(allowedManagers.map((p) => (isAbsent(p.node) ? null : p.node)))]
    const runnableNodes = allowedNodes.filter((n) =>
      engines.some((e) => e === null || supportedNodes(e).has(n.version)),
    )
    const runnableManagers = allowedManagers.filter((p) => runnableNodes.some((n) => supportsNode(p, n)))
    return {
      viable: runnableNodes.length > 0 && runnableManagers.length > 0,
      nodes: runnableNodes,
      managers: runnableManagers,
    }
  }

  // Lexicographic retention across manager identities respects the same ordering
  // as intersection over a single universe of Node/manager/version triples.
  const attempts = MANAGERS.map((manager) => {
    const kept: NormalizedSource[] = []
    const score = parsed.map((source, index) => {
      if (source.invalid) return 0
      if (source.conditional && source.manager !== manager) return 1
      if (!evaluate([...kept, source], manager, parsed.slice(index + 1)).viable) return 0
      kept.push(source)
      return 1
    })
    const hasSelector = kept.some((s) => s.target === 'manager' && !s.conditional)
    return { manager, score, valid: (manager === 'npm' || hasSelector) && evaluate(kept, manager).viable }
  })
    .filter((a) => a.valid)
    .sort((a, b) => {
      for (let i = 0; i < a.score.length; i++) if (a.score[i] !== b.score[i]) return b.score[i] - a.score[i]
      return MANAGERS.indexOf(a.manager) - MANAGERS.indexOf(b.manager)
    })
  if (!attempts.length) {
    warn('no-runnable-pair', null, {})
    return {
      node: null,
      packageManager: null,
      candidates: { nodes: [], managerVersions: [] },
      warnings,
      trace,
      constraints: [],
      dataTimestamp: catalog.generatedAt,
    }
  }
  const { manager } = attempts[0]
  const accepted: NormalizedSource[] = []
  for (const [index, source] of parsed.entries()) {
    if (source.invalid) {
      warn(
        'invalid-declaration',
        source,
        invalidParams.get(source.index) ?? { reason: 'unexpected', value: source.invalid },
      )
      trace.push({ ...source, status: 'invalid' })
    } else if (source.conditional && source.manager !== manager) {
      trace.push({ ...source, status: 'inactive', reason: `Applies only when ${source.manager} is selected.` })
    } else {
      const trial = evaluate([...accepted, source], manager, parsed.slice(index + 1))
      if (trial.viable) {
        accepted.push(source)
        trace.push({
          ...source,
          status: 'accepted',
          remainingNodes: trial.nodes.length,
          remainingManagerVersions: trial.managers.length,
        })
        if (source.lockfile && !source.compatibilityKnown)
          warn('unknown-lock-compatibility', source, {
            manager: source.manager,
            format: String(source.format ?? 'unknown'),
          })
      } else {
        const blockers = accepted.map((s) => s.id)
        warn('constraint-conflict', source, {}, { blockers })
        trace.push({ ...source, status: 'ignored', blockers })
      }
    }
  }
  const final = evaluate(accepted, manager)
  const exactNode = accepted.find((s) => s.target === 'node' && s.exact)
  const current = final.nodes.find((n) => n.version === runtime.node)
  const chosenNode = exactNode ? final.nodes.find((n) => n.version === exactNode.exact) : current || final.nodes[0]
  if (!chosenNode) throw new Error('No Node remains after successful constraint evaluation.')
  let nodeReason: 'exact' | 'current' | 'maximum' = current ? 'current' : 'maximum'
  if (exactNode) nodeReason = 'exact'
  const candidates = final.managers.filter((p) => supportsNode(p, chosenNode))
  const exactManager = accepted.find((s) => s.target === 'manager' && s.exact)
  const preferredVersion = manager === 'npm' ? chosenNode.npm : runtime[manager]
  const preferred = candidates.find((p) => p.version === preferredVersion)
  const chosenManager = exactManager
    ? candidates.find((p) => p.version === exactManager.exact)
    : preferred || candidates[0]
  if (!chosenManager) throw new Error('No package manager remains after successful constraint evaluation.')
  const warnedBugs = new Set<string>()
  for (const source of accepted) {
    if (!source.lockfile || source.manager !== manager) continue
    for (const bug of source.knownBugs ?? []) {
      if (warnedBugs.has(bug.id) || !semver.satisfies(chosenManager.version, bug.range, { includePrerelease: true }))
        continue
      warnedBugs.add(bug.id)
      warn('known-package-manager-bug', source, {
        manager,
        version: chosenManager.version,
        bugId: bug.id,
        url: bug.url,
      })
    }
  }
  let managerReason: 'exact' | 'bundled' | 'local' | 'maximum' = 'maximum'
  if (preferred) managerReason = manager === 'npm' ? 'bundled' : 'local'
  if (exactManager) managerReason = 'exact'
  if (!exactManager && preferredVersion && !preferred)
    warn('preferred-version-rejected', null, {
      manager,
      preferredVersion,
      node: chosenNode.version,
      selectedVersion: chosenManager.version,
    })
  if (isAbsent(chosenManager.node)) warn('unknown-node-requirement', null, { manager, version: chosenManager.version })
  return {
    candidates: { nodes: final.nodes.map((n) => n.version), managerVersions: candidates.map((p) => p.version) },
    node: { version: chosenNode.version, reason: nodeReason, bundledNpm: chosenNode.npm ?? null },
    packageManager: {
      name: manager,
      version: chosenManager.version,
      reason: managerReason,
      nodeRange: chosenManager.node,
      ...(chosenManager.runtime ? { runtime: chosenManager.runtime } : {}),
    },
    warnings,
    trace,
    constraints: accepted.map(({ id, target, manager: sourceManager, range, ranges, derivedNodeRanges, ruleIds }) => ({
      id,
      target,
      manager: sourceManager,
      range,
      ranges,
      derivedNodeRanges,
      ruleIds,
    })),
    dataTimestamp: catalog.generatedAt,
  }
}
