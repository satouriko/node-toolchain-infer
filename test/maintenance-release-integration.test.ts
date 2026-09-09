import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import test from 'node:test'
import { promisify } from 'node:util'

import { observationFingerprint } from '../maintenance/known-bugs.js'
import { digest, type Fixture, FROZEN_LOCKFILES, FROZEN_PROTOCOL, type Observation } from '../maintenance/model.js'
import { monitorFacts, portableReleaseKey } from '../maintenance/seed-monitor.js'
import { runReleaseCheck } from '../scripts/check-releases.js'

import type { Catalog } from '../src/types.js'

for (const version of ['1.0.0', '1.0.0-beta.0'])
  test(`reviewed ${version} bugs resolve preserved conflicts without relabeling raw failures`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'monitor-conflict-case-'))
    const oldFetch = globalThis.fetch
    try {
      const fixture: Fixture = {
        id: 'npm-v3',
        manager: 'npm',
        version,
        directory: 'npm',
        lock: 'package-lock.json',
        match: { format: 3 },
        dependencies: { 'is-number': '7.0.0' },
      }
      for (const d of ['fixtures/npm', 'data', 'maintenance/evidence/logs', 'state', 'tar/package/bin'])
        await mkdir(join(root, d), { recursive: true })
      await writeFile(join(root, 'fixtures/npm/package.json'), '{}')
      await writeFile(join(root, 'fixtures/npm/package-lock.json'), '{"lockfileVersion":3}')
      await writeFile(join(root, 'fixtures/recipes.json'), JSON.stringify([fixture]))
      await writeFile(
        join(root, 'tar/package/package.json'),
        JSON.stringify({ name: 'npm', version, bin: { npm: 'bin/npm.js' } }),
      )
      await writeFile(join(root, 'tar/package/bin/npm.js'), `console.log(${JSON.stringify(version)})`)
      await promisify(execFile)('tar', ['-czf', join(root, 'tool.tgz'), '-C', join(root, 'tar'), 'package'])
      const bytes = await readFile(join(root, 'tool.tgz'))
      const release = {
        version,
        node: '>=18',
        integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
        tarball: 'https://registry.npmjs.org/local-review-only.tgz',
      }
      const catalog: Catalog = {
        schemaVersion: 1,
        generatedAt: '2026-09-09T00:00:00Z',
        sources: [],
        warnings: [],
        nodes: [{ version: process.versions.node }],
        managers: { npm: [release], pnpm: [], yarn: [] },
      }
      await writeFile(join(root, 'catalog.json'), JSON.stringify(catalog))
      const inputs = { 'package-lock.json': digest('{"lockfileVersion":3}'), 'package.json': digest('{}') }
      const hash = digest(JSON.stringify(inputs))
      const watched = { ...Object.fromEntries(FROZEN_LOCKFILES.map((f) => [f, '<missing>'])), ...inputs }
      const sample = { fixture, hash }
      const pass: Observation = {
        id: 'pass',
        key: 'pass',
        protocol: FROZEN_PROTOCOL,
        inputHashes: inputs,
        manager: 'npm',
        version,
        actualVersion: version,
        node: process.versions.node,
        nodeArch: process.arch,
        nodeIntegrity: `sha256-${createHash('sha256')
          .update(await readFile(process.execPath))
          .digest('base64')}`,
        toolIntegrity: release.integrity,
        toolUrl: release.tarball,
        platform: process.platform,
        arch: process.arch,
        fixtureId: fixture.id,
        fixtureHash: hash,
        command: ['ci', '--ignore-scripts', '--no-audit', '--no-fund'],
        status: 'pass',
        exitCode: 0,
        beforeHashes: watched,
        afterHashes: watched,
        installed: fixture.dependencies,
        semantic: true,
        logPath: 'logs/pass.log',
        createdAt: '2026-09-09T00:00:00Z',
      }
      const rejected: Observation = {
        ...pass,
        id: 'rejected',
        key: 'rejected',
        status: 'incompatible',
        exitCode: 1,
        logPath: 'logs/rejected.log',
      }
      const observations = [pass, rejected]
      await writeFile(join(root, 'maintenance/evidence/observations.json'), JSON.stringify(observations))
      for (const o of observations) await writeFile(join(root, 'maintenance/evidence', o.logPath), o.status)
      await writeFile(
        join(root, 'data/compatibility.json'),
        JSON.stringify({
          schemaVersion: 1,
          generatedAt: '2026-09-09T00:00:00Z',
          observations: [],
          rules: [
            {
              id: 'rule',
              manager: 'npm',
              match: { format: 3 },
              range: '>=1.0.0',
            },
          ],
        }),
      )
      const releaseKey = portableReleaseKey('npm', release, [sample])
      await writeFile(
        join(root, 'state/state.json'),
        JSON.stringify({
          schemaVersion: 1,
          completed: [],
          unresolved: { [`${releaseKey}:${fixture.id}:behavior`]: 'Preserved upstream installer failure' },
          generation: { [`${releaseKey}:${fixture.id}`]: { match: fixture.match, directory: 'local-cached-shape' } },
        }),
      )
      globalThis.fetch = () => Promise.resolve(new Response(Uint8Array.from(bytes)))
      const report = await runReleaseCheck({
        root,
        stateDirectory: join(root, 'state'),
        catalogPath: join(root, 'catalog.json'),
        maxReleases: 1,
        seedDirectories: [],
      })
      const saved = JSON.parse(await readFile(join(root, 'state/observations.json'), 'utf8'))
      if (version.includes('-')) {
        assert.equal(monitorFacts(catalog, [sample], saved).conflicts.length, 0)
        assert.equal(report.exitCode, 0)
        assert.deepEqual(report.unresolved, [])
        assert.equal(report.managers.find((item) => item.manager === 'npm')?.releasedStableCount, 0)
        assert.equal(saved.find((item: Observation) => item.id === 'rejected').status, 'incompatible')
        return
      }
      assert.equal(monitorFacts(catalog, [sample], saved).conflicts.length, 1)
      assert.notEqual(report.exitCode, 0)
      assert.ok(report.unresolved.some((message) => message.includes('conflicting initial observations')))
      await writeFile(
        join(root, 'maintenance/known-bugs.json'),
        JSON.stringify({
          schemaVersion: 1,
          bugs: [
            {
              id: 'reviewed-installer-bug',
              manager: 'npm',
              range: version,
              fixtureIds: [fixture.id],
              reason: 'Known installer failure; the reader supports this fixture.',
              url: 'https://github.com/npm/cli/issues/1',
              semanticEvidence: 'Independent reader/generator review confirms semantic compatibility.',
              reviewedAt: '2026-09-09T00:00:00Z',
              observations: [{ id: rejected.id, fingerprint: observationFingerprint(rejected) }],
            },
          ],
        }),
      )
      const reviewed = await runReleaseCheck({
        root,
        stateDirectory: join(root, 'state'),
        catalogPath: join(root, 'catalog.json'),
        maxReleases: 0,
        seedDirectories: [],
      })
      assert.equal(reviewed.exitCode, 0)
      assert.deepEqual(reviewed.unresolved, [])
      const preserved = JSON.parse(await readFile(join(root, 'state/observations.json'), 'utf8'))
      assert.equal(preserved.find((item: Observation) => item.id === 'rejected').status, 'incompatible')
    } finally {
      globalThis.fetch = oldFetch
      await rm(root, { recursive: true, force: true })
    }
  })

