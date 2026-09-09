import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { digest, type Fixture, FROZEN_LOCKFILES, SEED_PROTOCOL } from '../maintenance/model.js'
import { frozenArgs } from '../maintenance/runner.js'
import { prepareYarnArtifacts } from '../maintenance/yarn-artifacts.js'
import { runReleaseCheck } from '../scripts/check-releases.js'

import { makeObservation } from './maintenance-fixture.js'

import type { Catalog, ManagerRelease } from '../src/types.js'

const version = '3.0.0'
function bundle(commit = 'a'.repeat(40)): ManagerRelease {
  return {
    version,
    node: '>=12',
    sourceUrl: 'https://registry.npmjs.org/@yarnpkg%2Fcli',
    integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
    bundle: {
      commit,
      tag: `@yarnpkg/cli/${version}`,
      size: 123,
      url: `https://raw.githubusercontent.com/yarnpkg/berry/${commit}/packages/yarnpkg-cli/bin/yarn.js`,
    },
  }
}
const catalog = (release: ManagerRelease): Catalog => ({
  schemaVersion: 1,
  generatedAt: '2026-09-09T00:00:00Z',
  sources: [],
  warnings: [],
  nodes: [],
  managers: { npm: [], pnpm: [], yarn: [release] },
})
const fresh = () => catalog({ version, node: '>=14', releasedAt: '2026-09-08T00:00:00Z', sourceUrl: 'fresh-metadata' })
async function save(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, JSON.stringify(value))
}

