import assert from 'node:assert/strict'
import test from 'node:test'

import semver from 'semver'

import {
  bugSummary,
  compatibilityOutcome,
  type KnownBugReview,
  loadKnownBugs,
  observationFingerprint,
  reviewedBug,
  stableBugRange,
  validateKnownBugs,
} from '../maintenance/known-bugs.js'
import { compareBehavior } from '../maintenance/monitor.js'
import { frozenArgs } from '../maintenance/runner.js'

import { makeObservation } from './maintenance-fixture.js'

const observation = makeObservation({
  id: 'reviewed-rewrite',
  fixtureId: 'pnpm-5.1',
  manager: 'pnpm',
  version: '7.28.0',
  actualVersion: '7.28.0',
  status: 'rewrite',
  command: frozenArgs('pnpm', '7.28.0'),
})
const bug: KnownBugReview = {
  id: 'pnpm-6158',
  manager: 'pnpm',
  range: '>=7.28.0 <7.30.1',
  fixtureIds: ['pnpm-5.1'],
  reason: 'The installer rewrites a semantically unchanged lock.',
  url: 'https://github.com/pnpm/pnpm/issues/6158',
  semanticEvidence: 'Reviewed reader and serializer; the locked graph remains identical.',
  reviewedAt: '2026-09-09T00:00:00Z',
  observations: [{ id: observation.id, fingerprint: observationFingerprint(observation) }],
}
test('known-bug reviews apply to exact evidence, never blanket-pass failures in the affected release', () => {
  assert.equal(compatibilityOutcome(observation, [bug]), 'supported')
  assert.equal(observation.status, 'rewrite')
  assert.equal(compatibilityOutcome({ ...observation, id: 'different-failure' }, [bug]), 'unsupported')
  assert.throws(() => reviewedBug({ ...observation, exitCode: 1 }, [bug]), /no longer matches/)
  assert.throws(() => reviewedBug(observation, [{ ...bug, range: '>=8' }]), /no longer matches/)
  assert.throws(() => reviewedBug(observation, [{ ...bug, fixtureIds: ['pnpm-9'] }]), /no longer matches/)
  assert.equal(reviewedBug({ ...observation, logPath: 'archived/copied.log' }, [bug])?.id, bug.id)
})
test('a bug review requires an independent semantic basis and cannot give one observation conflicting exemptions', () => {
  assert.throws(() => validateKnownBugs({ schemaVersion: 1, bugs: [{ ...bug, semanticEvidence: '' }] }), /Invalid/)
  assert.throws(() => validateKnownBugs({ schemaVersion: 1, bugs: [bug, { ...bug, id: 'another' }] }), /duplicate/)
})
test('the monitor accepts reviewed semantic compatibility while retaining alerts for unrelated failures', () => {
  const rules = [
    { id: 'pnpm-5.1', manager: 'pnpm' as const, match: { format: '5.1' }, range: '>=7', knownBugs: [bugSummary(bug)] },
  ]
  assert.equal(compareBehavior(observation, [], rules, [bug]).mismatch, false)
  assert.equal(compareBehavior({ ...observation, id: 'not-reviewed' }, [], rules, [bug]).mismatch, true)
})

test('compiled bug summaries retain every stable boundary and never include prerelease comparators', () => {
  for (const [input, expected] of [
    ['>=7.0.0-beta.6 <8.4.1', '>=7.0.0 <8.4.1'],
    ['>=7.28.0-0 <7.30.1', '>=7.28.0 <7.30.1'],
    ['>=9.0.0-rc.0 <9.0.1', '>=9.0.0 <9.0.1'],
    ['>7.0.0-beta.6 <=8.0.0-rc.0', '>=7.0.0 <8.0.0'],
    ['>=7.0.0 <8.0.0-rc.0', '>=7.0.0 <8.0.0'],
    ['>7.0.0 <=8.0.0', '>7.0.0 <=8.0.0'],
    ['7.0.0-beta.6', '<0.0.0'],
    ['>=7.0.0-beta.6 <7.0.0', '<0.0.0'],
    ['>7.0.0 <7.0.1', '<0.0.0'],
    ['7.0.0-beta.6 || >=7.28.0-0 <7.30.1', '>=7.28.0 <7.30.1'],
    ['*', '*'],
  ]) {
    const reviewed = { ...bug, range: input }
    const original = JSON.stringify(reviewed)
    assert.equal(bugSummary(reviewed).range, expected)
    assert.equal(JSON.stringify(reviewed), original)
    for (const version of [
      '0.0.0',
      '6.99.99',
      '7.0.0',
      '7.0.1',
      '7.28.0',
      '7.30.0',
      '7.30.1',
      '8.0.0',
      '8.4.0',
      '8.4.1',
      '9.0.0',
      '9.0.1',
      '10.0.0',
    ])
      assert.equal(semver.satisfies(version, expected), semver.satisfies(version, input), `${input}: ${version}`)
    for (const comparators of new semver.Range(expected).set)
      for (const comparator of comparators) if (comparator.value) assert.equal(comparator.semver.prerelease.length, 0)
  }
})

test('each comparator projects prerelease bounds with identical stable membership', () => {
  for (const operator of ['', '=', '>', '>=', '<', '<='])
    for (const endpoint of ['1.2.3-beta.1', '1.2.3']) {
      const input = `${operator}${endpoint}`
      const projected = stableBugRange(input)
      for (const version of ['0.0.0', '1.2.2', '1.2.3', '1.2.4', '1.3.0', '2.0.0'])
        assert.equal(semver.satisfies(version, projected), semver.satisfies(version, input), input)
    }
})

test('the active bug registry contains only families affecting stable releases', async () => {
  const active = await loadKnownBugs(new URL('../maintenance/known-bugs.json', import.meta.url))
  assert.ok(active.length)
  for (const review of active) assert.notEqual(semver.minVersion(stableBugRange(review.range)), null, review.id)
})
