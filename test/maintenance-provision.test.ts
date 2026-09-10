import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import process from 'node:process'
import test from 'node:test'
import { promisify } from 'node:util'

import { bootstrapTool } from '../maintenance/bootstrap.js'
import { digest } from '../maintenance/model.js'
import { provision } from '../maintenance/provision.js'
import { execute } from '../maintenance/runner.js'

import type { Catalog } from '../src/types.js'

const exec = promisify(execFile)
async function fixtureTarball(root: string, script: string): Promise<Buffer> {
  await mkdir(join(root, 'package/bin'), { recursive: true })
  await writeFile(
    join(root, 'package/package.json'),
    JSON.stringify({ name: 'npm', version: '1.0.0', bin: { npm: 'bin/npm.js' } }),
  )
  await writeFile(join(root, 'package/bin/npm.js'), script)
  await exec('tar', ['-czf', join(root, 'tool.tgz'), '-C', root, 'package'])
  return readFile(join(root, 'tool.tgz'))
}
const catalog: Catalog = {
  schemaVersion: 1,
  generatedAt: '',
  nodes: [{ version: process.versions.node }],
  managers: { npm: [], pnpm: [], yarn: [] },
  sources: [],
  warnings: [],
}

test('version discovery runs outside the maintenance project and its package-manager declaration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'provision-cwd-test-'))
  const originalFetch = globalThis.fetch
  try {
    const bytes = await fixtureTarball(
      root,
      `if (process.cwd() === ${JSON.stringify(process.cwd())}) throw new Error('Read host project'); console.log('1.0.0')`,
    )
    globalThis.fetch = () => Promise.resolve(new Response(Uint8Array.from(bytes)))
    const tool = await provision(
      'npm',
      {
        version: '1.0.0',
        node: '>=18',
        tarball: 'https://registry.npmjs.org/fixture-cwd.tgz',
        integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
      },
      catalog,
      join(root, 'tool'),
    )
    assert.equal(tool.version, '1.0.0')
    assert.equal(tool.nodeBinarySha256, digest(await readFile(tool.node)))
  } finally {
    globalThis.fetch = originalFetch
    await rm(root, { recursive: true, force: true })
  }
})

test('immutable Yarn bundles verify size, checksum and actual version without treating CLI metadata as executable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'provision-bundle-test-'))
  const originalFetch = globalThis.fetch
  try {
    const bytes = Buffer.from('console.log("3.0.0")')
    const commit = 'a'.repeat(40)
    const release = {
      version: '3.0.0',
      node: '>=18',
      integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
      bundle: {
        commit,
        tag: '@yarnpkg/cli/3.0.0',
        size: bytes.length,
        url: `https://raw.githubusercontent.com/yarnpkg/berry/${commit}/packages/yarnpkg-cli/bin/yarn.js`,
      },
    }
    globalThis.fetch = () => Promise.resolve(new Response(Uint8Array.from(bytes)))
    const tool = await provision('yarn', release, catalog, join(root, 'valid'))
    assert.equal(tool.version, release.version)
    assert.equal(tool.url, release.bundle.url)
    assert.equal(await readFile(tool.cli, 'utf8'), bytes.toString())
    assert.equal(tool.nodeBinarySha256, digest(await readFile(tool.node)))
    await assert.rejects(
      provision(
        'yarn',
        { ...release, bundle: { ...release.bundle, size: bytes.length + 1 } },
        catalog,
        join(root, 'size'),
      ),
      /size/,
    )
    await assert.rejects(
      provision('yarn', { ...release, integrity: 'sha512-invalid' }, catalog, join(root, 'integrity')),
      /integrity/,
    )
    await assert.rejects(
      provision(
        'yarn',
        { ...release, bundle: { ...release.bundle, url: release.bundle.url.replace(commit, 'master') } },
        catalog,
        join(root, 'mutable'),
      ),
      /immutable/,
    )
    await assert.rejects(
      provision('yarn', { ...release, version: '3.0.1' }, catalog, join(root, 'version')),
      /version mismatch/,
    )
  } finally {
    globalThis.fetch = originalFetch
    await rm(root, { recursive: true, force: true })
  }
})

