import { readFile } from 'node:fs/promises'

import semver from 'semver'

import { digest, type Observation } from './model.js'

import type { KnownBug, Manager } from '../src/types.js'

export interface KnownBugReview extends KnownBug {
  manager: Manager
  fixtureIds: string[]
  semanticEvidence: string
  reviewedAt: string
  observations: Array<{ id: string; fingerprint: string }>
}

// Log/archive locations can change when CI imports evidence; the actual experiment cannot.
function portable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(portable)
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key, item]) => !['logPath', 'lockfilePath'].includes(key) && item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, portable(item)]),
    )
  return value
}
export const observationFingerprint = (observation: Observation): string =>
  digest(JSON.stringify(portable(observation)))

export function validateKnownBugs(value: unknown): KnownBugReview[] {
  const data = value as { schemaVersion?: unknown; bugs?: unknown } | null
  if (!data || data.schemaVersion !== 1 || !Array.isArray(data.bugs))
    throw new Error('Invalid known-bug reviews schema')
  const ids = new Set<string>()
  const observations = new Set<string>()
  for (const raw of data.bugs) {
    const bug = raw as KnownBugReview | null
    if (
      !bug
      || typeof bug.id !== 'string'
      || !bug.id.trim()
      || ids.has(bug.id)
      || !['npm', 'pnpm', 'yarn'].includes(bug.manager)
      || typeof bug.range !== 'string'
      || !semver.validRange(bug.range)
      || typeof bug.reason !== 'string'
      || !bug.reason.trim()
      || typeof bug.url !== 'string'
      || !bug.url.startsWith('https://')
      || typeof bug.semanticEvidence !== 'string'
      || !bug.semanticEvidence.trim()
      || typeof bug.reviewedAt !== 'string'
      || !Number.isFinite(Date.parse(bug.reviewedAt))
      || !Array.isArray(bug.fixtureIds)
      || !bug.fixtureIds.length
      || bug.fixtureIds.some((id) => typeof id !== 'string' || !id)
      || !Array.isArray(bug.observations)
      || !bug.observations.length
    )
      throw new Error('Invalid or duplicate known-bug review')
    ids.add(bug.id)
    for (const rawEntry of bug.observations) {
      const entry = rawEntry as { id?: unknown; fingerprint?: unknown } | null
      if (
        !entry
        || typeof entry.id !== 'string'
        || !entry.id
        || observations.has(entry.id)
        || typeof entry.fingerprint !== 'string'
        || !/^[a-f\d]{64}$/.test(entry.fingerprint)
      )
        throw new Error(`Invalid or duplicate known-bug observation: ${bug.id}`)
      observations.add(entry.id)
    }
  }
  return data.bugs as KnownBugReview[]
}
export async function loadKnownBugs(path: string | URL): Promise<KnownBugReview[]> {
  try {
    return validateKnownBugs(JSON.parse(await readFile(path, 'utf8')))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}
export function reviewedBug(observation: Observation, reviews: KnownBugReview[] = []): KnownBugReview | undefined {
  for (const bug of reviews) {
    const entry = bug.observations.find((item) => item.id === observation.id)
    if (!entry) continue
    if (
      entry.fingerprint !== observationFingerprint(observation)
      || observation.manager !== bug.manager
      || !bug.fixtureIds.includes(observation.fixtureId)
      || !semver.satisfies(observation.version, bug.range, { includePrerelease: true })
      || observation.status === 'pass'
    )
      throw new Error(`Known-bug review no longer matches its observation: ${bug.id}, ${observation.id}`)
    return bug
  }
  return undefined
}
export function compatibilityOutcome(
  observation: Observation,
  reviews: KnownBugReview[] = [],
): 'supported' | 'unsupported' | 'unknown' {
  if (reviewedBug(observation, reviews) || observation.status === 'pass') return 'supported'
  return observation.status === 'inconclusive' ? 'unknown' : 'unsupported'
}
/** Project onto stable versions without extending a reviewed bug's release boundaries. */
export function stableBugRange(range: string): string {
  const clauses = new semver.Range(range).set.flatMap((comparators) => {
    const stable: string[] = []
    for (const comparator of comparators) {
      if (!comparator.value) continue
      const version = comparator.semver
      if (!version.prerelease.length) {
        stable.push(comparator.value)
        continue
      }
      const core = `${version.major}.${version.minor}.${version.patch}`
      if (comparator.operator === '>' || comparator.operator === '>=') stable.push(`>=${core}`)
      else if (comparator.operator === '<' || comparator.operator === '<=') stable.push(`<${core}`)
      else return [] // An exact prerelease has no stable member.
    }
    const clause = stable.join(' ') || '*'
    return semver.minVersion(clause) ? [clause] : []
  })
  return [...new Set(clauses)].join(' || ') || '<0.0.0'
}
export const bugSummary = ({ id, range, reason, url }: KnownBug): KnownBug => ({
  id,
  range: stableBugRange(range),
  reason,
  url,
})
