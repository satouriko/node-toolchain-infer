import type { Fixture } from './model.js'
import type { CompatibilityRule } from '../src/types.js'

interface CompatibilityPolicy {
  fixtureId: string
  reason: string
  rule: CompatibilityRule
}

// Project support decisions, not claims that every historical release was measured.
const policies: CompatibilityPolicy[] = [
  {
    fixtureId: 'yarn-classic-v1',
    reason: 'Adopt 0.21.0 as the project support floor; retain the confirmed 2.1.0 migration boundary.',
    rule: {
      id: 'policy-yarn-classic-v1',
      manager: 'yarn',
      match: { file: 'yarn.lock', format: 1, classic: true },
      range: '>=0.21.0 <2.1.0',
    },
  },
  {
    fixtureId: 'yarn-modern-v7',
    reason: 'Treat format 7 as having no supported stable release; archived RC evidence is unchanged.',
    rule: {
      id: 'policy-yarn-modern-v7',
      manager: 'yarn',
      match: { file: 'yarn.lock', format: 7, classic: false },
      range: '<0.0.0',
    },
  },
]

export function compatibilityPolicy(fixture: Fixture): CompatibilityPolicy | undefined {
  return policies.find(
    ({ fixtureId, rule }) =>
      fixtureId === fixture.id
      && rule.manager === fixture.manager
      && rule.match.file === fixture.lock
      && rule.match.format === fixture.match.format
      && rule.match.classic === fixture.match.classic
      && !Object.keys(fixture.match.features ?? {}).length,
  )
}
