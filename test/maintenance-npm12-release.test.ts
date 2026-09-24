import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import test from 'node:test'
import { promisify } from 'node:util'

import { runReleaseCheck } from '../scripts/check-releases.js'

import type { Fixture, Observation } from '../maintenance/model.js'
import type { Catalog } from '../src/types.js'

test('npm 12 checks the existing shrinkwrap fixture without trying to generate a removed format', async () => {
  const root = await mkdtemp(join(tmpdir(), 'monitor-npm12-shrinkwrap-'))
  const originalFetch = globalThis.fetch
  try {
    const fixture: Fixture = {
      id: 'npm-shrinkwrap-v3',
      manager: 'npm',
      version: '11.20.0',
      directory: 'npm',
      lock: 'npm-shrinkwrap.json',
      match: { format: 3, file: 'npm-shrinkwrap.json' },
      dependencies: { 'is-number': '7.0.0' },
    }
    for (const directory of ['fixtures/npm', 'data', 'state', 'tar/package/bin'])
      await mkdir(join(root, directory), { recursive: true })
    await writeFile(
      join(root, 'fixtures/npm/package.json'),
      '{"name":"fixture","version":"1.0.0","dependencies":{"is-number":"7.0.0"}}',
    )
    await writeFile(
      join(root, 'fixtures/npm/npm-shrinkwrap.json'),
      '{"name":"fixture","version":"1.0.0","lockfileVersion":3}',
    )
    await writeFile(join(root, 'fixtures/recipes.json'), JSON.stringify([fixture]))
    await writeFile(
      join(root, 'data/compatibility.json'),
      JSON.stringify({
        schemaVersion: 1,
        generatedAt: '2026-09-23T00:00:00Z',
        observations: [],
        rules: [{ id: 'npm-shrinkwrap-v3', manager: 'npm', match: fixture.match, range: '>=7 <12' }],
      }),
    )
    await writeFile(
      join(root, 'tar/package/package.json'),
      JSON.stringify({ name: 'npm', version: '12.1.0', bin: { npm: 'bin/npm.js' } }),
    )
    await writeFile(
      join(root, 'tar/package/bin/npm.js'),
      `const command = process.argv[2]
if (command === '--version') console.log('12.1.0')
else if (command === 'install') require('node:fs').writeFileSync('package-lock.json', '{"lockfileVersion":3}')
else if (command === 'shrinkwrap') { console.error('Unknown command: "shrinkwrap"'); process.exitCode = 1 }
else if (command === 'ci') { console.error('npm ci can only install with an existing package-lock.json with lockfileVersion >= 1'); process.exitCode = 1 }
else { console.error('Unexpected command: ' + command); process.exitCode = 1 }
`,
    )
    await promisify(execFile)('tar', ['-czf', join(root, 'tool.tgz'), '-C', join(root, 'tar'), 'package'])
    const bytes = await readFile(join(root, 'tool.tgz'))
    const release = {
      version: '12.1.0',
      node: '>=18',
      integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
      tarball: 'https://registry.npmjs.org/local-npm12-shrinkwrap-test.tgz',
    }
    const catalog: Catalog = {
      schemaVersion: 1,
      generatedAt: '2026-09-23T00:00:00Z',
      sources: [],
      warnings: [],
      nodes: [{ version: process.versions.node }],
      managers: { npm: [release], pnpm: [], yarn: [] },
    }
    await writeFile(join(root, 'catalog.json'), JSON.stringify(catalog))
    globalThis.fetch = () => Promise.resolve(new Response(Uint8Array.from(bytes)))

    const report = await runReleaseCheck({
      root,
      stateDirectory: join(root, 'state'),
      catalogPath: join(root, 'catalog.json'),
      maxReleases: 1,
      incremental: true,
      seedDirectories: [],
    })
    const observations = JSON.parse(await readFile(join(root, 'state/observations.json'), 'utf8')) as Observation[]
    assert.equal(report.exitCode, 0)
    assert.deepEqual(report.incomplete, [])
    assert.equal(report.managers.find((item) => item.manager === 'npm')?.conclusivelyObservedCount, 1)
    assert.equal(observations.length, 1)
    assert.equal(observations[0].status, 'incompatible')
    assert.equal(observations[0].fixtureId, fixture.id)
  } finally {
    globalThis.fetch = originalFetch
    await rm(root, { recursive: true, force: true })
  }
})
