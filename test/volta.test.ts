import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import test, { type TestContext } from 'node:test'

import { collect, detectRuntime, infer } from '../src/index.js'

import type { Manager } from '../src/types.js'

async function fixture(t: TestContext, settings: Record<string, unknown> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nti-volta-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const cwd = join(root, 'project')
  const home = join(root, 'volta')
  const bin = join(home, 'bin')
  const marker = join(root, 'shim-executed')
  await mkdir(join(cwd, '.git'), { recursive: true })
  await mkdir(bin, { recursive: true })
  await mkdir(join(home, 'tools/user'), { recursive: true })
  const manifest = JSON.stringify({ volta: { node: process.versions.node, ...settings } })
  await writeFile(join(cwd, 'package.json'), manifest)
  await writeFile(
    join(home, 'tools/user/platform.json'),
    JSON.stringify({
      node: { runtime: process.versions.node, npm: null },
      pnpm: '8.15.9',
      yarn: '1.22.22',
    }),
  )
  for (const manager of ['npm', 'pnpm', 'yarn']) {
    const shim = join(bin, `${manager}${process.platform === 'win32' ? '.cmd' : ''}`)
    await writeFile(
      shim,
      process.platform === 'win32'
        ? `@echo called>"${marker}"\r\n@exit /b 1\r\n`
        : `#!/bin/sh\nprintf called > '${marker}'\nexit 1\n`,
    )
    await chmod(shim, 0o755)
  }
  const env: Record<string, string | undefined> = {
    ...process.env,
    VOLTA_HOME: home,
    VOLTA_FEATURE_PNPM: '1',
    _VOLTA_TOOL_RECURSION: '1',
    PATH: [bin, dirname(process.execPath)].join(delimiter),
  }
  return { root, cwd, home, bin, env, manifest, marker }
}

async function cached(home: string, manager: Manager, version: string, node = '>=18') {
  const root = join(home, 'tools/image', manager, version)
  await mkdir(join(root, 'bin'), { recursive: true })
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      name: manager,
      version,
      engines: { node },
      bin: { [manager]: 'bin/cli.js' },
    }),
  )
  await writeFile(join(root, 'bin/cli.js'), `console.log(${JSON.stringify(version)});\n`)
  return root
}

test('Volta project caches are probed directly without invoking downloading shims', async (t) => {
  const f = await fixture(t, { pnpm: '9.15.4', yarn: '1.22.21' })
  await cached(f.home, 'pnpm', '9.15.4')
  await cached(f.home, 'pnpm', '8.15.9')
  await cached(f.home, 'yarn', '1.22.21')
  const { runtime } = await detectRuntime({ cwd: f.cwd, env: f.env })
  assert.equal(runtime.pnpm, '9.15.4')
  assert.equal(runtime.yarn, '1.22.21')
  await assert.rejects(readFile(f.marker), { code: 'ENOENT' })
  assert.equal(await readFile(join(f.cwd, 'package.json'), 'utf8'), f.manifest)
  assert.equal(f.env._VOLTA_TOOL_RECURSION, '1')
})

test('an uncached Volta project pin falls back to a cached default without downloading', async (t) => {
  const f = await fixture(t, { pnpm: '9.15.4' })
  await cached(f.home, 'pnpm', '8.15.9')
  const { runtime } = await detectRuntime({ cwd: f.cwd, env: f.env })
  assert.equal(runtime.pnpm, '8.15.9')
  assert.equal(runtime.yarn, undefined)
  await assert.rejects(readFile(f.marker), { code: 'ENOENT' })
})

test('Volta cache metadata alone is not proof of a runnable tool', async (t) => {
  const f = await fixture(t, { pnpm: '9.15.4' })
  const path = await cached(f.home, 'pnpm', '9.15.4')
  await rm(join(path, 'bin/cli.js'))
  await cached(f.home, 'pnpm', '8.15.9', '>=999')
  const { runtime } = await detectRuntime({ cwd: f.cwd, env: f.env })
  assert.equal(runtime.pnpm, undefined)
  await assert.rejects(readFile(f.marker), { code: 'ENOENT' })
})

