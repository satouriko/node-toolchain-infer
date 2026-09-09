import semver from 'semver'

import { MANAGERS } from './constraints.js'
import { object, timestamp } from './validation.js'

import type { Catalog, CompatibilityData, CompatibilityRule } from './types.js'

export function validateCompatibility(value: unknown): CompatibilityData {
  const data = object(value, 'Compatibility data')
  if (data.schemaVersion !== 1) throw new Error('Unsupported compatibility schemaVersion.')
  timestamp(data.generatedAt, 'generatedAt')
  if (!Array.isArray(data.rules) || !Array.isArray(data.observations))
    throw new Error('Compatibility rules and observations must be arrays.')
  const ids = new Set<string>()
  for (const item of data.rules) {
    const rule = object(item, 'Compatibility rule')
    if (typeof rule.id !== 'string' || !rule.id || ids.has(rule.id))
      throw new Error('Missing or duplicate compatibility rule id.')
    ids.add(rule.id)
    if (!MANAGERS.some((name) => name === rule.manager)) throw new Error(`Rule ${rule.id}: unsupported manager.`)
    if (rule.range !== null && (typeof rule.range !== 'string' || !semver.validRange(rule.range)))
      throw new Error(`Rule ${rule.id}: invalid range.`)
    const match = object(rule.match, `Rule ${rule.id}.match`)
    for (const key of Object.keys(match))
      if (!['file', 'format', 'classic', 'features', 'cacheKeyMin', 'cacheKeyMax'].includes(key))
        throw new Error(`Rule ${rule.id}: unknown match predicate ${key}.`)
    if (match.file !== undefined && (typeof match.file !== 'string' || !match.file || /[/\\]/.test(match.file)))
      throw new Error(`Rule ${rule.id}: match.file must be a lockfile basename.`)
    if (match.format !== undefined && typeof match.format !== 'string' && typeof match.format !== 'number')
      throw new Error(`Rule ${rule.id}: invalid match.format.`)
    if (match.classic !== undefined && typeof match.classic !== 'boolean')
      throw new Error(`Rule ${rule.id}: invalid match.classic.`)
    for (const key of ['cacheKeyMin', 'cacheKeyMax'])
      if (match[key] !== undefined && (typeof match[key] !== 'number' || !Number.isFinite(match[key])))
        throw new Error(`Rule ${rule.id}: invalid match.${key}.`)
    if (match.features !== undefined) object(match.features, `Rule ${rule.id}.match.features`)
    if (rule.knownBugs !== undefined) {
      if (!Array.isArray(rule.knownBugs)) throw new Error(`Rule ${rule.id}: knownBugs must be an array.`)
      for (const entry of rule.knownBugs) {
        const bug = object(entry, 'Known bug')
        if (
          typeof bug.id !== 'string'
          || !bug.id
          || typeof bug.range !== 'string'
          || !semver.validRange(bug.range)
          || typeof bug.reason !== 'string'
          || !bug.reason
          || typeof bug.url !== 'string'
          || !bug.url.startsWith('https://')
        )
          throw new Error(`Rule ${rule.id}: invalid known-bug marker.`)
      }
    }
  }
  return data as unknown as CompatibilityData
}
export function validateCatalog(value: unknown): Catalog {
  const data = object(value, 'Catalog')
  if (data.schemaVersion !== 1) throw new Error('Unsupported catalog schemaVersion.')
  timestamp(data.generatedAt, 'generatedAt')
  if (!Array.isArray(data.nodes) || !Array.isArray(data.sources) || !Array.isArray(data.warnings))
    throw new Error('Invalid catalog arrays.')
  for (const item of data.nodes) {
    const row = object(item, 'Node release')
    if (typeof row.version !== 'string' || !semver.valid(row.version)) throw new Error('Invalid Node version.')
    if (row.npm !== null && row.npm !== undefined && (typeof row.npm !== 'string' || !semver.valid(row.npm)))
      throw new Error('Invalid bound npm version.')
  }
  const managers = object(data.managers, 'managers')
  for (const name of MANAGERS) {
    if (!Array.isArray(managers[name])) throw new Error(`Missing ${name} versions.`)
    for (const item of managers[name]) {
      const row = object(item, `${name} release`)
      if (typeof row.version !== 'string' || !semver.valid(row.version)) throw new Error(`Invalid ${name} version.`)
      if (row.node !== null && (typeof row.node !== 'string' || !semver.validRange(row.node)))
        throw new Error(`Invalid ${name} engines.node.`)
      if (row.runtime !== undefined && row.runtime !== 'node' && row.runtime !== 'native')
        throw new Error(`Invalid ${name} runtime.`)
      if (row.runtime === 'native' && row.node !== '*')
        throw new Error(`Native ${name} must have an unrestricted host Node constraint.`)
    }
  }
  for (const item of data.sources) {
    const row = object(item, 'Source receipt')
    timestamp(row.fetchedAt, 'Source fetchedAt')
    if (typeof row.sha256 !== 'string' || !/^[a-f\d]{64}$/.test(row.sha256)) throw new Error('Invalid source sha256.')
  }
  return data as unknown as Catalog
}
export function rulesFrom(value: unknown): CompatibilityRule[] {
  return validateCompatibility(value).rules
}
