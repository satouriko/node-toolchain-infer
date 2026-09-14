import { MANAGERS, normalizeSource } from './constraints.js'

import type { CompatibilityRule, Manager, ResolveResult, Source } from './types.js'

/** Only a valid, unconditional declaration can select a manager other than npm. */
export function managerForSource(source: Source, rules: CompatibilityRule[]): Manager | undefined {
  if (source.target === 'node') return undefined
  try {
    return normalizeSource({ ...source, index: 0 }, [], rules).manager
  } catch {
    return undefined
  }
}

export function managerCandidates(sources: Source[], rules: CompatibilityRule[]): Manager[] {
  const managers = sources.flatMap((source) => {
    const manager = source.conditional ? undefined : managerForSource(source, rules)
    return manager ? [manager] : []
  })
  return [...new Set([...managers, 'npm' as const])]
}

/** A missing manager only needs metadata if its best possible priority score could win. */
export function mayChangeSelection(manager: Manager, result: ResolveResult): boolean {
  const selected = result.packageManager?.name
  if (!selected || selected === manager) return true
  for (const source of result.trace) {
    const actual = source.status === 'accepted' || source.status === 'inactive' ? 1 : 0
    const possible =
      source.status === 'invalid' || (source.target === 'manager' && !source.conditional && source.manager !== manager)
        ? 0
        : 1
    if (actual !== possible) return possible > actual
  }
  return MANAGERS.indexOf(manager) < MANAGERS.indexOf(selected)
}
