import assert from 'node:assert/strict'
import test from 'node:test'

import { parseNodes, parseRegistry } from '../src/metadata.js'
import { resolve } from '../src/resolve.js'
import { createSource } from '../src/sources.js'
import { prereleaseCores } from '../src/versions.js'

import type { Catalog, Source } from '../src/types.js'

const catalog: Catalog = {
  schemaVersion: 1,
  generatedAt: '',
  sources: [],
  warnings: [],
  nodes: [
    { version: '22.0.0', npm: '10.0.0' },
    { version: '23.0.0-rc.1', npm: '11.0.0-beta.1' },
    { version: '24.0.0', npm: '10.0.0' },
  ],
  managers: {
    npm: [
      { version: '10.0.0', node: '>=18' },
      { version: '11.0.0-beta.1', node: '23.0.0-rc.1' },
    ],
    pnpm: [
      { version: '9.0.0', node: '>=18' },
      { version: '10.0.0-rc.1', node: '>=23.0.0-0' },
    ],
    yarn: [],
  },
}
const runtime = { node: '22.0.0', npm: '10.0.0', pnpm: '10.0.0-rc.1' }
const run = (sources: Source[] = []) => resolve({ runtime, sources }, catalog)

test('prerelease range discovery distinguishes admitted versions from generated exclusive bounds', () => {
  for (const range of ['18', '^18.2', '~18.2', '*', '<20', '>=20 <20.0.0-rc.1'])
    assert.deepEqual(prereleaseCores(range), [], range)
  assert.deepEqual(prereleaseCores('>=20.0.0-rc.1 <20.0.0 || 22.0.0-beta.1'), ['20.0.0', '22.0.0'])
  assert.deepEqual(prereleaseCores('<20.0.0-beta.1'), ['20.0.0'])
  assert.deepEqual(prereleaseCores('20.0.0-0'), ['20.0.0'])
})

test('official metadata omits prerelease Node and package-manager records', () => {
  assert.deepEqual(
    parseNodes([
      { version: 'v22.0.0', npm: '10.0.0' },
      { version: 'v23.0.0-rc.1', npm: '11.0.0' },
    ]).map((row) => row.version),
    ['22.0.0'],
  )
  assert.deepEqual(
    parseRegistry(
      { versions: { '9.0.0': { version: '9.0.0' }, '10.0.0-beta.1': { version: '10.0.0-beta.1' } } },
      { id: 'pnpm', url: 'https://registry.npmjs.org/pnpm' },
    ).map((row) => row.version),
    ['9.0.0'],
  )
})

test('automatic inference excludes prereleases from catalogs, running Node and local managers', () => {
  const result = resolve({ runtime: { node: '23.0.0-rc.1', npm: '11.0.0-beta.1' } }, catalog)
  assert.equal(result.node?.version, '24.0.0')
  assert.equal(result.packageManager?.version, '10.0.0')
  assert.deepEqual(result.candidates.nodes, ['24.0.0', '22.0.0'])
  assert.deepEqual(result.candidates.managerVersions, ['10.0.0'])
  assert.ok(result.warnings.some((warning) => warning.code === 'prerelease-excluded'))
  const pnpm = run([createSource('pnpmLock', 'unseen')])
  assert.equal(pnpm.packageManager?.version, '9.0.0')
})

test('an exact packageManager prerelease is allowed but its derived Node candidates remain stable', () => {
  const result = run([createSource('packageManager', 'pnpm@10.0.0-rc.1')])
  assert.equal(result.packageManager?.version, '10.0.0-rc.1')
  assert.equal(result.packageManager.reason, 'exact')
  assert.equal(result.node?.version, '24.0.0')
  assert.deepEqual(result.candidates.nodes, ['24.0.0'])
  assert.deepEqual(result.trace[0].derivedNodeRanges, ['>=23.0.0-0'])
  assert.ok(!result.warnings.some((warning) => warning.code === 'prerelease-excluded'))
})

test('an exact Node prerelease is allowed without automatically opting its bundled npm into prereleases', () => {
  const result = run([createSource('nvmrc', '23.0.0-rc.1')])
  assert.equal(result.node?.version, '23.0.0-rc.1')
  assert.equal(result.node.reason, 'exact')
  assert.equal(result.packageManager?.version, '10.0.0')
})

