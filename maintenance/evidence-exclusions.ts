import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { digest } from './model.js'

import type { SeedRow } from '../scripts/seed-data.js'
import type { Buffer } from 'node:buffer'

export interface EvidenceExclusion {
  rowId: string
  observationId?: string
  rowSha256: string
  reason: string
  reviewedAt: string
}
export interface ExclusionAudit extends EvidenceExclusion {
  source: string
  exclusionsSha256: string
  rowPath: string
}
/** An exclusion is effective only after its original row bytes and IDs have been verified.
 * finish() also rejects references to missing rows, preventing an unmatched policy from being ignored.
 */
export class EvidenceExclusions {
  private readonly verified = new Map<string, ExclusionAudit>()
  private constructor(
    readonly source: string,
    readonly raw: Buffer | undefined,
    private readonly entries: Map<string, EvidenceExclusion>,
  ) {}
  static async load(directory: string): Promise<EvidenceExclusions> {
    const source = resolve(directory, 'exclusions.json')
    let raw: Buffer
    try {
      raw = await readFile(source)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return new EvidenceExclusions(source, undefined, new Map())
      throw error
    }
    let data: { schemaVersion?: unknown; entries?: unknown } | null
    try {
      data = JSON.parse(raw.toString()) as typeof data
    } catch (error) {
      throw new Error(`Invalid evidence exclusions JSON: ${source}`, { cause: error })
    }
    if (!data || data.schemaVersion !== 1 || !Array.isArray(data.entries))
      throw new Error(`Invalid evidence exclusions schema: ${source}`)
    const entries = new Map<string, EvidenceExclusion>()
    for (const value of data.entries) {
      const entry = value as Partial<EvidenceExclusion> | null
      if (
        !entry
        || typeof entry.rowId !== 'string'
        || !entry.rowId.trim()
        || typeof entry.rowSha256 !== 'string'
        || !/^[a-f\d]{64}$/.test(entry.rowSha256)
        || typeof entry.reason !== 'string'
        || !entry.reason.trim()
        || typeof entry.reviewedAt !== 'string'
        || !Number.isFinite(Date.parse(entry.reviewedAt))
        || (entry.observationId !== undefined
          && (typeof entry.observationId !== 'string' || !entry.observationId.trim()))
        || entries.has(entry.rowId)
      )
        throw new Error(`Invalid or duplicate evidence exclusion entry: ${source}`)
      entries.set(entry.rowId, entry as EvidenceExclusion)
    }
    return new EvidenceExclusions(source, raw, entries)
  }
  check(row: SeedRow, raw: Buffer, path: string): ExclusionAudit | undefined {
    const entry = this.entries.get(row.id)
    if (!entry) return undefined
    if (digest(raw) !== entry.rowSha256)
      throw new Error(`Evidence exclusion row SHA-256 mismatch: ${this.source}, ${row.id}`)
    if (entry.observationId !== undefined && row.observation?.id !== entry.observationId)
      throw new Error(`Evidence exclusion observation ID mismatch: ${this.source}, ${row.id}`)
    const observationId = row.observation?.id
    if (observationId !== undefined && (typeof observationId !== 'string' || !observationId.trim()))
      throw new Error(`Evidence exclusion original observation has an invalid ID: ${row.id}`)
    const audit: ExclusionAudit = {
      ...entry,
      ...(observationId ? { observationId } : {}),
      source: this.source,
      exclusionsSha256: digest(this.raw!),
      rowPath: resolve(path),
    }
    this.verified.set(row.id, audit)
    return audit
  }
  finish(): ExclusionAudit[] {
    const missing = [...this.entries.keys()].filter((id) => !this.verified.has(id))
    if (missing.length)
      throw new Error(`Evidence exclusions reference missing or unverified rows: ${missing.join(', ')}; ${this.source}`)
    return [...this.verified.values()]
  }
}
export const exclusionArchivePath = (destination: string, raw: Buffer): string =>
  join(destination, 'seed-evidence/exclusions', digest(raw))