test(
  'new release generation selects its runtime and discovers replacement pnpm lock filenames',
  {
    skip:
      Number(process.versions.node.split('.')[0]) < 20
        ? 'Fixture generation uses the ESLint 10 development formatter'
        : false,
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'monitor-generation-case-'))
    const originalFetch = globalThis.fetch
    try {
      const fixture: Fixture = {
        id: 'legacy-pnpm',
        manager: 'pnpm',
        version: '2.25.7',
        node: '11.10.1',
        directory: 'pnpm',
        lock: 'shrinkwrap.yaml',
        match: { format: '3', file: 'shrinkwrap.yaml' },
        dependencies: { 'is-number': '7.0.0' },
      }
      for (const directory of ['fixtures/pnpm', 'state', 'tar/package/bin'])
        await mkdir(join(root, directory), { recursive: true })
      await writeFile(join(root, 'fixtures/pnpm/package.json'), '{}')
      await writeFile(join(root, 'fixtures/pnpm/shrinkwrap.yaml'), 'shrinkwrapVersion: 3\n')
      await writeFile(join(root, 'fixtures/recipes.json'), JSON.stringify([fixture]))
      await writeFile(
        join(root, 'tar/package/package.json'),
        JSON.stringify({ name: 'pnpm', version: '12.4.0', bin: { pnpm: 'bin/pnpm.cjs' } }),
      )
      await writeFile(
        join(root, 'tar/package/bin/pnpm.cjs'),
        String.raw`
const fs = require('node:fs');
if (process.argv.includes('--version')) console.log('12.4.0');
else if (process.argv.includes('--frozen-lockfile')) {
  fs.mkdirSync('node_modules/is-number', {recursive:true});
  fs.writeFileSync('node_modules/is-number/package.json', '{"version":"7.0.0"}');
} else fs.writeFileSync('pnpm-lock.yaml', 'lockfileVersion: 9.0\n');
`,
      )
      await promisify(execFile)('tar', ['-czf', join(root, 'tool.tgz'), '-C', join(root, 'tar'), 'package'])
      const bytes = await readFile(join(root, 'tool.tgz'))
      const release = {
        version: '12.4.0',
        node: '>=18',
        integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
        tarball: 'https://registry.npmjs.org/local-generation-only.tgz',
      }
      const catalog: Catalog = {
        schemaVersion: 1,
        generatedAt: '2026-09-09T00:00:00Z',
        sources: [],
        warnings: [],
        nodes: [{ version: process.versions.node }],
        managers: { npm: [], pnpm: [release], yarn: [] },
      }
      await writeFile(join(root, 'catalog.json'), JSON.stringify(catalog))
      globalThis.fetch = () => Promise.resolve(new Response(Uint8Array.from(bytes)))
      const report = await runReleaseCheck({
        root,
        stateDirectory: join(root, 'state'),
        catalogPath: join(root, 'catalog.json'),
        maxReleases: 1,
        seedDirectories: [],
      })
      assert.deepEqual(report.incomplete, [])
      const saved = JSON.parse(await readFile(join(root, 'state/state.json'), 'utf8')) as {
        generation: Record<string, { directory: string }>
      }
      const generated = Object.values(saved.generation)[0]
      assert.ok(generated)
      const receipt = JSON.parse(await readFile(join(generated.directory, 'receipt.json'), 'utf8'))
      assert.equal(receipt.node, process.versions.node)
      assert.equal(receipt.lock, 'pnpm-lock.yaml')
      assert.equal(receipt.match.format, '9')
      assert.equal(receipt.files['pnpm-lock.yaml'], digest('lockfileVersion: 9.0\n'))
      assert.equal(await readFile(join(root, 'fixtures/pnpm/shrinkwrap.yaml'), 'utf8'), 'shrinkwrapVersion: 3\n')
      const { generateFixture } = await import('../maintenance/generate-fixtures.js')
      await assert.rejects(
        generateFixture({ ...fixture, version: '12.4.0' }, catalog, join(root, 'exact-rebuild')),
        /Requested Node 11.10.1/,
      )
    } finally {
      globalThis.fetch = originalFetch
      await rm(root, { recursive: true, force: true })
    }
  },
)
