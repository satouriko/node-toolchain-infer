import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { digest, type Issues, type Outcome } from './model.js'

import type { Manager, ManagerRelease } from '../src/types.js'

export interface RecordedRelease {
  key: string
  manager: Manager
  version: string
  checkedAt: string
  origin: 'seed' | 'check' | 'migration'
  outcomes: Record<string, Outcome>
  sources: string[]
  issues?: Issues
  exitCode?: 0 | 1 | 2
  receiptPath?: string
}

// Scheduling identity is independent of the current machine and compiled compatibility rules.
// A replaced official artifact must be checked even when its version string is unchanged.
export function releaseHistoryKey(manager: Manager, release: ManagerRelease): string {
  return `${manager}@${release.version}:${digest(
    JSON.stringify({
      integrity: release.integrity,
      url: release.tarball ?? release.bundle?.url,
      runtime: release.runtime,
    }),
  )}`
}

export async function recordRelease(directory: string, result: RecordedRelease): Promise<RecordedRelease> {
  const raw = `${JSON.stringify(result, null, 2)}\n`
  const receiptPath = `checks/${digest(raw)}.json`
  await mkdir(join(directory, 'checks'), { recursive: true })
  try {
    await writeFile(join(directory, receiptPath), raw, { flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  return { ...result, receiptPath }
}

export async function writeHistory(directory: string, results: Record<string, RecordedRelease>): Promise<void> {
  const records = Object.values(results).sort((a, b) => a.key.localeCompare(b.key))
  await writeFile(join(directory, 'history.json'), `${JSON.stringify(records, null, 2)}\n`)
  const lines = [
    '# Recorded release checks',
    '',
    'Historical results are retained without changing their original outcomes. Daily checks skip these exact artifacts; use --incremental --retry-failed to retry recorded failures.',
    '',
    '| Release | Recorded | Raw fixture outcomes | Check result | Evidence |',
    '| --- | --- | --- | --- | --- |',
    ...records.map((record) => {
      const counts = new Map<string, number>()
      for (const outcome of Object.values(record.outcomes)) counts.set(outcome, (counts.get(outcome) ?? 0) + 1)
      const outcomes =
        [...counts].map(([status, count]) => `${status}: ${count}`).join(', ') || 'Tool preparation failed'
      return `| ${record.manager}@${record.version} | ${record.checkedAt} | ${outcomes} | ${record.exitCode ?? 'historical measurement'} | [receipt](${record.receiptPath}) |`
    }),
    '',
  ]
  await writeFile(join(directory, 'history.md'), lines.join('\n'))
}