test('Volta configuration inheritance retains declaring paths and child overrides', async (t) => {
  const f = await fixture(t, { extends: './base.json', yarn: '1.22.21' })
  const base = join(f.cwd, 'base.json')
  await writeFile(base, JSON.stringify({ volta: { node: '18.20.8', npm: '10.8.2', yarn: '1.22.22', pnpm: '9.15.4' } }))
  const result = await collect({ cwd: f.cwd })
  const volta = result.sources.filter((source) => source.kind.startsWith('volta.'))
  assert.equal(volta.find((source) => source.kind === 'volta.node')?.value, process.versions.node)
  assert.equal(volta.find((source) => source.kind === 'volta.pnpm')?.value, 'pnpm@9.15.4')
  assert.equal(volta.find((source) => source.kind === 'volta.pnpm')?.path, base)
  assert.equal(volta.find((source) => source.kind === 'volta.yarn')?.value, 'yarn@1.22.21')
  assert.equal(volta.find((source) => source.kind === 'volta.npm')?.value, '10.8.2')
  assert.equal(volta.find((source) => source.kind === 'volta.npm')?.conditional, true)
})

test('broken or cyclic Volta inheritance warns while preserving local settings', async (t) => {
  const f = await fixture(t, { extends: './package.json', pnpm: '9.15.4' })
  const result = await collect({ cwd: f.cwd })
  assert.ok(result.sources.some((source) => source.kind === 'volta.pnpm'))
  assert.ok(result.warnings.some((warning) => /cycl/i.test(warning.message)))
})

test('Volta custom npm stays distinct from the npm bundled with the running Node', async (t) => {
  const f = await fixture(t, { npm: '9.9.9' })
  await cached(f.home, 'npm', '9.9.9')
  const bound = await detectRuntime({ localManagers: false })
  const detected = await detectRuntime({ cwd: f.cwd, env: f.env })
  assert.equal(detected.runtime.npm, bound.runtime.npm)
  assert.equal(detected.runtime.localNpm, '9.9.9')
  const result = await infer({
    cwd: f.cwd,
    runtime: detected.runtime,
    fetcher: () => Promise.reject(new Error('offline')),
  })
  assert.equal(result.packageManager?.version, '9.9.9')
  assert.equal(result.node?.bundledNpm, bound.runtime.npm)
  await assert.rejects(readFile(f.marker), { code: 'ENOENT' })
})

test('a Volta Node pin without an npm pin uses bundled npm instead of the custom default', async (t) => {
  const f = await fixture(t)
  await cached(f.home, 'npm', '9.9.9')
  await writeFile(
    join(f.home, 'tools/user/platform.json'),
    JSON.stringify({
      node: {
        runtime: process.versions.node,
        npm: '9.9.9',
      },
    }),
  )
  assert.equal((await detectRuntime({ cwd: f.cwd, env: f.env })).runtime.localNpm, undefined)
  await writeFile(join(f.cwd, 'package.json'), '{}')
  assert.equal((await detectRuntime({ cwd: f.cwd, env: f.env })).runtime.localNpm, '9.9.9')
  await writeFile(join(f.cwd, 'package.json'), JSON.stringify({ volta: { node: process.versions.node, npm: '8.0.0' } }))
  assert.equal((await detectRuntime({ cwd: f.cwd, env: f.env })).runtime.localNpm, '9.9.9')
  await assert.rejects(readFile(f.marker), { code: 'ENOENT' })
})

test('a Volta Yarn selector coexists with a custom npm constraint', async (t) => {
  const f = await fixture(t, { npm: '9.9.9', yarn: '1.22.21' })
  const result = await infer({
    cwd: f.cwd,
    runtime: { node: process.versions.node, npm: '10.8.2', yarn: '1.22.21' },
    fetcher: () => Promise.reject(new Error('offline')),
  })
  assert.equal(result.packageManager?.name, 'yarn')
  assert.equal(result.packageManager.version, '1.22.21')
  assert.ok(result.trace.some((source) => source.kind === 'volta.npm' && source.status === 'inactive'))
})

