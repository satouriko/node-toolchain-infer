import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import test from 'node:test'

import { digest, type Fixture } from '../maintenance/model.js'
import { runFixture } from '../maintenance/runner.js'

import type { Tool } from '../maintenance/provision.js'

test('format tests use the pnpm settings recorded in the lockfile and retain them in the control evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'infer-lock-settings-'))
  try {
    const source = join(root, 'fixtures/basic')
    await mkdir(source, { recursive: true })
    await writeFile(join(source, 'package.json'), '{"dependencies":{"is-number":"7.0.0"}}\n')
    await writeFile(
      join(source, 'pnpm-lock.yaml'),
      'lockfileVersion: 6.0\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n  registry: https://invalid.example\n',
    )
    const cli = join(root, 'tool.cjs')
    await writeFile(
      cli,
      String.raw`
const fs = require('node:fs')
if (process.env.npm_config_auto_install_peers !== 'true' || process.env.npm_config_exclude_links_from_lockfile !== 'false') {
  console.error('ERR_PNPM_LOCKFILE_CONFIG_MISMATCH'); process.exit(1)
}
if (process.env.npm_config_registry !== 'https://registry.npmjs.org') process.exit(2)
if (JSON.parse(fs.readFileSync('package.json')).dependencies['is-number'] !== '7.0.0') {
  console.error('ERR_PNPM_OUTDATED_LOCKFILE'); process.exit(1)
}
fs.mkdirSync('node_modules/is-number', { recursive: true })
fs.writeFileSync('node_modules/is-number/package.json', '{"version":"7.0.0"}')
`,
    )
    const tool: Tool = {
      version: '7.33.0',
      node: process.execPath,
      nodeVersion: process.versions.node,
      nodeArch: process.arch,
      nodeIntegrity: 'test-node',
      cli,
      integrity: 'test-tool',
      url: 'https://example.invalid/tool',
    }
    const fixture: Fixture = {
      id: 'settings',
      manager: 'pnpm',
      version: '8.15.9',
      directory: 'basic',
      lock: 'pnpm-lock.yaml',
      match: { format: '6.0' },
      dependencies: { 'is-number': '7.0.0' },
      controlDependencies: { 'is-number': '6.0.0' },
    }
    const result = await runFixture(fixture, tool, join(root, 'fixtures'), join(root, 'work'), join(root, 'evidence'))
    assert.equal(result.status, 'pass')
    assert.deepEqual(result.environment, {
      npm_config_auto_install_peers: 'true',
      npm_config_exclude_links_from_lockfile: 'false',
    })
    assert.deepEqual(result.frozenControl?.environment, result.environment)
    assert.deepEqual(result.beforeHashes, result.afterHashes)
    assert.match(await readFile(join(root, 'evidence', result.logPath), 'utf8'), /npm_config_auto_install_peers/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a successful install proves frozen compatibility when a contradictory manifest rejects or retains locked dependencies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'infer-frozen-control-'))
  try {
    const source = join(root, 'fixtures/basic')
    await mkdir(source, { recursive: true })
    await writeFile(join(source, 'package.json'), '{"dependencies":{"is-number":"7.0.0"}}\n')
    await writeFile(join(source, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
    for (const behavior of ['enforced', 'retained', 'ignored', 'network']) {
      const cli = join(root, `${behavior}.cjs`)
      await writeFile(
        cli,
        `const fs = require('node:fs'); let version = JSON.parse(fs.readFileSync('package.json')).dependencies['is-number']; if ('${behavior}' === 'retained') version = '7.0.0'; if (version !== '7.0.0' && '${behavior}' !== 'ignored') { console.error('${behavior}' === 'enforced' ? 'ERR_PNPM_OUTDATED_LOCKFILE' : 'ECONNRESET'); process.exit(1) } fs.mkdirSync('node_modules/is-number', { recursive: true }); fs.writeFileSync('node_modules/is-number/package.json', JSON.stringify({version}));`,
      )
      const tool: Tool = {
        version: '9.0.0',
        node: process.execPath,
        nodeVersion: process.versions.node,
        nodeArch: process.arch,
        nodeIntegrity: 'node',
        cli,
        integrity: 'tool',
        url: 'https://example.invalid/tool',
      }
      const fixture: Fixture = {
        id: 'control',
        manager: 'pnpm',
        version: tool.version,
        directory: 'basic',
        lock: 'pnpm-lock.yaml',
        match: { format: '9.0' },
        dependencies: { 'is-number': '7.0.0' },
        controlDependencies: { 'is-number': '6.0.0' },
      }
      const result = await runFixture(
        fixture,
        tool,
        join(root, 'fixtures'),
        join(root, `work-${behavior}`),
        join(root, 'evidence'),
      )
      assert.equal(result.status, ['enforced', 'retained'].includes(behavior) ? 'pass' : 'inconclusive')
      const expectedStatus: Record<string, string> = {
        enforced: 'incompatible',
        retained: 'semantic-mismatch',
        ignored: 'pass',
        network: 'inconclusive',
      }
      assert.ok(result.frozenControl)
      assert.equal(result.frozenControl.status, expectedStatus[behavior])
      assert.ok(result.inputHashes && result.frozenControl.inputHashes)
      assert.equal(result.frozenControl.inputHashes['pnpm-lock.yaml'], result.inputHashes['pnpm-lock.yaml'])
      assert.notEqual(result.frozenControl.inputHashes['package.json'], result.inputHashes['package.json'])
    }
    assert.equal(await readFile(join(source, 'package.json'), 'utf8'), '{"dependencies":{"is-number":"7.0.0"}}\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('frozen evidence detects a newly created alternative root lockfile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'infer-new-lock-'))
  try {
    const source = join(root, 'fixtures/basic')
    await mkdir(source, { recursive: true })
    await writeFile(join(source, 'package.json'), '{"dependencies":{"is-number":"7.0.0"}}\n')
    await writeFile(join(source, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
    const cli = join(root, 'tool.cjs')
    await writeFile(
      cli,
      String.raw`
const fs = require('node:fs')
fs.mkdirSync('node_modules/is-number', { recursive: true })
fs.writeFileSync('node_modules/is-number/package.json', '{"version":"7.0.0"}')
fs.writeFileSync('shrinkwrap.yaml', 'shrinkwrapVersion: 3\n')
`,
    )
    const tool: Tool = {
      version: '2.25.7',
      node: process.execPath,
      nodeVersion: process.versions.node,
      nodeArch: process.arch,
      nodeIntegrity: 'test-node',
      cli,
      integrity: 'test-tool',
      url: 'https://example.invalid/test',
    }
    const fixture: Fixture = {
      id: 'test',
      manager: 'pnpm',
      version: tool.version,
      directory: 'basic',
      lock: 'pnpm-lock.yaml',
      match: { format: '9.0' },
      dependencies: { 'is-number': '7.0.0' },
    }
    const result = await runFixture(fixture, tool, join(root, 'fixtures'), join(root, 'work'), join(root, 'evidence'))
    assert.equal(result.status, 'rewrite')
    assert.equal(result.semantic, true)
    assert.equal(result.beforeHashes['shrinkwrap.yaml'], '<missing>')
    assert.equal(result.afterHashes['shrinkwrap.yaml'], digest('shrinkwrapVersion: 3\n'))
    assert.equal(result.beforeHashes['pnpm-lock.yaml'], result.afterHashes['pnpm-lock.yaml'])
    assert.equal(await readFile(join(source, 'pnpm-lock.yaml'), 'utf8'), 'lockfileVersion: 9.0\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('npm failure evidence preserves its debug stack so lock-parser errors can be distinguished from runtime crashes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'infer-npm-debug-'))
  try {
    const source = join(root, 'fixtures/basic')
    await mkdir(source, { recursive: true })
    await writeFile(join(source, 'package.json'), '{"dependencies":{"is-number":"7.0.0"}}\n')
    await writeFile(join(source, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}\n')
    const cli = join(root, 'tool.cjs')
    await writeFile(
      cli,
      String.raw`
const fs = require('node:fs')
fs.mkdirSync('.npm-cache/_logs', { recursive: true })
fs.writeFileSync('.npm-cache/_logs/debug.log', "verbose stack TypeError: Cannot read property 'is-number' of undefined\nverbose stack at /tool/node_modules/lock-verify/index.js:27:40\n")
console.error("npm ERR! Cannot read property 'is-number' of undefined")
process.exitCode = 1
`,
    )
    const tool: Tool = {
      version: '5.10.0-next.1',
      node: process.execPath,
      nodeVersion: process.versions.node,
      nodeArch: process.arch,
      nodeIntegrity: 'test-node',
      cli,
      integrity: 'test-tool',
      url: 'https://example.invalid/test',
    }
    const fixture: Fixture = {
      id: 'test',
      manager: 'npm',
      version: tool.version,
      directory: 'basic',
      lock: 'package-lock.json',
      match: { format: 3 },
      dependencies: { 'is-number': '7.0.0' },
    }
    const result = await runFixture(fixture, tool, join(root, 'fixtures'), join(root, 'work'), join(root, 'evidence'))
    const log = await readFile(join(root, 'evidence', result.logPath), 'utf8')
    assert.match(log, /lock-verify\/index.js:27:40/)
    assert.equal(result.status, 'incompatible')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Yarn PnP installations verify actual resolved package manifests without requiring node_modules', async () => {
  const root = await mkdtemp(join(tmpdir(), 'infer-pnp-'))
  try {
    const source = join(root, 'fixtures/basic')
    await mkdir(source, { recursive: true })
    await writeFile(join(source, 'package.json'), '{"dependencies":{"is-number":"7.0.0"}}\n')
    await writeFile(join(source, 'yarn.lock'), '__metadata:\n  version: 4\n')
    const cli = join(root, 'tool.cjs')
    await writeFile(
      cli,
      String.raw`
const fs = require('node:fs')
fs.writeFileSync('installed-package.json', '{"version":"7.0.0"}')
fs.writeFileSync('.pnp.cjs', "const Module = require('module'); const resolve = Module._resolveFilename; Module._resolveFilename = function(id, ...rest) { return id === 'is-number/package.json' ? require('path').join(__dirname, 'installed-package.json') : resolve.call(this, id, ...rest) }")
`,
    )
    const tool: Tool = {
      version: '2.4.3',
      node: process.execPath,
      nodeVersion: process.versions.node,
      nodeArch: process.arch,
      nodeIntegrity: 'test-node',
      cli,
      integrity: 'test-tool',
      url: 'https://example.invalid/test',
    }
    const fixture: Fixture = {
      id: 'pnp',
      manager: 'yarn',
      version: tool.version,
      directory: 'basic',
      lock: 'yarn.lock',
      match: { format: 4 },
      dependencies: { 'is-number': '7.0.0' },
    }
    const result = await runFixture(fixture, tool, join(root, 'fixtures'), join(root, 'work'), join(root, 'evidence'))
    assert.equal(result.status, 'pass')
    assert.equal(result.installed['is-number'], '7.0.0')
    assert.equal(result.semanticMethod, 'pnp')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
