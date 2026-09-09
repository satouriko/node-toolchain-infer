import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import process from 'node:process'
import test from 'node:test'

import { selectNode, verifyIntegrity } from '../maintenance/provision.js'
import { detectFormat, frozenArgs } from '../maintenance/runner.js'

test('tarball provisioning rejects modified bytes', () => {
  const bytes = Buffer.from('official content')
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
  assert.doesNotThrow(() => verifyIntegrity(bytes, integrity))
  assert.throws(() => verifyIntegrity(Buffer.from('modified'), integrity), /integrity/i)
})
test('Node selection is exact and compatible with declared manager engines', () => {
  assert.equal(selectNode('>=18 <20', ['18.20.8', '20.19.0'], '24.10.0'), '18.20.8')
  assert.equal(selectNode('>=18', ['18.20.8'], '24.10.0'), '24.10.0')
  assert.equal(selectNode('>=18.0.0-0', ['18.0.0-beta.2', '18.20.8'], '18.0.0-beta.1'), '18.20.8')
  assert.throws(() => selectNode('>=18.0.0-0', ['18.0.0-beta.2'], '18.0.0-beta.1'))
  assert.throws(() => selectNode('<10', ['18.20.8'], '24.10.0'))
})
test('format detection distinguishes Yarn families and numeric npm/pnpm formats', () => {
  assert.deepEqual(detectFormat('npm', '{"lockfileVersion":3}'), { format: 3 })
  assert.deepEqual(detectFormat('npm', '{"lockfileVersion":3}', 'npm-shrinkwrap.json'), {
    format: 3,
    file: 'npm-shrinkwrap.json',
  })
  assert.deepEqual(detectFormat('npm', '{"lockfileVersion":3}', 'package-lock.json'), {
    format: 3,
    file: 'package-lock.json',
  })
  assert.deepEqual(detectFormat('pnpm', "lockfileVersion: '9.0'\n"), { format: '9.0' })
  assert.deepEqual(detectFormat('yarn', '# yarn lockfile v1\n'), { format: 1, classic: true })
  assert.deepEqual(detectFormat('yarn', '__metadata:\n  version: 8\n  cacheKey: 10c0\n'), { format: 8, classic: false })
  assert.throws(() => detectFormat('npm', '{}'), /format/i)
})
test('every family uses its documented frozen install mode', () => {
  assert.ok(frozenArgs('npm', '10.0.0').includes('ci'))
  assert.ok(frozenArgs('pnpm', '9.0.0').includes('--frozen-lockfile'))
  assert.ok(frozenArgs('yarn', '1.22.22').includes('--frozen-lockfile'))
  assert.ok(frozenArgs('yarn', '4.0.0').includes('--immutable'))
})
test('pnpm switches its canonical frozen option at the published alpha.3 CLI rename', () => {
  for (const version of ['1.43.1', '2.25.7', '3.0.0-alpha.0', '3.0.0-alpha.1', '3.0.0-alpha.2'])
    assert.deepEqual(frozenArgs('pnpm', version), ['install', '--frozen-shrinkwrap', '--ignore-scripts'])
  for (const version of ['3.0.0-alpha.3', '3.0.0-beta.0', '3.0.0', '9.0.0'])
    assert.deepEqual(frozenArgs('pnpm', version), ['install', '--frozen-lockfile', '--ignore-scripts'])
})

test(
  'fixture manifest is canonically formatted before generation and hashing',
  { skip: Number(process.versions.node.split('.')[0]) < 20 },
  async () => {
    const { formatManifest } = await import('../maintenance/generate-fixtures.js')
    const formatted = await formatManifest('{"name":"fixture","version":"1.0.0","dependencies":{"is-number":"7.0.0"}}')
    assert.ok(formatted.endsWith('\n'))
    assert.equal(await formatManifest(formatted), formatted)
    assert.deepEqual(JSON.parse(formatted), {
      name: 'fixture',
      version: '1.0.0',
      dependencies: { 'is-number': '7.0.0' },
    })
  },
)

test('historical Node selection respects release date and engines instead of broad modern compatibility', async () => {
  const { selectHistoricalNode } = await import('../maintenance/provision.js')
  const catalog = {
    schemaVersion: 1 as const,
    generatedAt: '',
    sources: [],
    warnings: [],
    managers: { npm: [], pnpm: [], yarn: [] },
    nodes: [
      { version: '10.24.1', date: '2021-04-06' },
      { version: '14.16.1', date: '2021-04-06' },
      { version: '24.10.0', date: '2025-10-08' },
    ],
  }
  assert.equal(selectHistoricalNode({ version: '1.0.0', node: '>=6', releasedAt: '2021-05-01' }, catalog), '14.16.1')
  assert.equal(selectHistoricalNode({ version: '1.0.0', node: '<12', releasedAt: '2021-05-01' }, catalog), '10.24.1')
  assert.throws(
    () => selectHistoricalNode({ version: '1.0.0', node: '>=18', releasedAt: '2021-05-01' }, catalog),
    /historical/,
  )
  assert.ok(frozenArgs('yarn', '0.27.5').includes('--frozen-lockfile'))
})
