import { readFile, realpath } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { errorMessage, object, optionalObject } from './validation.js'
import { createWarning } from './warnings.js'

import type { Manager, Warning } from './types.js'

export const VOLTA_TOOLS = ['node', 'pnpm', 'yarn', 'npm'] as const
export type VoltaSettings = Partial<Record<'node' | Manager, { value: unknown; path: string }>>

/** Read inheritance without executing Volta, project hooks, or installation commands. */
export async function readVoltaConfig(path: string, manifest: Record<string, unknown>) {
  const settings: VoltaSettings = {}
  const warnings: Warning[] = []
  const seen = new Set<string>()
  let current = path
  let data = manifest
  for (;;) {
    try {
      const canonical = await realpath(current)
      if (seen.has(canonical)) throw new Error('Cyclic volta.extends configuration.')
      if (seen.size >= 32) throw new Error('volta.extends exceeds 32 configuration files.')
      seen.add(canonical)
      const volta = optionalObject(data.volta)
      for (const tool of VOLTA_TOOLS)
        if (!settings[tool] && volta[tool] !== undefined && volta[tool] !== null)
          settings[tool] = { value: volta[tool], path: current }
      if (volta.extends === undefined) break
      if (typeof volta.extends !== 'string' || !volta.extends.trim())
        throw new Error('volta.extends must be a nonempty file path.')
      current = resolve(dirname(current), volta.extends)
      current = await realpath(current)
      data = object(JSON.parse(await readFile(current, 'utf8')), current)
    } catch (error) {
      warnings.push(
        createWarning(
          'file-parse-failed',
          {
            file: 'Volta configuration',
            detail: errorMessage(error),
          },
          { path: current },
        ),
      )
      break
    }
  }
  return { settings, warnings }
}
