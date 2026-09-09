import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'

import { collect } from '../src/collect.js'

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'nti-collect-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return realpath(dir)
}
test('collection reads each directory through Git root, with directory priority before file priority', async (t) => {
  const root = await fixture(t)
  const cwd = join(root, 'packages', 'web')
  await mkdir(join(root, '.git'))
  await mkdir(cwd, { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({ packageManager: 'pnpm@10', volta: { node: '22' } }))
  await writeFile(join(cwd, '.nvmrc'), '# comment\n18.20\n')
  const result = await collect({ cwd, node: '^18' })
  assert.deepEqual(result.directories, [cwd, join(root, 'packages'), root])
  assert.equal(result.root, root)
  assert.deepEqual(
    result.sources.map((s) => [s.kind, s.depth]),
    [
      ['input.node', -1],
      ['.nvmrc', 0],
      ['packageManager', 2],
      ['volta.node', 2],
    ],
  )
  assert.equal(result.sources[1].value, '18.20')
})
test('a git worktree marker is the stopping directory and parents are not collected', async (t) => {
  const outer = await fixture(t)
  const cwd = join(outer, 'worktree')
  await mkdir(cwd)
  await writeFile(join(outer, '.nvmrc'), '16')
  await writeFile(join(cwd, '.git'), 'gitdir: /some/other/git/worktrees/name\n')
  await writeFile(join(cwd, '.node-version'), '20')
  const result = await collect({ cwd })
  assert.deepEqual(result.directories, [cwd])
  assert.equal(result.sources.length, 1)
})
test('all same-directory files and declarations use strict source order', async (t) => {
  const cwd = await fixture(t)
  await mkdir(join(cwd, '.git'))
  const manifest = JSON.stringify({
    packageManager: 'pnpm@9',
    volta: { node: '18' },
    devEngines: {
      runtime: [
        { name: 'deno', version: '2' },
        { name: 'node', version: '20' },
        { name: 'node', version: '22' },
      ],
      packageManager: { name: 'yarn', version: '4' },
    },
    engines: { node: '>=18', npm: '10', pnpm: '9', yarn: '4' },
  })
  await writeFile(join(cwd, 'package.json'), manifest)
  await writeFile(join(cwd, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\npatchedDependencies: {}\n")
  await writeFile(join(cwd, 'yarn.lock'), '__metadata:\n  version: 8\n  cacheKey: 10c0\n')
  for (const filename of ['package-lock.json', 'npm-shrinkwrap.json'])
    await writeFile(join(cwd, filename), '{"lockfileVersion":3}')
  await writeFile(join(cwd, '.tool-versions'), 'python 3.12\nnodejs 20.19.0 18.20.8\n')
  const before = await readdir(cwd)
  const result = await collect({ cwd, packageManager: 'npm@^10' })
  assert.deepEqual(
    result.sources.map((s) => s.rank),
    [2, 3, 4, 6, 7, 8, 9, 12, 13, 13, 14, 15, 16, 16, 16],
  )
  assert.deepEqual(
    result.sources.filter((s) => s.kind === 'devEngines.runtime').map((s) => s.value),
    ['20', '22'],
  )
  assert.equal(result.sources.find((s) => s.kind === '.tool-versions')?.value, '20.19.0 || 18.20.8')
  assert.equal(result.sources.find((s) => s.kind === 'yarn.lock')?.cacheKey, '10c0')
  assert.deepEqual(await readdir(cwd), before)
  assert.equal(await readFile(join(cwd, 'package.json'), 'utf8'), manifest)
})
test('malformed lockfiles preserve manager identity while reporting their unreadable format', async (t) => {
  const cwd = await fixture(t)
  await mkdir(join(cwd, '.git'))
  await writeFile(join(cwd, 'package-lock.json'), '{broken')
  await writeFile(join(cwd, 'package.json'), '{broken')
  const r = await collect({ cwd })
  assert.equal(r.sources[0].manager, 'npm')
  assert.equal(r.sources[0].format, 'unknown')
  assert.equal(r.warnings.filter((w) => w.code === 'file-parse-failed').length, 2)
})
test('legacy pnpm shrinkwrap is collected after pnpm-lock with its real format and workspace feature', async (t) => {
  const cwd = await fixture(t)
  await mkdir(join(cwd, '.git'))
  await writeFile(join(cwd, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
  await writeFile(join(cwd, 'shrinkwrap.yaml'), 'shrinkwrapVersion: 4\nimporters:\n  .:\n    specifiers: {}\n')
  await writeFile(join(cwd, 'yarn.lock'), '# yarn lockfile v1\n')
  const result = await collect({ cwd })
  assert.deepEqual(
    result.sources.map((source) => source.kind),
    ['pnpm-lock.yaml', 'shrinkwrap.yaml', 'yarn.lock'],
  )
  assert.equal(result.sources[1].format, '4')
  assert.equal(result.sources[1].manager, 'pnpm')
  assert.deepEqual(result.sources[1].features, { sharedWorkspace: true })
})
test('without a git root only the starting directory contributes and a warning explains it', async (t) => {
  const root = await fixture(t)
  const cwd = join(root, 'child')
  await mkdir(cwd)
  await writeFile(join(root, '.nvmrc'), '18')
  await writeFile(join(cwd, '.nvmrc'), '20')
  const r = await collect({ cwd })
  assert.deepEqual(r.directories, [cwd])
  assert.equal(r.sources.length, 1)
  assert.ok(r.warnings.some((w) => w.code === 'git-root-not-found'))
})

test('an uninspectable Git marker stops ancestor discovery before an outer repository', async (t) => {
  const outer = await fixture(t)
  const cwd = join(outer, 'nested')
  await mkdir(join(outer, '.git'))
  await mkdir(cwd)
  await symlink('.git', join(cwd, '.git'))
  await writeFile(join(outer, '.nvmrc'), '16')
  await writeFile(join(cwd, '.nvmrc'), '18')
  const result = await collect({ cwd })
  assert.deepEqual(result.directories, [cwd])
  assert.deepEqual(
    result.sources.map((source) => source.value),
    ['18'],
  )
  assert.ok(result.warnings.some((warning) => warning.code === 'git-root-read-failed'))
})

test('collection separates native JSON format 9 from Berry YAML format 9', async (t) => {
  const cwd = await fixture(t)
  await mkdir(join(cwd, '.git'))
  const path = join(cwd, 'yarn.lock')
  await writeFile(path, JSON.stringify({ __metadata: { version: 9 }, workspaces: {}, entries: {} }))
  const native = await collect({ cwd })
  assert.equal(native.sources[0].manager, 'yarn')
  assert.equal(native.sources[0].format, '9')
  assert.deepEqual(native.sources[0].features, { yarnFamily: 'zpm' })
  assert.deepEqual(native.warnings, [])
  await writeFile(path, '__metadata:\n  version: 9\n')
  const berry = await collect({ cwd })
  assert.equal(berry.sources[0].format, '9')
  assert.equal(berry.sources[0].features, undefined)
})

test('native JSON with missing, unknown, or malformed metadata preserves Yarn family identity', async (t) => {
  const cwd = await fixture(t)
  await mkdir(join(cwd, '.git'))
  for (const content of [
    '{"workspaces":{},"entries":{}}',
    '{"__metadata":{"version":999},"workspaces":{},"entries":{}}',
    '{"__metadata":',
  ]) {
    await writeFile(join(cwd, 'yarn.lock'), content)
    const result = await collect({ cwd })
    assert.equal(result.sources[0].manager, 'yarn')
    assert.deepEqual(result.sources[0].features, { yarnFamily: 'zpm' })
    assert.equal(result.sources[0].format, content.includes('999') ? '999' : 'unknown')
    assert.equal(result.warnings.length, content.endsWith(':') ? 1 : 0)
  }
})
