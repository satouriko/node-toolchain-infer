import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import semver from 'semver'

import { compileRules } from '../maintenance/compile-compatibility.js'
import { compileInitial } from '../maintenance/compile-initial.js'
import { compareBehavior } from '../maintenance/monitor.js'
import { rulesFrom } from '../src/data-validation.js'

import { makeObservation } from './maintenance-fixture.js'

import type { Fixture } from '../maintenance/model.js'
import type { Catalog, CompatibilityRule } from '../src/types.js'

const recipes = JSON.parse(await readFile(new URL('../fixtures/recipes.json', import.meta.url), 'utf8')) as Fixture[]
const fixtures = recipes.filter((fixture) => ['yarn-classic-v1', 'yarn-modern-v7'].includes(fixture.id))
const versions = ['0.20.4', '0.21.0', '1.22.22', '2.1.0', '4.18.1']
const catalog: Catalog = {
  schemaVersion: 1,
  generatedAt: '2026-09-28T00:00:00Z',
  sources: [],
  warnings: [],
  nodes: [],
  managers: { npm: [], pnpm: [], yarn: versions.map((version) => ({ version, node: '*' })) },
}

function verifyPolicies(rules: CompatibilityRule[]) {
  for (const [format, expected] of [
    [1, [false, true, true, false, false]],
    [7, [false, false, false, false, false]],
  ] as const) {
    const rule = rules.find((item) => item.manager === 'yarn' && item.match.format === format)
    assert.ok(rule?.range, `format ${format} must have an explicit policy`)
    assert.equal(rule.match.file, 'yarn.lock')
    assert.deepEqual(
      versions.map((version) => semver.satisfies(version, rule.range!)),
      expected,
    )
  }
}

test('initial compilation retains Yarn policies without inventing historical measurements', () => {
  const result = compileInitial({
    catalog,
    fixtures,
    fixtureHashes: Object.fromEntries(fixtures.map((fixture) => [fixture.id, 'unmeasured-fixture'])),
    rows: [],
  })
  verifyPolicies(result.data.rules)
  for (const fixture of result.report.fixtures) {
    assert.ok(fixture.policy?.reason)
    assert.ok(fixture.points.every((point) => point.outcome === 'unknown' && point.evidenceIds.length === 0))
  }
  assert.equal(result.report.exitCode, 2, 'policy decisions must not turn missing experiments into passes')
})

test('boundary compilation retains the same Yarn policies when no measured lower boundary exists', () => {
  verifyPolicies(compileRules(fixtures, [], [], { npm: [], pnpm: [], yarn: versions }))
})

test('shipped Yarn policies accept expected 4.18.1 rejections and still flag unexpected support', async () => {
  const rules = rulesFrom(JSON.parse(await readFile(new URL('../data/compatibility.json', import.meta.url), 'utf8')))
  verifyPolicies(rules)
  for (const fixture of fixtures) {
    const matching = rules.filter((rule) => rule.manager === 'yarn' && rule.match.format === fixture.match.format)
    const rejected = makeObservation({
      manager: 'yarn',
      version: '4.18.1',
      fixtureId: fixture.id,
      status: 'incompatible',
    })
    assert.deepEqual(compareBehavior(rejected, [], matching), { expected: false, basis: 'rule', mismatch: false })
    assert.equal(compareBehavior({ ...rejected, status: 'pass' }, [], matching).mismatch, true)
  }
})
