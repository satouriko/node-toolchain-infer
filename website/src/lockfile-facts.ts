import semver from 'semver'

import compatibility from '../../data/compatibility.json' with { type: 'json' }
import recipes from '../../fixtures/recipes.json' with { type: 'json' }

import type { CompatibilityRule, KnownBug, Manager } from '../../src/types.js'

export interface LockfileFact extends CompatibilityRule {
  compiled: boolean
  generatedAt: string
  source: string
}
const rules = compatibility.rules as CompatibilityRule[]
const matchKey = (manager: string, match: CompatibilityRule['match']) =>
  JSON.stringify([manager, match.file, String(match.format), match.classic ?? false, match.features ?? {}])

// Recipes provide only the format inventory. An absent compiled rule is unknown,
// and its unrestricted inference fallback must never be presented as a confirmed match.
export const lockfileFacts: LockfileFact[] = recipes
  .map((recipe) => {
    const match = { ...recipe.match, file: recipe.lock }
    const rule = rules.find(
      (candidate) => matchKey(candidate.manager, candidate.match) === matchKey(recipe.manager, match),
    )
    return {
      ...(rule ?? { id: recipe.id, manager: recipe.manager as Manager, match, range: '*' }),
      compiled: Boolean(rule?.range && rule.range !== '*'),
      generatedAt: compatibility.generatedAt,
      source: rule ? 'data/compatibility.json' : 'fixtures/recipes.json',
    }
  })
  .sort(
    (a, b) =>
      a.manager.localeCompare(b.manager)
      || String(a.match.file).localeCompare(String(b.match.file))
      || String(a.match.format).localeCompare(String(b.match.format), 'en', { numeric: true }),
  )

export function lockfilesForVersion(manager: string, version: string, yarnFamily?: 'berry' | 'zpm') {
  const formats = lockfileFacts.filter(
    (fact) => fact.manager === manager && !(manager === 'yarn' && yarnFamily === 'zpm'),
  )
  const stable = semver.valid(version) !== null && semver.prerelease(version) === null
  const compatible = formats.filter((fact) => fact.compiled && stable && semver.satisfies(version, fact.range!))
  const bugs: KnownBug[] = [
    ...new Map(
      compatible.flatMap((fact) =>
        (fact.knownBugs ?? [])
          .filter((bug) => semver.satisfies(version, bug.range))
          .map((bug) => [bug.id, bug] as const),
      ),
    ).values(),
  ]
  return { compatible, unrestricted: formats.filter((fact) => !fact.compiled), bugs }
}
