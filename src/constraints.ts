import semver from 'semver'

import { declarationText } from './validation.js'
import { DeclarationError } from './warnings.js'

import type { CompatibilityRule, Manager, NodeRelease, NormalizedSource, Source } from './types.js'

export const MANAGERS: Manager[] = ['npm', 'pnpm', 'yarn']

export function matchesDeclaration(source: NormalizedSource, version: string): boolean {
  return !source.invalid && !source.lockfile && source.ranges.every((range) => semver.satisfies(version, range))
}

export function normalizeFormat(value: unknown) {
  const raw = declarationText(value ?? 'unknown').trim()
  if (raw === 'classic' || raw === 'v1') return 'v1'
  return /^\d+(?:\.\d+)?$/.test(raw) ? String(Number(raw)) : raw
}

export function matchesRule(source: Source, rule: CompatibilityRule) {
  if (source.manager !== rule.manager) return false
  const m = rule.match
  // Rules recorded before native Yarn describe Classic/Berry, including Berry's format 9.
  if (source.manager === 'yarn' && (source.features?.yarnFamily === 'zpm') !== (m.features?.yarnFamily === 'zpm'))
    return false
  if (m.file !== undefined && m.file !== source.kind) return false
  if (m.format !== undefined && normalizeFormat(m.format) !== normalizeFormat(source.format)) return false
  if (m.classic !== undefined && m.classic !== (normalizeFormat(source.format) === 'v1')) return false
  if (m.cacheKeyMin !== undefined && !(Number(source.cacheKey) >= m.cacheKeyMin)) return false
  if (m.cacheKeyMax !== undefined && !(Number(source.cacheKey) < m.cacheKeyMax)) return false
  return Object.entries(m.features || {}).every(([key, value]) => source.features?.[key] === value)
}

function parseRange(value: unknown, source: Source, nodes: NodeRelease[]) {
  let raw = declarationText(value).trim()
  if (!raw) throw new DeclarationError('empty')
  if (source.target === 'node' && ['.nvmrc', '.node-version'].includes(source.kind)) {
    raw = raw.replace(/\s+#.*$/, '').trim()
    if (raw === 'node' || raw === 'stable') raw = nodes.find((n) => !semver.prerelease(n.version))?.version || raw
    if (/^lts\//i.test(raw)) {
      const name = raw.slice(4).toLowerCase()
      const release = nodes.find((n) => n.lts && (name === '*' || n.lts.toLowerCase() === name))
      if (!release) throw new DeclarationError('unresolved-alias', raw)
      raw = release.version
    }
  }
  const range = semver.validRange(raw)
  if (!range) throw new DeclarationError('invalid-semver', raw)
  const sets = new semver.Range(range).set
  const comparator = sets.length === 1 && sets[0].length === 1 ? sets[0][0] : null
  const exact = comparator?.operator === '' ? semver.valid(comparator.value) : null
  return { range, exact, ranges: [range] }
}

export function normalizeSource(
  source: Source & { index: number },
  nodes: NodeRelease[],
  rules: CompatibilityRule[],
): NormalizedSource {
  const base = { manager: 'npm' as Manager, range: '*', ranges: ['*'], exact: null, derivedNodeRanges: [], ...source }
  if (source.target === 'node') return { ...base, ...parseRange(source.value, source, nodes) }
  if (source.target === 'lock') {
    if (!source.manager || !MANAGERS.includes(source.manager)) throw new DeclarationError('unknown-manager')
    const matched = rules.filter((r) => matchesRule(source, r))
    const ranges = matched
      .filter((r) => r.range !== null)
      .map((r) => {
        const range = semver.validRange(r.range ?? '')
        if (!range) throw new DeclarationError('invalid-compatibility-rule', r.id)
        return range
      })
    return {
      ...base,
      manager: source.manager,
      target: 'manager',
      ranges: ranges.length ? ranges : ['*'],
      exact: null,
      lockfile: true,
      compatibilityKnown: ranges.length > 0,
      ruleIds: matched.map((r) => r.id),
      knownBugs: matched.flatMap((r) => r.knownBugs ?? []),
    }
  }
  if (source.conditional) {
    if (!source.manager || !MANAGERS.includes(source.manager)) throw new DeclarationError('unknown-conditional-manager')
    return { ...base, ...parseRange(source.value, source, nodes) }
  }
  const match = /^(npm|pnpm|yarn)(?:@(.+))?$/.exec(declarationText(source.value).trim())
  if (!match) throw new DeclarationError('invalid-manager-declaration', declarationText(source.value))
  const raw = match.at(2)?.replace(/\+sha(?:224|256|384|512)\.[\w+/=-]+$/, '')
  return {
    ...base,
    manager: match[1] as Manager,
    ...(raw ? parseRange(raw, source, nodes) : { range: '*', ranges: ['*'], exact: null }),
  }
}
