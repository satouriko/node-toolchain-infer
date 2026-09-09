import semver from 'semver'

import { isStableVersion } from '../src/versions.js'

import { compatibilityOutcome, type KnownBugReview } from './known-bugs.js'
import { frozenArgs, sameEnvironment } from './runner.js'

import type { Observation } from './model.js'
import type { CompatibilityRule } from '../src/types.js'

export interface BehaviorComparison {
  expected: boolean | undefined
  basis: 'rule' | 'observation' | 'unestablished'
  evidenceId?: string
  mismatch: boolean
}
export function compareBehavior(
  observation: Observation,
  history: Observation[],
  matchingRules: CompatibilityRule[],
  knownBugs: KnownBugReview[] = [],
): BehaviorComparison {
  if (!isStableVersion(observation.version)) return { expected: undefined, basis: 'unestablished', mismatch: false }
  const actual = compatibilityOutcome(observation, knownBugs)
  const stableRules = matchingRules.filter((rule) => rule.range !== null)
  if (stableRules.length) {
    const expected = stableRules.every((rule) => semver.satisfies(observation.version, rule.range!))
    return {
      expected,
      basis: 'rule',
      mismatch: actual !== 'unknown' && expected !== (actual === 'supported'),
    }
  }
  const comparable = history.filter(
    (item) =>
      isStableVersion(item.version)
      && item.id !== observation.id
      && item.version !== observation.version
      && item.manager === observation.manager
      && item.fixtureId === observation.fixtureId
      && item.fixtureHash === observation.fixtureHash
      && item.node === observation.node
      && item.nodeIntegrity === observation.nodeIntegrity
      && (item.nodeArch ?? item.arch) === (observation.nodeArch ?? observation.arch)
      && item.platform === observation.platform
      && item.arch === observation.arch
      && sameEnvironment(item.environment, observation.environment)
      && JSON.stringify(item.command) === JSON.stringify(frozenArgs(item.manager, item.version))
      && JSON.stringify(item.command) === JSON.stringify(observation.command)
      && (item.status === 'pass'
        || item.status === 'incompatible'
        || compatibilityOutcome(item, knownBugs) === 'supported'),
  )
  const lower = comparable
    .filter((item) => semver.lt(item.version, observation.version))
    .sort((a, b) => semver.rcompare(a.version, b.version))
  const higher = comparable
    .filter((item) => semver.gt(item.version, observation.version))
    .sort((a, b) => semver.compare(a.version, b.version))
  const prior = lower.at(0) ?? higher.at(0)
  if (!prior) return { expected: undefined, basis: 'unestablished', mismatch: actual !== 'unknown' }
  const expected = compatibilityOutcome(prior, knownBugs) === 'supported'
  return {
    expected,
    basis: 'observation',
    evidenceId: prior.id,
    mismatch: actual !== 'unknown' && expected !== (actual === 'supported'),
  }
}
export function selectReleaseBatch<T extends { key: string }>(
  queue: T[],
  attempted: Record<string, string>,
  maximum: number,
  batch: number,
): T[] {
  if (maximum <= 0) return []
  const fresh = queue.filter((item) => !Object.hasOwn(attempted, item.key))
  const retries = queue
    .filter((item) => Object.hasOwn(attempted, item.key))
    .sort((a, b) => attempted[a.key].localeCompare(attempted[b.key]))
  if (!fresh.length) return retries.slice(0, maximum)
  if (!retries.length) return fresh.slice(0, maximum)
  if (maximum === 1) return (batch % 2 === 0 ? fresh : retries).slice(0, 1)
  const retrySlots = Math.min(retries.length, Math.max(1, Math.floor(maximum / 4)))
  const selected = [...fresh.slice(0, maximum - retrySlots), ...retries.slice(0, retrySlots)]
  return [...selected, ...retries.filter((item) => !selected.includes(item)).slice(0, maximum - selected.length)]
}