test('official packages retain normal node_modules self-resolution without rewriting their bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'provision-self-test-'))
  const originalFetch = globalThis.fetch
  try {
    const script = 'console.log(require(require.resolve("npm/package.json", { paths: [__dirname] })).version)'
    const bytes = await fixtureTarball(root, script)
    globalThis.fetch = () => Promise.resolve(new Response(Uint8Array.from(bytes)))
    const tool = await provision(
      'npm',
      {
        version: '1.0.0',
        node: '>=18',
        tarball: 'https://registry.npmjs.org/fixture-self.tgz',
        integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
      },
      catalog,
      join(root, 'tool'),
    )
    assert.equal(await readFile(tool.cli, 'utf8'), script)
    assert.equal(tool.version, '1.0.0')
    assert.ok(tool.cli.includes('/node_modules/npm/'))
  } finally {
    globalThis.fetch = originalFetch
    await rm(root, { recursive: true, force: true })
  }
})

test('native pnpm wrappers use their exact verified platform package and execute without Node interpreting the binary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'provision-native-test-'))
  const originalFetch = globalThis.fetch
  try {
    const name = `@pnpm/exe.${process.platform}-${process.arch}`
    await mkdir(join(root, 'wrapper/package'), { recursive: true })
    await writeFile(
      join(root, 'wrapper/package/package.json'),
      JSON.stringify({
        name: 'pnpm',
        version: '12.0.0',
        bin: { pnpm: 'pnpm' },
        optionalDependencies: { [name]: '12.0.0' },
      }),
    )
    await writeFile(join(root, 'wrapper/package/pnpm'), 'This is a native placeholder')
    await exec('tar', ['-czf', join(root, 'wrapper.tgz'), '-C', join(root, 'wrapper'), 'package'])
    await mkdir(join(root, 'native/package'), { recursive: true })
    await writeFile(join(root, 'native/package/package.json'), JSON.stringify({ name, version: '12.0.0' }))
    await writeFile(join(root, 'native/package/pnpm'), '#!/bin/sh\nprintf "pnpm 12.0.0\\n"\n')
    await chmod(join(root, 'native/package/pnpm'), 0o755)
    await exec('tar', ['-czf', join(root, 'native.tgz'), '-C', join(root, 'native'), 'package'])
    const wrapper = await readFile(join(root, 'wrapper.tgz'))
    const native = await readFile(join(root, 'native.tgz'))
    const integrity = `sha512-${createHash('sha512').update(native).digest('base64')}`
    globalThis.fetch = (input) => {
      let url: string
      if (typeof input === 'string') url = input
      else if (input instanceof URL) url = input.href
      else url = input.url
      if (url.endsWith('wrapper.tgz')) return Promise.resolve(new Response(Uint8Array.from(wrapper)))
      if (url.endsWith('native.tgz')) return Promise.resolve(new Response(Uint8Array.from(native)))
      return Promise.resolve(
        Response.json({
          name,
          version: '12.0.0',
          dist: { integrity, tarball: 'https://registry.npmjs.org/native.tgz' },
        }),
      )
    }
    const tool = await provision(
      'pnpm',
      {
        version: '12.0.0',
        node: '>=18',
        tarball: 'https://registry.npmjs.org/wrapper.tgz',
        integrity: `sha512-${createHash('sha512').update(wrapper).digest('base64')}`,
      },
      catalog,
      join(root, 'tool'),
    )
    assert.equal(tool.execution, 'native')
    assert.equal(tool.native?.integrity, integrity)
    assert.equal((await execute(tool, ['--version'], root)).output.trim(), 'pnpm 12.0.0')
  } finally {
    globalThis.fetch = originalFetch
    await rm(root, { recursive: true, force: true })
  }
})
test('verified artifact cache reuses downloads and repairs corrupted cached bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'provision-cache-test-'))
  const originalFetch = globalThis.fetch
  try {
    const bytes = await fixtureTarball(root, 'console.log("1.0.0")')
    const release = {
      version: '1.0.0',
      node: '>=18',
      tarball: 'https://registry.npmjs.org/fixture-cache-test.tgz',
      integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    }
    let requests = 0
    globalThis.fetch = () => {
      requests++
      return Promise.resolve(new Response(Uint8Array.from(bytes)))
    }
    const options = { cacheDirectory: join(root, 'cache'), timeoutMs: 2000 }
    await provision('npm', release, catalog, join(root, 'first'), undefined, options)
    await provision('npm', release, catalog, join(root, 'second'), undefined, options)
    assert.equal(requests, 1)
    await writeFile(join(root, 'cache/downloads', digest(release.tarball)), 'corrupted')
    await provision('npm', release, catalog, join(root, 'third'), undefined, options)
    assert.equal(requests, 2)
  } finally {
    globalThis.fetch = originalFetch
    await rm(root, { recursive: true, force: true })
  }
})
test('manager version discovery is bounded when an old executable hangs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'provision-timeout-test-'))
  const originalFetch = globalThis.fetch
  try {
    const bytes = await fixtureTarball(root, 'setInterval(() => {}, 1000)')
    const release = {
      version: '1.0.0',
      node: '>=18',
      tarball: 'https://registry.npmjs.org/fixture-timeout-test.tgz',
      integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    }
    globalThis.fetch = () => Promise.resolve(new Response(Uint8Array.from(bytes)))
    const started = Date.now()
    await assert.rejects(
      provision('npm', release, catalog, join(root, 'tool'), undefined, { timeoutMs: 150 }),
      (error) => Boolean(error && typeof error === 'object' && 'killed' in error && error.killed),
    )
    assert.ok(Date.now() - started < 3000)
  } finally {
    globalThis.fetch = originalFetch
    await rm(root, { recursive: true, force: true })
  }
})

