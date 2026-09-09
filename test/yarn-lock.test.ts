import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { fixtureIdentity } from '../maintenance/discover-fixtures.js'
import { detectFormat } from '../maintenance/runner.js'
import { matchesRule, normalizeSource } from '../src/constraints.js'
import { createSource } from '../src/sources.js'
import { readYarnLock } from '../src/yarn-lock.js'

import type { Fixture } from '../maintenance/model.js'
import type { CompatibilityData, CompatibilityRule } from '../src/types.js'

const nativeLock = JSON.stringify({ __metadata: { version: 9 }, workspaces: {}, entries: {}, islands: {} })
const berryLock = '__metadata:\n  version: 9\n  cacheKey: 10c0\n'

test('native JSON and Berry YAML carry independent lock families despite equal metadata versions', () => {
  assert.deepEqual(readYarnLock(nativeLock), { family: 'zpm', format: 9 })
  assert.deepEqual(readYarnLock(berryLock), { family: 'berry', format: 9, cacheKey: '10c0' })
  assert.deepEqual(readYarnLock(`\uFEFF \n${nativeLock}`), { family: 'zpm', format: 9 })
  assert.deepEqual(readYarnLock('# yarn lockfile v1\n'), { family: 'classic', format: 1 })
  assert.deepEqual(readYarnLock('{"workspaces":{},"entries":{}}'), { family: 'zpm' })
  assert.equal(readYarnLock('{"__metadata":').family, 'zpm')
  assert.ok(readYarnLock('{"__metadata":').error)
})

test('Yarn format rules are family scoped and absent family fields retain their historical meaning', () => {
  const berry = createSource('yarnLock', 9)
  const native = createSource('yarnLock', 9, { features: { yarnFamily: 'zpm' } })
  const berryRule: CompatibilityRule = { id: 'berry', manager: 'yarn', match: { format: 9 }, range: '>=4 <6' }
  // A hypothetical, explicitly supplied rule exercises matching without asserting production support.
  const nativeRule: CompatibilityRule = {
    id: 'native',
    manager: 'yarn',
    match: { format: 9, features: { yarnFamily: 'zpm' } },
    range: null,
  }
  assert.equal(matchesRule(berry, berryRule), true)
  assert.equal(matchesRule(native, berryRule), false)
  assert.equal(matchesRule(berry, nativeRule), false)
  assert.equal(matchesRule(native, nativeRule), true)
  assert.deepEqual(normalizeSource({ ...native, index: 0 }, [], [berryRule]).ranges, ['*'])
  assert.equal(normalizeSource({ ...native, index: 0 }, [], [berryRule]).compatibilityKnown, false)
})

test('maintenance preserves legacy match hashes and gives native format 9 a separate fixture identity', async () => {
  const recipes = JSON.parse(await readFile(new URL('../fixtures/recipes.json', import.meta.url), 'utf8')) as Fixture[]
  for (const recipe of recipes.filter((fixture) => fixture.manager === 'yarn')) {
    const content = await readFile(new URL(`../fixtures/${recipe.directory}/${recipe.lock}`, import.meta.url), 'utf8')
    assert.equal(JSON.stringify(detectFormat('yarn', content)), JSON.stringify(recipe.match))
  }
  const nativeMatch = detectFormat('yarn', nativeLock)
  assert.deepEqual(nativeMatch, { format: 9, classic: false, features: { yarnFamily: 'zpm' } })
  assert.notDeepEqual(nativeMatch, detectFormat('yarn', berryLock))
  assert.deepEqual(fixtureIdentity({ manager: 'yarn', version: '6.0.0', lock: 'yarn.lock' }, nativeMatch), {
    id: 'yarn-zpm-v9',
    directory: 'yarn/zpm-v9/basic',
  })
  assert.equal(
    recipes.some((recipe) => recipe.manager === 'yarn' && JSON.stringify(recipe.match) === JSON.stringify(nativeMatch)),
    false,
  )
  const compatibility = JSON.parse(
    await readFile(new URL('../data/compatibility.json', import.meta.url), 'utf8'),
  ) as CompatibilityData
  const native = createSource('yarnLock', 9, { features: { yarnFamily: 'zpm' } })
  assert.equal(
    compatibility.rules.some((rule) => matchesRule(native, rule)),
    false,
  )
  assert.throws(() => detectFormat('yarn', '{"__metadata":'), /parse/)
  assert.throws(() => detectFormat('yarn', '{"workspaces":{},"entries":{}}'), /Unknown yarn lock format/)
})
