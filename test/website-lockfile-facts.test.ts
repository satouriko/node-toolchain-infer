import assert from 'node:assert/strict'
import test from 'node:test'

import { lockfileFacts, lockfilesForVersion } from '../website/src/lockfile-facts.js'

test('version facts use the shipped compatibility ranges and retain installation bug markers', () => {
  const pnpm = lockfilesForVersion('pnpm', '5.17.0')
  assert.deepEqual(
    pnpm.compatible.filter((rule) => rule.match.file === 'pnpm-lock.yaml').map((rule) => String(rule.match.format)),
    ['5', '5.1', '5.2', '5.3', '5.4'],
  )
  assert.ok(pnpm.bugs.some((bug) => bug.id === 'pnpm-auto-import-5.17.0'))
  assert.ok(lockfilesForVersion('pnpm', '9.4.0').compatible.some((rule) => rule.match.format === '9.0'))
  assert.equal(lockfilesForVersion('pnpm', '13.0.0-alpha.0').compatible.length, 0)
  assert.ok(lockfilesForVersion('pnpm', '13.0.0').compatible.some((rule) => rule.match.format === '9.0'))
})

test('facts show all fixture formats and distinguish uncompiled formats from confirmed compatibility', () => {
  assert.equal(lockfileFacts.length, 23)
  assert.equal(lockfileFacts.filter((fact) => fact.compiled).length, 21)
  assert.ok(
    lockfileFacts.every(
      (fact) => fact.generatedAt && ['data/compatibility.json', 'fixtures/recipes.json'].includes(fact.source),
    ),
  )
  const yarn = lockfilesForVersion('yarn', '4.1.0')
  assert.ok(yarn.unrestricted.some((rule) => rule.match.classic === true))
  assert.ok(yarn.unrestricted.some((rule) => rule.match.format === 7))
  assert.ok(yarn.compatible.some((rule) => rule.match.format === 8))
  assert.equal(
    yarn.compatible.some((rule) => rule.match.classic === true),
    false,
  )
  assert.equal(
    lockfilesForVersion('npm', '12.0.0').compatible.some((rule) => rule.match.file === 'npm-shrinkwrap.json'),
    false,
  )
  const shared = lockfileFacts.find((rule) => rule.match.file === 'shrinkwrap.yaml' && rule.match.format === '4')
  assert.deepEqual(shared?.match.features, { sharedWorkspace: true })
})

test('prereleases and invalid versions never produce confirmed format or bug matches', () => {
  for (const [manager, version] of [
    ['pnpm', '9.0.0-rc.0'],
    ['npm', '7.0.0-beta.6'],
    ['yarn', '3.1.0-rc.11'],
    ['pnpm', 'invalid'],
  ]) {
    const result = lockfilesForVersion(manager, version)
    assert.deepEqual(result.compatible, [])
    assert.deepEqual(result.bugs, [])
  }
  const bugIds = lockfilesForVersion('pnpm', '5.17.0').bugs.map((bug) => bug.id)
  assert.equal(new Set(bugIds).size, bugIds.length)
})

test('native Yarn JSON stays isolated while Berry YAML ranges remain forward-permissive', () => {
  const berry = lockfilesForVersion('yarn', '6.0.0', 'berry')
  assert.ok(berry.compatible.some((rule) => rule.match.format === 10))

  const native = lockfilesForVersion('yarn', '6.0.0', 'zpm')
  assert.deepEqual(native.compatible, [])
  assert.deepEqual(native.unrestricted, [])
})