test('bootstrap handles old Node reporting a missing module on stderr with exit zero and preserves its receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'provision-bootstrap-test-'))
  const originalFetch = globalThis.fetch
  try {
    await fixtureTarball(
      root,
      'try { console.log(require("bootstrap-local").version) } catch (error) { console.error(error) }',
    )
    await mkdir(join(root, 'package/vendor'), { recursive: true })
    await writeFile(
      join(root, 'package/vendor/package.json'),
      JSON.stringify({ name: 'bootstrap-local', version: '1.0.0', main: 'index.js' }),
    )
    await writeFile(join(root, 'package/vendor/index.js'), 'exports.version = "1.0.0"')
    await writeFile(
      join(root, 'package/package.json'),
      JSON.stringify({
        name: 'npm',
        version: '1.0.0',
        bin: { npm: 'bin/npm.js' },
        dependencies: { 'bootstrap-local': 'file:vendor' },
      }),
    )
    await exec('tar', ['-czf', join(root, 'tool.tgz'), '-C', root, 'package'])
    const bytes = await readFile(join(root, 'tool.tgz'))
    const release = {
      version: '1.0.0',
      node: '>=18',
      tarball: 'https://registry.npmjs.org/fixture-bootstrap-test.tgz',
      integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    }
    globalThis.fetch = () => Promise.resolve(new Response(Uint8Array.from(bytes)))
    const options = { cacheDirectory: join(root, 'cache'), timeoutMs: 10_000 }
    await assert.rejects(
      provision('npm', release, catalog, join(root, 'first'), undefined, options),
      /Cannot find module/,
    )
    const prepared = await provision('npm', release, catalog, join(root, 'second'), undefined, {
      ...options,
      bootstrapDependencies: true,
    })
    assert.ok(prepared.bootstrap)
    const originalLog = await readFile(prepared.bootstrap.logPath, 'utf8')
    assert.equal(digest(await readFile(prepared.bootstrap.lockfilePath)), prepared.bootstrap.lockfileSha256)
    assert.ok(prepared.bootstrap.command.includes('--ignore-scripts'))
    const reused = await provision('npm', release, catalog, join(root, 'third'), undefined, {
      ...options,
      bootstrapDependencies: true,
    })
    assert.equal(reused.bootstrap?.lockfileSha256, prepared.bootstrap.lockfileSha256)
    const cacheKey = basename(dirname(dirname(prepared.bootstrap.lockfilePath)))
    const dependency = join(root, 'cache/prepared', cacheKey, 'tool/vendor/index.js')
    await writeFile(dependency, 'exports.version = "1.0.0"; exports.unverified = true')
    const repaired = await provision('npm', release, catalog, join(root, 'fourth'), undefined, {
      ...options,
      bootstrapDependencies: true,
    })
    assert.equal(
      await readFile(join(dirname(dirname(repaired.cli)), 'vendor/index.js'), 'utf8'),
      'exports.version = "1.0.0"',
    )
    assert.equal(repaired.bootstrap?.lockfileSha256, prepared.bootstrap.lockfileSha256)
    assert.equal(await readFile(prepared.bootstrap.logPath, 'utf8'), originalLog)
    assert.notEqual(repaired.bootstrap.logPath, prepared.bootstrap.logPath)
    assert.ok(repaired.bootstrap.command.includes('ci'))
  } finally {
    globalThis.fetch = originalFetch
    await rm(root, { recursive: true, force: true })
  }
})