test('stable native Yarn descriptors bypass Berry hydration and prereleases remain excluded', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yarn-native-artifact-'))
  const native: ManagerRelease = {
    version: '6.0.0',
    node: '*',
    runtime: 'native',
    sourceUrl: 'https://repo.yarnpkg.com/releases',
  }
  try {
    const input = catalog(native)
    input.managers.yarn.push({ ...native, version: '6.1.0-rc.1' })
    const result = await prepareYarnArtifacts({
      catalog: input,
      stateDirectory: root,
      seedDirectories: [],
      enrich: () => {
        throw new Error('native Yarn must not use Berry hydration')
      },
    })
    assert.deepEqual(result.incomplete, [])
    assert.deepEqual(result.catalog.managers.yarn, [native])
    const invalid = await prepareYarnArtifacts({
      catalog: catalog({ ...native, node: '>=18' }),
      stateDirectory: root,
      seedDirectories: [],
      enrich: () => {
        throw new Error('invalid native descriptors must not use Berry hydration')
      },
    })
    assert.match(invalid.incomplete.join('\n'), /invalid official native release descriptor/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('preserved bundle identity survives fresh metadata and immutable archived catalog remains reusable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yarn-artifact-merge-'))
  try {
    const seed = join(root, 'seed')
    const state = join(root, 'state')
    const original = catalog(bundle())
    await save(join(seed, 'catalog.json'), original)
    const input = {
      catalog: fresh(),
      stateDirectory: state,
      seedDirectories: [seed],
      enrich: () => {
        throw new Error('must not enrich existing artifact')
      },
    }
    const result = await prepareYarnArtifacts(input)
    assert.deepEqual(result.incomplete, [])
    assert.equal(result.catalog.managers.yarn[0].node, '>=14')
    assert.equal(result.catalog.managers.yarn[0].sourceUrl, 'fresh-metadata')
    assert.deepEqual(result.catalog.managers.yarn[0].bundle, bundle().bundle)
    assert.equal(result.catalog.managers.yarn[0].tarball, undefined)
    assert.deepEqual(JSON.parse(await readFile(join(seed, 'catalog.json'), 'utf8')), original)
    await rm(seed, { recursive: true })
    assert.deepEqual(
      (await prepareYarnArtifacts({ ...input, seedDirectories: [] })).catalog.managers.yarn[0],
      result.catalog.managers.yarn[0],
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('conflicting immutable artifacts stay incomplete across runs and cannot be silently chosen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yarn-artifact-conflict-'))
  try {
    const seeds = [join(root, 'first'), join(root, 'second')]
    await save(join(seeds[0], 'catalog.json'), catalog(bundle()))
    await save(join(seeds[1], 'catalog.json'), catalog(bundle('b'.repeat(40))))
    const options = {
      catalog: fresh(),
      stateDirectory: join(root, 'state'),
      seedDirectories: seeds,
      enrich: () => {
        throw new Error('conflict must not trigger enrichment')
      },
    }
    const result = await prepareYarnArtifacts(options)
    assert.ok(result.incomplete.some((message) => message.includes('conflicting')))
    assert.equal(result.catalog.managers.yarn[0].bundle, undefined)
    assert.ok(
      (await prepareYarnArtifacts({ ...options, seedDirectories: [] })).incomplete.some((message) =>
        message.includes('conflicting'),
      ),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('production release check consumes a default Yarn supplement without rerunning valid foreign-host seed facts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yarn-artifact-monitor-'))
  try {
    const fixture: Fixture = {
      id: 'yarn-v6',
      manager: 'yarn',
      version,
      directory: 'yarn',
      lock: 'yarn.lock',
      match: { format: '6' },
      dependencies: { 'is-number': '7.0.0' },
    }
    const seed = join(root, 'maintenance/evidence/yarn-supplement')
    const state = join(root, 'state')
    await save(join(root, 'fixtures/recipes.json'), [fixture])
    await save(join(root, 'fixtures/yarn/package.json'), {})
    await writeFile(join(root, 'fixtures/yarn/yarn.lock'), '__metadata:\n  version: 6\n')
    const inputs = { 'package.json': digest('{}'), 'yarn.lock': digest('__metadata:\n  version: 6\n') }
    const watched = { ...Object.fromEntries(FROZEN_LOCKFILES.map((lock) => [lock, '<missing>'])), ...inputs }
    const observation = makeObservation({
      id: 'yarn-seed',
      manager: 'yarn',
      version,
      actualVersion: version,
      fixtureId: fixture.id,
      fixtureHash: digest(JSON.stringify(inputs)),
      inputHashes: inputs,
      beforeHashes: watched,
      afterHashes: watched,
      command: frozenArgs('yarn', version),
      installed: fixture.dependencies,
      toolIntegrity: bundle().integrity!,
      toolUrl: bundle().bundle!.url,
      node: '16.0.0',
      platform: 'different-host',
      logPath: 'logs/install.log',
    })
    await save(join(seed, 'catalog.json'), catalog(bundle()))
    await save(join(seed, 'rows/one.json'), {
      id: 'row',
      protocol: SEED_PROTOCOL,
      manager: 'yarn',
      version,
      fixtureId: fixture.id,
      fixtureHash: observation.fixtureHash,
      status: 'pass',
      observation,
    })
    await mkdir(join(seed, 'logs'), { recursive: true })
    await writeFile(join(seed, 'logs/install.log'), 'frozen pass')
    await save(join(root, 'fresh.json'), fresh())
    const report = await runReleaseCheck({
      root,
      stateDirectory: state,
      catalogPath: join(root, 'fresh.json'),
      maxReleases: 0,
      enrichYarn: () => {
        throw new Error('seed artifact should prevent enrichment')
      },
    })
    assert.equal(report.exitCode, 0, JSON.stringify(report))
    assert.equal(report.managers.find((manager) => manager.manager === 'yarn')?.conclusivelyObservedCount, 1)
    assert.ok((await readdir(join(state, 'yarn-artifacts/catalogs'))).length)
    await save(join(seed, 'report.json'), { failures: [{ version, error: 'Actual tool version mismatch: 2.0.0' }] })
    const contradicted = await runReleaseCheck({
      root,
      stateDirectory: state,
      catalogPath: join(root, 'fresh.json'),
      maxReleases: 0,
    })
    assert.equal(contradicted.exitCode, 2, 'covered fixture facts cannot erase an unresolved artifact mismatch')
    assert.ok(contradicted.incomplete.some((message) => message.includes('Actual tool version mismatch')))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('production checks enrich metadata-only existing versions and retain version mismatch diagnostics across resumes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yarn-artifact-enrich-monitor-'))
  let calls = 0
  try {
    const state = join(root, 'state')
    await save(join(root, 'fixtures/recipes.json'), [])
    await save(join(root, 'fresh.json'), fresh())
    const enrichYarn: import('../maintenance/yarn-artifacts.js').YarnEnricher = async (options) => {
      calls++
      assert.deepEqual(options.versions, [version])
      assert.equal(options.catalog.managers.yarn[0].bundle, undefined)
      const enriched = catalog({ ...bundle(), node: '>=99', sourceUrl: 'older-artifact-metadata' })
      await save(join(options.output, 'catalog.json'), enriched)
      return {
        originalVersions: 1,
        tagVersions: 1,
        added: 1,
        verified: 0,
        failures: [{ version, error: 'Actual tool version mismatch: 2.0.0' }],
        exitCode: 2,
      }
    }
    const options = {
      root,
      stateDirectory: state,
      catalogPath: join(root, 'fresh.json'),
      maxReleases: 0,
      seedDirectories: [],
      enrichYarn,
    }
    const first = await runReleaseCheck(options)
    assert.equal(first.exitCode, 2)
    assert.ok(first.incomplete.some((message) => message.includes('Actual tool version mismatch')))
    const stored = JSON.parse(await readFile(join(state, 'catalog.json'), 'utf8')) as Catalog
    assert.equal(stored.managers.yarn[0].node, '>=14')
    assert.equal(stored.managers.yarn[0].sourceUrl, 'fresh-metadata')
    assert.ok(stored.managers.yarn[0].bundle)
    const second = await runReleaseCheck(options)
    assert.equal(calls, 1)
    assert.ok(second.incomplete.some((message) => message.includes('Actual tool version mismatch')))
    assert.equal((await readdir(join(state, 'yarn-artifacts/enrichment'))).length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('invalid saved bundle URLs cannot impersonate immutable artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yarn-artifact-invalid-'))
  try {
    const release = bundle()
    release.bundle!.url = release.bundle!.url.replace('a'.repeat(40), 'master')
    await save(join(root, 'seed/catalog.json'), catalog(release))
    const result = await prepareYarnArtifacts({
      catalog: fresh(),
      stateDirectory: join(root, 'state'),
      seedDirectories: [join(root, 'seed')],
      enrich: () => {
        throw new Error('invalid artifact must stay blocked')
      },
    })
    assert.ok(result.incomplete.some((message) => message.includes('invalid immutable')))
    assert.equal(result.catalog.managers.yarn[0].integrity, undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
