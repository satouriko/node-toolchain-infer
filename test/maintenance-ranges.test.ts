import assert from 'node:assert/strict'
import test from 'node:test'

import semver from 'semver'

import { type Boundary, compileRules } from '../maintenance/compile-compatibility.js'
import { compileRanges } from '../maintenance/compile-ranges.js'
import { observationFingerprint } from '../maintenance/known-bugs.js'
import { frozenArgs } from '../maintenance/runner.js'

import { makeObservation } from './maintenance-fixture.js'

import type { Fixture, Observation } from '../maintenance/model.js'

const fixture: Fixture = {
  id: 'lock',
  manager: 'pnpm',
  version: '2.0.0',
  directory: '',
  lock: 'pnpm-lock.yaml',
  match: { format: '9.0' },
  dependencies: {},
}
function observation(id: string, version: string, status: Observation['status']): Observation {
  return makeObservation({
    id,
    manager: 'pnpm',
    version,
    actualVersion: version,
    command: frozenArgs('pnpm', version),
    fixtureId: 'lock',
    fixtureHash: 'same',
    platform: 'linux',
    arch: 'x64',
    node: '18.20.8',
    status,
  })
}
const records = [
  observation('a', '1.0.0', 'incompatible'),
  observation('b', '2.0.0', 'pass'),
  observation('c', '3.0.0', 'incompatible'),
  observation('d', '4.0.0', 'pass'),
]
const boundaries: Boundary[] = [
  { fixtureId: 'lock', before: 'a', after: 'b' },
  { fixtureId: 'lock', before: 'b', after: 'c' },
  { fixtureId: 'lock', before: 'c', after: 'd' },
]

test('stable intervals never opt prerelease versions into generated compatibility', () => {
  const open = compileRanges([{ lower: '9.0.0' }])
  const closed = compileRanges([{ lower: '9.0.0', upper: '11.0.0' }])
  assert.equal(open, '>=9.0.0')
  assert.equal(closed, '>=9.0.0 <11.0.0')
  for (const range of [open, closed])
    for (const version of ['9.0.0-rc.0', '10.14.0-0', '10.14.0-beta.0', '11.0.0-alpha.0'])
      assert.equal(semver.satisfies(version, range), false, version)
  assert.ok(semver.satisfies('11.0.0', open))
  assert.equal(semver.satisfies('11.0.0', closed), false)
})
test('compiled confirmed boundaries preserve restored support and open upper bounds', () => {
  const rules = compileRules([fixture], boundaries, records, {
    pnpm: ['1.0.0', '2.0.0', '3.0.0', '4.0.0'],
    npm: [],
    yarn: [],
  })
  assert.equal(rules[0]?.range, '>=2.0.0 <3.0.0 || >=4.0.0')
  assert.equal(Object.hasOwn(rules[0], 'provenance'), false)
})

test('the explicit-boundary compiler also requires current controls and identical Node integrity', () => {
  const versions = { pnpm: ['1.0.0', '2.0.0'], npm: [], yarn: [] }
  assert.throws(
    () =>
      compileRules(
        [{ ...fixture, controlDependencies: { example: '2.0.0' } }],
        boundaries.slice(0, 1),
        records,
        versions,
      ),
    /control/i,
  )
  assert.throws(
    () =>
      compileRules(
        [fixture],
        boundaries.slice(0, 1),
        [{ ...records[0], nodeIntegrity: 'another-node' }, records[1]],
        versions,
      ),
    /Node/,
  )
})
test('sparse samples, environment failures, changed fixtures and absent receipts cannot confirm bounds', () => {
  const versions = { pnpm: ['1.0.0', '1.5.0', '2.0.0'], npm: [], yarn: [] }
  assert.throws(() => compileRules([fixture], boundaries.slice(0, 1), records, versions), /adjacent/)
  assert.throws(
    () =>
      compileRules([fixture], boundaries.slice(0, 1), [{ ...records[0], status: 'inconclusive' }, records[1]], {
        ...versions,
        pnpm: ['1.0.0', '2.0.0'],
      }),
    /conclusive/,
  )
  assert.throws(
    () =>
      compileRules([fixture], boundaries.slice(0, 1), [{ ...records[0], fixtureHash: 'other' }, records[1]], {
        ...versions,
        pnpm: ['1.0.0', '2.0.0'],
      }),
    /same fixture/,
  )
})

test('explicit boundaries cannot compare opposite outcomes with different install settings', () => {
  assert.throws(
    () =>
      compileRules(
        [fixture],
        boundaries.slice(0, 1),
        [
          { ...records[0], environment: { npm_config_auto_install_peers: 'false' } },
          { ...records[1], environment: { npm_config_auto_install_peers: 'true' } },
        ],
        { pnpm: ['1.0.0', '2.0.0'], npm: [], yarn: [] },
      ),
    /environment/i,
  )
})

test('explicit boundaries reject stale frozen commands on either side, including negatives', () => {
  const versions = { pnpm: ['1.0.0', '2.0.0'], npm: [], yarn: [] }
  for (const changed of [0, 1]) {
    const pair = records
      .slice(0, 2)
      .map((record, index) =>
        index === changed ? { ...record, command: ['install', '--frozen-lockfile', '--ignore-scripts'] } : record,
      )
    assert.throws(() => compileRules([fixture], boundaries.slice(0, 1), pair, versions), /command/i)
  }
})

test('historical prerelease boundary pairs never contribute generated stable rules', () => {
  const before = observation('pre-before', '2.0.0-beta.0', 'incompatible')
  const after = observation('pre-after', '2.0.0-beta.1', 'pass')
  const original = JSON.stringify([before, after])
  const rules = compileRules(
    [fixture],
    [...boundaries, { fixtureId: fixture.id, before: before.id, after: after.id }],
    [...records, before, after],
    {
      pnpm: ['1.0.0', '2.0.0-beta.0', '2.0.0-beta.1', '2.0.0', '3.0.0', '4.0.0'],
      npm: [],
      yarn: [],
    },
  )
  assert.equal(rules[0].range, '>=2.0.0 <3.0.0 || >=4.0.0')
  assert.equal(JSON.stringify([before, after]), original)
})

test('explicit-boundary compilation projects published bug markers without extending their upper bound', () => {
  const failed = observation('reviewed-bug', '4.1.0', 'incompatible')
  const review = {
    id: 'installer-bug',
    manager: 'pnpm' as const,
    range: '>=4.1.0-beta.1 <4.2.0',
    reason: 'Independent evidence establishes reader support.',
    url: 'https://example.com/upstream-bug',
    fixtureIds: [fixture.id],
    semanticEvidence: 'Reviewed reader implementation.',
    reviewedAt: '2026-09-09T00:00:00Z',
    observations: [{ id: failed.id, fingerprint: observationFingerprint(failed) }],
  }
  const rules = compileRules(
    [fixture],
    boundaries,
    [...records, failed],
    {
      pnpm: ['1.0.0', '2.0.0', '3.0.0', '4.0.0', '4.1.0'],
      npm: [],
      yarn: [],
    },
    [review],
  )
  assert.equal(rules[0].knownBugs?.[0]?.range, '>=4.1.0 <4.2.0')
  assert.equal(review.range, '>=4.1.0-beta.1 <4.2.0')
})