test('production tool bootstrap ignores conflicting development peers without changing the tool manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bootstrap-development-peers-'))
  const previousOffline = process.env.npm_config_offline
  process.env.npm_config_offline = 'true'
  try {
    const source = join(root, 'source')
    for (const [name, manifest] of [
      ['runtime', { name: 'fixture-runtime', version: '1.0.0' }],
      ['lint', { name: 'fixture-lint', version: '1.0.0', peerDependencies: { 'fixture-runtime': '^2.0.0' } }],
    ] as const) {
      await mkdir(join(source, name), { recursive: true })
      await writeFile(join(source, name, 'package.json'), JSON.stringify(manifest))
      await exec('tar', ['-czf', join(source, `${name}.tgz`), '-C', source, name])
    }
    const manifest = JSON.stringify({
      name: 'fixture-tool',
      version: '1.0.0',
      dependencies: { 'fixture-runtime': 'file:runtime.tgz' },
      devDependencies: {
        'fixture-lint': 'file:lint.tgz',
        'fixture-unpublished-development-only': '0.0.0-does-not-exist',
      },
      scripts: { postinstall: "node -e \"require('fs').writeFileSync('ran-script', 'bad')\"" },
    })
    await writeFile(join(source, 'package.json'), manifest)
    const prepared = await bootstrapTool(source, digest(manifest), join(root, 'cache'), 10_000)
    assert.equal(await readFile(join(prepared.directory, 'package.json'), 'utf8'), manifest)
    assert.equal(
      JSON.parse(await readFile(join(prepared.directory, 'node_modules/fixture-runtime/package.json'), 'utf8')).version,
      '1.0.0',
    )
    await assert.rejects(readFile(join(prepared.directory, 'node_modules/fixture-lint/package.json')), /ENOENT/)
    await assert.rejects(readFile(join(prepared.directory, 'ran-script')), /ENOENT/)
    assert.equal(digest(await readFile(prepared.receipt.lockfilePath)), prepared.receipt.lockfileSha256)
    assert.ok(!prepared.receipt.command.includes('--legacy-peer-deps'))
    const { manifestPreparation } = prepared.receipt
    assert.ok(manifestPreparation)
    assert.equal(manifestPreparation.original.content, manifest)
    assert.equal(manifestPreparation.original.sha256, digest(manifest))
    const { installation } = manifestPreparation
    assert.equal(installation.sha256, digest(installation.content))
    assert.equal(JSON.parse(installation.content).devDependencies, undefined)
    assert.deepEqual(JSON.parse(installation.content).dependencies, { 'fixture-runtime': 'file:runtime.tgz' })
  } finally {
    if (previousOffline === undefined) delete process.env.npm_config_offline
    else process.env.npm_config_offline = previousOffline
    await rm(root, { recursive: true, force: true })
  }
})
