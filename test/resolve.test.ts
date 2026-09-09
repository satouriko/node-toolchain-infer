import assert from 'node:assert/strict'
import test from 'node:test'

import { resolve } from '../src/resolve.js'

import type { Catalog, CompatibilityRule, Manager, Runtime, Source } from '../src/types.js'

const catalog: Catalog = {
  schemaVersion: 1,
  generatedAt: '2026-09-09T00:00:00Z',
  sources: [],
  warnings: [],
  nodes: [
    { version: '16.20.2', npm: '8.19.4', lts: 'Gallium' },
    { version: '18.0.0', npm: '8.6.0', lts: false },
    { version: '18.20.8', npm: '10.8.2', lts: 'Hydrogen' },
    { version: '20.19.0', npm: '10.8.2', lts: 'Iron' },
    { version: '22.4.0', npm: '10.8.2', lts: 'Jod' },
    { version: '22.9.0', npm: '10.9.0', lts: 'Jod' },
    { version: '25.0.0-rc.1', npm: '11.0.0', lts: false },
  ],
  managers: {
    npm: [
      { version: '8.6.0', node: '>=16' },
      { version: '8.19.4', node: '>=16' },
      { version: '10.8.2', node: '>=18' },
      { version: '10.9.0', node: '>=18' },
      { version: '11.0.0', node: '>=22' },
    ],
    pnpm: [
      { version: '8.15.9', node: '>=16' },
      { version: '9.1.0', node: '>=18' },
      { version: '10.2.0', node: '>=20' },
    ],
    yarn: [
      { version: '1.22.22', node: '>=4' },
      { version: '3.6.4', node: '>=16' },
      { version: '4.6.0', node: '>=18' },
    ],
  },
}
const runtime: Runtime = { node: '22.4.0', npm: '10.8.2', pnpm: '9.1.0', yarn: '1.22.22' }
const node = (value: string, opts: Partial<Source> = {}): Source => ({
  id: 'node',
  kind: 'engines.node',
  target: 'node',
  value,
  depth: 0,
  rank: 30,
  path: '/project/package.json',
  ...opts,
})
const pm = (value: string, opts: Partial<Source> = {}): Source => ({
  id: 'pm',
  kind: 'packageManager',
  target: 'manager',
  value,
  depth: 0,
  rank: 3,
  path: '/project/package.json',
  ...opts,
})
const lock = (manager: Manager, format: string | undefined, opts: Partial<Source> = {}): Source => ({
  id: 'lock',
  kind: 'lockfile',
  target: 'lock',
  manager,
  value: format,
  format,
  depth: 0,
  rank: 4,
  path: '/project/lock',
  ...opts,
})
const rule = (
  manager: Manager,
  format: string | undefined,
  range: string,
  extra: Partial<CompatibilityRule> = {},
): CompatibilityRule => ({
  id: `${manager}-${format}`,
  manager,
  match: { format },
  range,
  ...extra,
})

test('known upstream bugs keep compatible candidates selectable and expose the exception', () => {
  const marked = rule('pnpm', '9', '>=9', {
    knownBugs: [
      {
        id: 'upstream-1',
        range: '9.1.0',
        reason: 'Known installation bug',
        url: 'https://github.com/pnpm/pnpm/issues/6158',
      },
    ],
  })
  const result = resolve({ sources: [lock('pnpm', '9')], runtime }, catalog, [marked])
  assert.equal(result.packageManager?.version, '9.1.0')
  assert.equal(result.warnings.filter((warning) => warning.code === 'known-package-manager-bug').length, 1)
  const later = resolve({ sources: [lock('pnpm', '9'), pm('pnpm@10.2.0')], runtime }, catalog, [marked])
  assert.equal(later.packageManager?.version, '10.2.0')
  assert.equal(
    later.warnings.some((warning) => warning.code === 'known-package-manager-bug'),
    false,
  )
})
const run = (
  sources: Source[] = [],
  rules: CompatibilityRule[] = [],
  current: Runtime = runtime,
  data: Catalog = catalog,
) => {
  const result = resolve({ sources, runtime: current }, data, rules)
  assert.ok(result.node)
  assert.ok(result.packageManager)
  return { ...result, node: result.node, packageManager: result.packageManager }
}

test('lock rules distinguish package-lock and shrinkwrap even when their format numbers are equal', () => {
  const packageRule = { ...rule('npm', '3', '<11'), match: { format: 3, file: 'package-lock.json' } }
  const shrinkwrapRule = {
    ...rule('npm', '3', '>=11'),
    id: 'shrinkwrap',
    match: { format: 3, file: 'npm-shrinkwrap.json' },
  }
  const rules = [packageRule, shrinkwrapRule]
  assert.equal(run([lock('npm', '3', { kind: 'package-lock.json' })], rules).packageManager.version, '10.8.2')
  assert.equal(run([lock('npm', '3', { kind: 'npm-shrinkwrap.json' })], rules).packageManager.version, '11.0.0')
})