test('relative Volta inheritance follows the real directory of each symlinked configuration', async (t) => {
  const f = await fixture(t, { extends: './linked.json' })
  const configs = join(f.cwd, 'configs')
  await mkdir(configs)
  await writeFile(join(configs, 'base.json'), JSON.stringify({ volta: { extends: './defaults.json' } }))
  const defaults = join(configs, 'defaults.json')
  await writeFile(defaults, JSON.stringify({ volta: { pnpm: '9.15.4' } }))
  await symlink(join(configs, 'base.json'), join(f.cwd, 'linked.json'), 'file')
  const collected = await collect({ cwd: f.cwd })
  assert.deepEqual(collected.warnings, [])
  assert.equal(collected.sources.find((s) => s.kind === 'volta.pnpm')?.path, defaults)
  await cached(f.home, 'pnpm', '9.15.4')
  assert.equal((await detectRuntime({ cwd: f.cwd, env: f.env })).runtime.pnpm, '9.15.4')
})

test('the first extends path stays relative to the project when package.json is a symlink', async (t) => {
  const f = await fixture(t)
  const configs = join(f.cwd, 'configs')
  await mkdir(configs)
  await writeFile(
    join(configs, 'project.json'),
    JSON.stringify({ volta: { node: process.versions.node, extends: './base.json' } }),
  )
  await writeFile(join(configs, 'base.json'), JSON.stringify({ volta: { pnpm: '8.15.9' } }))
  const base = join(f.cwd, 'base.json')
  await writeFile(base, JSON.stringify({ volta: { pnpm: '9.15.4' } }))
  await rm(join(f.cwd, 'package.json'))
  await symlink(join(configs, 'project.json'), join(f.cwd, 'package.json'), 'file')
  const result = await collect({ cwd: f.cwd })
  assert.equal(result.sources.find((s) => s.kind === 'volta.pnpm')?.value, 'pnpm@9.15.4')
  assert.equal(result.sources.find((s) => s.kind === 'volta.pnpm')?.path, base)
})

for (const manager of ['Npm', 'Yarn', 'Pnpm'])
  test(`legacy Volta pnpm installed through ${manager} is verified without native pnpm support`, async (t) => {
    const f = await fixture(t, { pnpm: '9.15.4' })
    f.env.VOLTA_FEATURE_PNPM = undefined
    const native = await cached(f.home, 'pnpm', '8.15.9')
    const source = manager === 'Pnpm' ? '5' : 'lib'
    const prefix = manager === 'Npm' && process.platform === 'win32' ? '' : source
    const root = join(f.home, 'tools/image/packages/pnpm', prefix, 'node_modules/pnpm')
    await mkdir(dirname(root), { recursive: true })
    await rename(native, root)
    await mkdir(join(f.home, 'tools/user/bins'), { recursive: true })
    await writeFile(
      join(f.home, 'tools/user/bins/pnpm.json'),
      JSON.stringify({
        name: 'pnpm',
        package: 'pnpm',
        version: '8.15.9',
        manager,
        platform: { node: process.versions.node },
      }),
    )
    const { runtime } = await detectRuntime({ cwd: f.cwd, env: f.env })
    assert.equal(runtime.pnpm, '8.15.9')
    await assert.rejects(readFile(f.marker), { code: 'ENOENT' })
  })

