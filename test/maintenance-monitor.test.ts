import assert from 'node:assert/strict'
import test from 'node:test'

import { compareBehavior, selectReleaseBatch } from '../maintenance/monitor.js'
import { frozenArgs } from '../maintenance/runner.js'

import { makeObservation } from './maintenance-fixture.js'

import type { CompatibilityRule } from '../src/types.js'

const rule: CompatibilityRule = {
  id: 'lock9',
  manager: 'pnpm',
  match: { format: '9.0' },
  range: '>=9.0.0',
}
test('unknown bounds still alert when comparable observed behavior changes', () => {
  const before = makeObservation({
    id: 'before',
    version: '10.0.0',
    command: frozenArgs('npm', '10.0.0'),
    status: 'pass',
  })
  const after = makeObservation({
    id: 'after',
    version: '10.1.0',
    command: frozenArgs('npm', '10.1.0'),
    status: 'incompatible',
  })
  assert.deepEqual(compareBehavior(after, [before], []), {
    expected: true,
    basis: 'observation',
    evidenceId: 'before',
    mismatch: true,
  })
  assert.equal(compareBehavior({ ...after, status: 'pass' }, [before], []).mismatch, false)
  assert.equal(compareBehavior(after, [{ ...before, fixtureHash: 'different' }], []).basis, 'unestablished')
  assert.equal(compareBehavior(after, [], []).mismatch, true)
})
test('stable rules do not manufacture prerelease incompatibility', () => {
  const before = makeObservation({
    id: 'prior',
    manager: 'pnpm',
    version: '9.4.0',
    command: frozenArgs('pnpm', '9.4.0'),
    status: 'pass',
  })
  const beta = makeObservation({
    id: 'beta',
    manager: 'pnpm',
    version: '9.5.0-beta.3',
    command: frozenArgs('pnpm', '9.5.0-beta.3'),
    status: 'pass',
  })
  assert.deepEqual(compareBehavior(beta, [before], [rule]), {
    expected: undefined,
    basis: 'unestablished',
    mismatch: false,
  })
  assert.equal(compareBehavior({ ...beta, version: '10.0.0-alpha.0' }, [before], [rule]).mismatch, false)
  assert.equal(compareBehavior({ ...beta, version: '8.15.9' }, [before], [rule]).mismatch, true)
})
test('historical version comparisons require equal explicit install environments', () => {
  const environment = { npm_config_auto_install_peers: 'true', npm_config_exclude_links_from_lockfile: 'false' }
  const before = makeObservation({ id: 'before', version: '10.0.0', command: frozenArgs('npm', '10.0.0') })
  const after = makeObservation({ id: 'after', version: '10.1.0', command: before.command, environment })
  for (const recorded of [undefined, {}, { ...environment, npm_config_auto_install_peers: 'false' }])
    assert.equal(compareBehavior(after, [{ ...before, environment: recorded }], []).basis, 'unestablished')
  assert.equal(
    compareBehavior(
      after,
      [
        {
          ...before,
          environment: { npm_config_exclude_links_from_lockfile: 'false', npm_config_auto_install_peers: 'true' },
        },
      ],
      [],
    ).basis,
    'observation',
  )
  assert.equal(
    compareBehavior({ ...after, environment: undefined }, [{ ...before, environment: {} }], []).basis,
    'observation',
  )
})
test('blocked retry releases cannot starve untouched old branches', () => {
  const retry = Array.from({ length: 8 }, (_, i) => ({ key: `retry-${i}` }))
  const fresh = Array.from({ length: 20 }, (_, i) => ({ key: `old-patch-${i}` }))
  const attempts: Record<string, string> = Object.fromEntries(retry.map((item) => [item.key, '2026-01-01']))
  let queue = [...retry, ...fresh]
  for (let batch = 0; batch < 5; batch++) {
    const selected = selectReleaseBatch(queue, attempts, 8, batch)
    assert.ok(
      selected.some((item) => item.key.startsWith('old-patch-'))
        || !queue.some((item) => item.key.startsWith('old-patch-')),
    )
    for (const item of selected) attempts[item.key] = `2026-02-0${batch + 1}`
    queue = queue.filter((item) => !selected.includes(item) || item.key.startsWith('retry-'))
  }
  assert.equal(queue.filter((item) => item.key.startsWith('old-patch-')).length, 0)
  assert.deepEqual(selectReleaseBatch([...retry, { key: 'new-last' }], attempts, 1, 0), [{ key: 'new-last' }])
})

test('historical observations using the wrong version-specific frozen option cannot establish expected behavior', () => {
  const command = ['install', '--frozen-lockfile', '--ignore-scripts']
  const before = makeObservation({
    id: 'old-command',
    manager: 'pnpm',
    version: '2.25.7',
    command,
    status: 'incompatible',
  })
  const after = makeObservation({
    id: 'current-command',
    manager: 'pnpm',
    version: '3.0.0',
    command,
    status: 'incompatible',
  })
  assert.deepEqual(compareBehavior(after, [before], []), {
    expected: undefined,
    basis: 'unestablished',
    mismatch: true,
  })
})