test('no declarations prefer current Node and its bundled npm, not the highest npm', () => {
  const r = run()
  assert.equal(r.node.version, '22.4.0')
  assert.equal(r.packageManager.name, 'npm')
  assert.equal(r.packageManager.version, '10.8.2')
  assert.equal(r.packageManager.reason, 'bundled')
})
test('a Node major range selects the greatest matching published release', () => {
  const r = run([node('18')])
  assert.equal(r.node.version, '18.20.8')
  assert.equal(r.packageManager.version, '10.8.2')
})
test('current Node is preferred inside a range, even when newer matching releases exist', () => {
  assert.equal(run([node('>=20 <23')]).node.version, '22.4.0')
})
test('exact project Node beats the current compatible version', () => {
  assert.equal(run([node('22.9.0')]).node.version, '22.9.0')
})
test('directory distance precedes source priority', () => {
  const r = run([node('18', { id: 'near', rank: 30 }), node('22.9.0', { id: 'far', rank: 1, depth: 1 })])
  assert.equal(r.node.version, '18.20.8')
  assert.equal(r.trace.find((s) => s.id === 'far')?.status, 'ignored')
  assert.ok(r.warnings.some((w) => w.code === 'constraint-conflict'))
})
test('source priority does not change when volta contains a range and nvmrc contains an exact version', () => {
  const r = run([node('18', { id: 'volta', rank: 10 }), node('22.9.0', { id: 'nvmrc', rank: 16 })])
  assert.equal(r.node.version, '18.20.8')
})
test('caller inputs accept arbitrary semver ranges at the highest priority', () => {
  for (const value of ['18', '18.20', '^18', '~18.20', '>=18 <20', '18 || 20']) {
    const r = run([node(value, { kind: 'input.node', rank: 1, depth: -1 }), node('22.9.0', { id: 'project' })])
    assert.equal(r.node.version, value === '18 || 20' ? '20.19.0' : '18.20.8')
    assert.equal(r.trace[0].status, 'accepted')
  }
  assert.equal(run([node('*', { kind: 'input.node' })]).node.version, runtime.node)
  assert.ok(run([node('lts/*', { kind: 'input.node' })]).warnings.some((w) => w.code === 'invalid-declaration'))
})
test('packageManager integrity suffix is not part of the version', () => {
  assert.equal(run([pm('pnpm@9.1.0+sha512.abcdef')]).packageManager.version, '9.1.0')
})
test('a high priority manager pin constrains Node before a lower priority Node declaration is merged', () => {
  const r = run([pm('pnpm@10.2.0'), node('18')])
  assert.equal(r.packageManager.version, '10.2.0')
  assert.equal(r.node.version, '22.4.0')
  assert.equal(r.trace.find((s) => s.id === 'node')?.status, 'ignored')
  assert.deepEqual(r.trace.find((s) => s.id === 'pm')?.derivedNodeRanges, ['>=20'])
})
test('retained manager candidate engines are kept paired with their versions', () => {
  const r = run([node('18', { rank: 1 }), pm('pnpm@>=8')])
  assert.equal(r.node.version, '18.20.8')
  assert.equal(r.packageManager.version, '9.1.0')
})
test('a lower priority manager pin incompatible with a higher Node constraint is warned away', () => {
  const r = run(
    [node('16', { rank: 1 }), pm('pnpm@10.2.0'), lock('yarn', 'classic', { rank: 5 })],
    [rule('yarn', 'classic', '1.22.22')],
  )
  assert.equal(r.node.version, '16.20.2')
  assert.equal(r.packageManager.name, 'yarn')
  assert.ok(r.warnings.some((w) => w.sourceId === 'pm'))
})
test('lockfile candidate range is used and a compatible local manager is preferred', () => {
  const r = run([lock('pnpm', '9.0')], [rule('pnpm', '9.0', '9.1.0 || 10.2.0')])
  assert.equal(r.packageManager.name, 'pnpm')
  assert.equal(r.packageManager.version, '9.1.0')
  assert.equal(r.packageManager.reason, 'local')
})
test('when local manager is outside the lockfile range use maximum satisfying candidate', () => {
  const r = run([lock('pnpm', '9.0')], [rule('pnpm', '9.0', '9.1.0 || 10.2.0')], { ...runtime, pnpm: '8.15.9' })
  assert.equal(r.packageManager.version, '10.2.0')
  assert.ok(r.warnings.some((w) => w.code === 'preferred-version-rejected'))
})
test('unknown lock formats retain only manager identity and emit an explicit warning', () => {
  const r = run([lock('pnpm', '999')])
  assert.equal(r.packageManager.name, 'pnpm')
  assert.ok(r.warnings.some((w) => w.code === 'unknown-lock-compatibility'))
})
test('higher priority packageManager ignores a conflicting lockfile manager', () => {
  const r = run([pm('yarn@4.6.0'), lock('pnpm', '9.0')], [rule('pnpm', '9.0', '9.1.0')])
  assert.equal(r.packageManager.name, 'yarn')
  assert.equal(r.trace.find((s) => s.id === 'lock')?.status, 'ignored')
})
test('conditional engines do not independently select a package manager', () => {
  const r = run([pm('^9', { id: 'pnpm-engine', manager: 'pnpm', conditional: true, rank: 32 })])
  assert.equal(r.packageManager.name, 'npm')
})
test('nearby conditional engine applies to a compatible ancestor manager declaration', () => {
  const r = run([
    pm('<10', { id: 'near-engine', manager: 'pnpm', conditional: true }),
    pm('pnpm@>=8', { id: 'parent-manager', depth: 1 }),
  ])
  assert.equal(r.packageManager.name, 'pnpm')
  assert.equal(r.packageManager.version, '9.1.0')
})
test('Yarn cacheKey matching does not confuse it with lockfile format version', () => {
  const r = run(
    [lock('yarn', '6', { cacheKey: 10 })],
    [rule('yarn', undefined, '4.6.0', { match: { cacheKeyMin: 10, cacheKeyMax: 12 } })],
  )
  assert.equal(r.packageManager.version, '4.6.0')
})
test('an unsupported package manager warns and falls back to npm', () => {
  const r = run([pm('bun@1.2.0')])
  assert.equal(r.packageManager.name, 'npm')
  assert.ok(r.warnings.some((w) => w.code === 'invalid-declaration'))
})
test('same-depth same-rank declarations preserve occurrence order rather than sorting path or id', () => {
  const r = run([node('18', { id: 'z', path: '/z', rank: 8 }), node('22', { id: 'a', path: '/a', rank: 8 })])
  assert.equal(r.node.version, '18.20.8')
})
test('open compatibility ranges admit new releases and unknown formats do not restrict versions', () => {
  const data = structuredClone(catalog)
  data.managers.pnpm.push({ version: '13.0.0', node: '>=18' })
  const noLocal = { ...runtime, pnpm: undefined }
  assert.equal(run([lock('pnpm', '9')], [rule('pnpm', '9.0', '>=9')], noLocal, data).packageManager.version, '13.0.0')
  assert.equal(
    run([lock('pnpm', '10')], [rule('pnpm', '9', '>=9 <13')], noLocal, data).packageManager.version,
    '13.0.0',
  )
  assert.equal(run([lock('pnpm', '9')], [rule('pnpm', '9', '>=9 <13')], noLocal, data).packageManager.version, '10.2.0')
  assert.equal(
    run([lock('pnpm', '9')], [rule('pnpm', '9.0', '>=9 <13')], noLocal, data).packageManager.version,
    '10.2.0',
  )
})
test('missing snapshot records do not erase the known current Node/npm fallback', () => {
  const r = run(
    [],
    [],
    { node: '30.1.2', npm: '20.3.4' },
    { ...catalog, nodes: [], managers: { npm: [], pnpm: [], yarn: [] } },
  )
  assert.equal(r.node.version, '30.1.2')
  assert.equal(r.packageManager.version, '20.3.4')
})
test('stable wildcard selection excludes unpublished or prerelease maxima', () => {
  assert.equal(run([node('>=18 <30')], [], { ...runtime, node: '16.20.2', npm: '8.19.4' }).node.version, '22.9.0')
  assert.equal(run([node('25.0.0-rc.1')]).node.version, '25.0.0-rc.1')
})
test('LTS alias uses official codename metadata', () => {
  assert.equal(run([node('lts/hydrogen', { kind: '.nvmrc' })]).node.version, '18.20.8')
})
test('invalid declarations warn rather than aborting an otherwise usable inference', () => {
  const r = run([node('not-a-version'), pm('pnpm@9.1.0')])
  assert.equal(r.packageManager.version, '9.1.0')
  assert.ok(r.warnings.some((w) => w.code === 'invalid-declaration'))
})
test('rule feature predicates avoid applying a patched fixture to an unpatched lockfile', () => {
  const r = run(
    [lock('pnpm', '9.0', { features: { patches: false } })],
    [
      rule('pnpm', '9.0', '9.1.0'),
      rule('pnpm', '9.0', '10.2.0', { id: 'patches', match: { format: '9.0', features: { patches: true } } }),
    ],
  )
  assert.equal(r.packageManager.version, '9.1.0')
})