test('Volta inherited pins override the image PATH inherited from another project', async (t) => {
  const f = await fixture(t, { extends: './base.json' })
  await writeFile(join(f.cwd, 'base.json'), JSON.stringify({ volta: { pnpm: '9.15.4' } }))
  await cached(f.home, 'pnpm', '9.15.4')
  const old = await cached(f.home, 'pnpm', '8.15.9')
  const command = join(old, 'bin', process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm')
  await writeFile(command, await readFile(join(f.bin, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm')))
  await chmod(command, 0o755)
  const alias = join(f.root, 'volta-alias')
  await symlink(f.home, alias, process.platform === 'win32' ? 'junction' : 'dir')
  f.env.VOLTA_HOME = alias
  f.env.PATH = [join(old, 'bin'), f.bin, dirname(process.execPath)].join(delimiter)
  const { runtime } = await detectRuntime({ cwd: f.cwd, env: f.env })
  assert.equal(runtime.pnpm, '9.15.4')
  await assert.rejects(readFile(f.marker), { code: 'ENOENT' })
})

test('VOLTA_BYPASS uses the non-Volta PATH without executing shims', async (t) => {
  const f = await fixture(t, { pnpm: '9.15.4' })
  await cached(f.home, 'pnpm', '9.15.4')
  const external = join(f.root, 'external')
  await mkdir(external)
  const command = join(external, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm')
  await writeFile(command, process.platform === 'win32' ? '@echo 7.0.0\r\n' : '#!/bin/sh\necho 7.0.0\n')
  await chmod(command, 0o755)
  f.env.VOLTA_BYPASS = '1'
  f.env.PATH = [f.bin, external, dirname(process.execPath)].join(delimiter)
  assert.equal((await detectRuntime({ cwd: f.cwd, env: f.env })).runtime.pnpm, '7.0.0')
  await assert.rejects(readFile(f.marker), { code: 'ENOENT' })
})

test('Corepack installed inside a Volta Node image keeps its own project selection', async (t) => {
  const f = await fixture(t)
  await cached(f.home, 'pnpm', '8.15.9')
  const nodeRoot = join(f.home, 'tools/image/node', process.versions.node)
  const corepack = join(nodeRoot, 'lib/node_modules/corepack/dist/pnpm.js')
  const nodeBin = join(nodeRoot, 'bin')
  await mkdir(dirname(corepack), { recursive: true })
  await mkdir(nodeBin)
  await writeFile(
    corepack,
    '#!/bin/sh\nif [ "$COREPACK_ENABLE_NETWORK" = "0" ] && [ "$COREPACK_ENABLE_AUTO_PIN" = "0" ] && [ "$COREPACK_ENABLE_PROJECT_SPEC" = "1" ]; then echo 10.34.5; else exit 1; fi\n',
  )
  await chmod(corepack, 0o755)
  if (process.platform === 'win32') await writeFile(join(nodeBin, 'pnpm.cmd'), '@echo 10.34.5\r\n')
  else await symlink(corepack, join(nodeBin, 'pnpm'), 'file')
  f.env.PATH = [nodeBin, f.bin, dirname(process.execPath)].join(delimiter)
  assert.equal((await detectRuntime({ cwd: f.cwd, env: f.env })).runtime.pnpm, '10.34.5')
  await assert.rejects(readFile(f.marker), { code: 'ENOENT' })
})

test('Volta project discovery skips installed dependency manifests', async (t) => {
  const f = await fixture(t, { pnpm: '9.15.4' })
  await cached(f.home, 'pnpm', '9.15.4')
  await cached(f.home, 'pnpm', '8.15.9')
  const cwd = join(f.cwd, 'node_modules/dependency')
  await mkdir(cwd, { recursive: true })
  await writeFile(join(cwd, 'package.json'), '{}')
  assert.equal((await detectRuntime({ cwd, env: f.env })).runtime.pnpm, '9.15.4')
})

test('Volta default home follows the supplied runtime environment', async (t) => {
  const f = await fixture(t, { pnpm: '9.15.4' })
  await cached(f.home, 'pnpm', '9.15.4')
  const profile = join(f.root, 'user')
  const home = process.platform === 'win32' ? join(profile, 'AppData/Local/Volta') : join(profile, '.volta')
  await mkdir(dirname(home), { recursive: true })
  await rename(f.home, home)
  f.env.VOLTA_HOME = undefined
  f.env.HOME = profile
  f.env.USERPROFILE = profile
  f.env.LOCALAPPDATA = undefined
  f.env.PATH = [join(home, 'bin'), dirname(process.execPath)].join(delimiter)
  assert.equal((await detectRuntime({ cwd: f.cwd, env: f.env })).runtime.pnpm, '9.15.4')
  await assert.rejects(readFile(f.marker), { code: 'ENOENT' })
})

test('an inactive Volta installation does not override a command earlier on PATH', async (t) => {
  const f = await fixture(t, { pnpm: '9.15.4' })
  await cached(f.home, 'pnpm', '9.15.4')
  const external = join(f.root, 'external')
  await mkdir(external)
  const command = join(external, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm')
  await writeFile(command, process.platform === 'win32' ? '@echo 7.0.0\r\n' : '#!/bin/sh\necho 7.0.0\n')
  await chmod(command, 0o755)
  f.env.PATH = [external, f.bin, dirname(process.execPath)].join(delimiter)
  assert.equal((await detectRuntime({ cwd: f.cwd, env: f.env })).runtime.pnpm, '7.0.0')
  await assert.rejects(readFile(f.marker), { code: 'ENOENT' })
})
