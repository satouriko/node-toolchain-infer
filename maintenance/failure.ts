import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function recordFailure(directory: string, context: string, error: unknown): Promise<string> {
  const parts = [context]
  const visited = new Set<unknown>()
  let current = error
  while (current && !visited.has(current)) {
    visited.add(current)
    if (current instanceof Error) parts.push(current.stack ?? current.message)
    else parts.push(typeof current === 'string' ? current : 'Non-Error cause')
    if (typeof current !== 'object') break
    const details = current as { stdout?: unknown; stderr?: unknown; cause?: unknown }
    for (const output of [details.stdout, details.stderr]) if (typeof output === 'string') parts.push(output)
    current = details.cause
  }
  const path = `logs/failure-${randomUUID()}.log`
  await mkdir(join(directory, 'logs'), { recursive: true })
  await writeFile(join(directory, path), `${parts.join('\n')}\n`, { flag: 'wx' })
  return path
}
