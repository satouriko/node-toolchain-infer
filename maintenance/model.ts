import { createHash } from 'node:crypto'

import semver from 'semver'

import { isStableVersion } from '../src/versions.js'

import type { BootstrapReceipt } from './bootstrap.js'
import type { NativeReceipt } from './provision.js'
import type { CompatibilityRule, Manager } from '../src/types.js'
import type { Buffer } from 'node:buffer'

export type Outcome = 'pass' | 'rewrite' | 'semantic-mismatch' | 'incompatible' | 'inconclusive'
export const FROZEN_PROTOCOL = 'frozen-install-v2'
export const SEED_PROTOCOL = 'frozen-initial-matrix-v2'
export const FROZEN_LOCKFILES = [
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'shrinkwrap.yaml',
  'yarn.lock',
] as const
export interface Fixture {
  id: string
  manager: Manager
  version: string
  directory: string
  lock: string
  match: CompatibilityRule['match']
  dependencies: Record<string, string>
  node?: string
  linker?: 'pnp'
  controlDependencies?: Record<string, string>
}
export interface Observation {
  protocol?: string
  inputHashes?: Record<string, string>
  id: string
  key: string
  manager: Manager
  version: string
  actualVersion: string
  node: string
  nodeIntegrity: string
  nodeArch?: string
  bootstrap?: BootstrapReceipt
  toolIntegrity: string
  native?: NativeReceipt
  toolUrl: string
  platform: string
  arch: string
  fixtureId: string
  fixtureHash: string
  command: string[]
  environment?: Record<string, string>
  status: Outcome
  exitCode: number | null
  beforeHashes: Record<string, string>
  afterHashes: Record<string, string>
  installed: Record<string, string>
  requestedDependencies?: Record<string, string>
  semantic: boolean
  semanticMethod?: 'node-modules' | 'pnp'
  frozenControl?: Observation
  logPath: string
  createdAt: string
}
export interface Interval {
  lower: string
  upper?: string
  evidenceIds: string[]
  confirmed: boolean
}
export function frozenControlAccepted(fixture: Fixture, control: Observation): boolean {
  if (control.status === 'incompatible' && Number.isInteger(control.exitCode) && control.exitCode !== 0) return true
  const ordered = (value: Record<string, string>) =>
    JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
  return (
    control.status === 'semantic-mismatch'
    && control.exitCode === 0
    && !control.semantic
    && Object.entries(fixture.dependencies).every(([name, version]) => control.installed[name] === version)
    && ordered(control.beforeHashes) === ordered(control.afterHashes)
  )
}
export interface Issues {
  unknownFormats: string[]
  mismatches: string[]
  unresolved: string[]
  incomplete: string[]
}
export const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
export function classify(input: {
  manager?: Manager
  command?: string[]
  exitCode: number | null
  output: string
  before: Record<string, string>
  after: Record<string, string>
  semantic: boolean
}): Outcome {
  if (input.exitCode !== 0) {
    if (
      /ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|CERT_|certificate|ENOSPC|EACCES|ENOMEM|Unsupported engine|EBADENGINE/i.test(
        input.output,
      )
    )
      return 'inconclusive'
    if (/Unknown token(?::[^\n]*)? \d+:\d+ in [^\n]*[/\\]yarn\.lock/.test(input.output)) return 'incompatible'
    if (/SyntaxError/.test(input.output)) return 'inconclusive'
    if (input.manager === 'npm' && input.command?.[0] === 'ci') {
      // Older npm prints its full command list when ci is not implemented.
      // Only an explicit unknown command or complete list proves this; a generic usage error does not.
      const listed = input.output.replaceAll('\r\n', '\n').split('where <command> is one of:').at(1)?.trimStart()
      const end = listed?.indexOf('\n\n') ?? -1
      const commands = end === -1 ? undefined : listed?.slice(0, end)
      if (
        /Unknown command:\s*["']?ci["']?(?:\s|$)/i.test(input.output)
        || (commands && !commands.split(/[\s,]+/).includes('ci'))
      )
        return 'incompatible'
      // The legacy ci verifier dereferences the old lock's dependencies map.
      // Require its actual debug-stack frame; the same TypeError without that context stays inconclusive.
      if (
        /Cannot read propert(?:y|ies)/.test(input.output)
        && /[\\/]lock-verify[\\/]index\.js:\d+:\d+/.test(input.output)
      )
        return 'incompatible'
    }
    if (input.manager === 'pnpm' && /pacquet_package_manager::outdated_lockfile/.test(input.output))
      return 'incompatible'
    if (
      input.manager === 'pnpm'
      && /Cannot install with ["']?frozen-(?:lockfile|shrinkwrap)["']? because (?:pnpm-lock|shrinkwrap)\.yaml is not up-to-date with package\.json/i.test(
        input.output,
      )
    )
      return 'incompatible'
    if (
      input.manager === 'pnpm'
      && /Cannot run headless installation because shrinkwrap\.yaml is not up-to-date with package\.json/.test(
        input.output,
      )
    )
      return 'incompatible'
    const npmMessage = input.output.replace(/^npm (?:ERR!|error)\s*/gm, '').replace(/\s+/g, ' ')
    if (/can only install with an existing package-lock\.json with lockfileVersion >= 1/.test(npmMessage))
      return 'incompatible'
    if (
      /pacquet_lockfile::parse_yaml|ERR_PNPM_(?:OUTDATED_LOCKFILE|LOCKFILE_BREAKING_CHANGE|NO_LOCKFILE|FROZEN_LOCKFILE_WITH_OUTDATED_LOCKFILE|BROKEN_LOCKFILE|LOCKFILE_CONFIG_MISMATCH)|Headless installation requires a (?:pnpm-lock|shrinkwrap)\.yaml file|lockfile needs to be updated|YN0028|lockfile would have been modified|can only install packages when.*lock|package.json and.*lock.*in sync|Missing: .* from lock file|Invalid: lock file/i.test(
        input.output,
      )
    )
      return 'incompatible'
    return 'inconclusive'
  }
  if (JSON.stringify(input.before) !== JSON.stringify(input.after)) return 'rewrite'
  return input.semantic ? 'pass' : 'semantic-mismatch'
}
export function mergeHistory(previous: Observation[], added: Observation[]): Observation[] {
  const result = new Map(previous.map((item) => [item.id, item]))
  for (const item of added) if (!result.has(item.id)) result.set(item.id, item)
  return [...result.values()]
}
export function newReleases(current: string[], seen: string[]): string[] {
  const known = new Set(seen)
  return current.filter((version) => isStableVersion(version) && !known.has(version)).sort(semver.compare)
}
export function compileIntervals(intervals: Interval[]): string | null {
  const confirmed = intervals.filter((item) => item.confirmed)
  if (!confirmed.length) return null
  return confirmed
    .sort((a, b) => semver.compare(a.lower, b.lower))
    .map((item) => {
      if (
        !isStableVersion(item.lower)
        || (item.upper && (!isStableVersion(item.upper) || !semver.gt(item.upper, item.lower)))
        || !item.evidenceIds.length
      )
        throw new Error('Invalid confirmed interval')
      return `>=${item.lower}${item.upper ? ` <${item.upper}` : ''}`
    })
    .join(' || ')
}
export function evaluate(issues: Issues): Issues & { exitCode: 0 | 1 | 2 } {
  let exitCode: 0 | 1 | 2 = 0
  if (issues.unknownFormats.length || issues.mismatches.length || issues.unresolved.length) exitCode = 1
  if (issues.incomplete.length) exitCode = 2
  return { ...issues, exitCode }
}