test('two exact prereleases can form a runnable pair even when neither runs with stable alternatives', () => {
  const result = run([
    createSource('remoteNode', '23.0.0-rc.1', { depth: -1 }),
    createSource('remotePackageManager', 'npm@11.0.0-beta.1', { depth: -1 }),
  ])
  assert.equal(result.node?.version, '23.0.0-rc.1')
  assert.equal(result.packageManager?.version, '11.0.0-beta.1')
})

test('explicit ranges use standard semver prerelease matching for each tool independently', () => {
  const result = run([
    createSource('remoteNode', '>=23.0.0-rc.1', { depth: -1 }),
    createSource('packageManager', 'pnpm@>=9.0.0-0'),
  ])
  assert.equal(result.node?.version, '24.0.0')
  assert.equal(result.packageManager?.version, '9.0.0')
  assert.deepEqual(result.candidates.nodes, ['24.0.0', '23.0.0-rc.1'])
  assert.deepEqual(result.trace[1].derivedNodeRanges, ['>=18'])
})

test('an explicit package-manager range admits prereleases while derived Node candidates stay stable', () => {
  for (const key of ['remotePackageManager', 'packageManager', 'devPackageManager']) {
    const result = run([createSource(key, 'pnpm@>=10.0.0-rc.0 <10.0.0')])
    assert.equal(result.packageManager?.version, '10.0.0-rc.1', key)
    assert.equal(result.node?.version, '24.0.0', key)
    assert.deepEqual(result.candidates.nodes, ['24.0.0'])
    assert.deepEqual(result.trace[0].derivedNodeRanges, ['>=23.0.0-0'])
  }
})

test('an explicit Node range can select a prerelease without admitting npm prereleases', () => {
  for (const key of ['remoteNode', 'nvmrc', 'enginesNode']) {
    const result = run([createSource(key, '>=23.0.0-rc.0 <23.0.0')])
    assert.equal(result.node?.version, '23.0.0-rc.1', key)
    assert.equal(result.packageManager?.version, '10.0.0', key)
    assert.deepEqual(result.candidates.managerVersions, ['10.0.0'])
  }
})

test('explicit ranges can keep a running prerelease and form a pair requiring both prereleases', () => {
  const sources = [
    createSource('remoteNode', '>=23.0.0-rc.0 <23.0.0', { depth: -1 }),
    createSource('remotePackageManager', 'npm@>=11.0.0-beta.0 <11.0.0', { depth: -1 }),
  ]
  const result = resolve({ runtime: { node: '23.0.0-rc.1', npm: '11.0.0-beta.1' }, sources }, catalog)
  assert.equal(result.node?.version, '23.0.0-rc.1')
  assert.equal(result.node.reason, 'current')
  assert.equal(result.packageManager?.version, '11.0.0-beta.1')
})

test('a conflicting range cannot enable prereleases or override a higher-priority lockfile', () => {
  const sources = [createSource('pnpmLock', '9'), createSource('enginesPnpm', '>=10.0.0-rc.0 <10.0.0')]
  const result = resolve({ runtime, sources }, catalog, [
    { id: 'stable-lock', manager: 'pnpm', range: '>=9', match: { format: '9' } },
  ])
  assert.equal(result.packageManager?.version, '9.0.0')
  assert.deepEqual(result.candidates.managerVersions, ['9.0.0'])
  assert.equal(result.trace[1].status, 'ignored')
})

test('a discarded exact prerelease cannot leak into automatic candidates or their derived requirements', () => {
  const result = run([
    createSource('remotePackageManager', 'pnpm@9', { depth: -1 }),
    createSource('packageManager', 'pnpm@10.0.0-rc.1'),
  ])
  assert.equal(result.packageManager?.version, '9.0.0')
  assert.equal(result.node?.version, '22.0.0')
  assert.deepEqual(result.candidates.managerVersions, ['9.0.0'])
  assert.deepEqual(result.candidates.nodes, ['24.0.0', '22.0.0'])
  assert.equal(result.trace[1].status, 'ignored')
})

test('equality comparators are exact declarations, not a request to enumerate prereleases', () => {
  const result = run([createSource('packageManager', 'pnpm@=10.0.0-rc.1')])
  assert.equal(result.packageManager?.version, '10.0.0-rc.1')
})
