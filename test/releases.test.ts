import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { checkReleases, checkReleasesFromPaths, writeReport } from '../scripts/check-releases.js'

import { makeObservation } from './maintenance-fixture.js'

import type { Fixture } from '../maintenance/model.js'
import type { Catalog } from '../src/types.js'

const catalog: Catalog = {
  schemaVersion: 1,
  generatedAt: '2026-09-09',
  sources: [],
  nodes: [],
  managers: {
    npm: [
      { version: '10.1.0', node: null },
      { version: '9.9.9', node: null },
      { version: '11.0.0-beta.1', node: null },
    ],
    pnpm: [],
    yarn: [],
  },
  warnings: [],
}
const fixture: Fixture = {
  id: 'npm-v3',
  manager: 'npm',
  version: '10.1.0',
  directory: 'npm/v3',
  lock: 'package-lock.json',
  match: { format: 3 },
  dependencies: {},
}
test('new releases include old patches; a pass on one fixture does not cover another', () => {
  const result = checkReleases({
    catalog,
    observations: [makeObservation({ manager: 'npm', version: '10.1.0', fixtureId: 'npm-v3', status: 'pass' })],
    fixtures: [fixture, { ...fixture, id: 'shrinkwrap' }],
  })
  assert.deepEqual(result.managers[0]?.uncoveredVersions, ['9.9.9', '10.1.0'])
})
test('path runner accepts compatibility observations and writes JSON/Markdown before failure', async () => {
  const path = await mkdtemp(join(tmpdir(), 'release-check-test-'))
  try {
    await writeFile(join(path, 'catalog.json'), JSON.stringify(catalog))
    await writeFile(join(path, 'compatibility.json'), JSON.stringify({ observations: [] }))
    const result = await checkReleasesFromPaths({
      catalogPath: join(path, 'catalog.json'),
      observationsPath: join(path, 'compatibility.json'),
      fixtures: [fixture],
    })
    await writeReport(path, {
      ...result,
      unknownFormats: ['npm:99'],
      mismatches: [],
      unresolved: ['prior issue'],
      incomplete: ['network'],
      exitCode: 2,
    })
    assert.match(await readFile(join(path, 'report.md'), 'utf8'), /prior issue/)
    assert.equal(JSON.parse(await readFile(join(path, 'report.json'), 'utf8')).exitCode, 2)
  } finally {
    await rm(path, { recursive: true, force: true })
  }
})

test('release orchestration preserves unresolved history and emits both reports on incomplete metadata', async () => {
  const { runReleaseCheck } = await import('../scripts/check-releases.js')
  const root = await mkdtemp(join(tmpdir(), 'release-state-test-'))
  try {
    const state = {
      schemaVersion: 1,
      completed: ['old-combination'],
      unresolved: { 'old:format': 'Previously unknown format' },
      generation: {},
    }
    await writeFile(join(root, 'state.json'), JSON.stringify(state))
    const report = await runReleaseCheck({ root, stateDirectory: root, catalogPath: join(root, 'absent-catalog.json') })
    assert.equal(report.exitCode, 2)
    assert.deepEqual(report.unresolved, ['Previously unknown format'])
    assert.equal(JSON.parse(await readFile(join(root, 'report.json'), 'utf8')).exitCode, 2)
    assert.match(await readFile(join(root, 'report.md'), 'utf8'), /Previously unknown format/)
    assert.deepEqual(JSON.parse(await readFile(join(root, 'state.json'), 'utf8')).completed, ['old-combination'])
    await writeFile(
      join(root, 'catalog.json'),
      JSON.stringify({ ...catalog, managers: { npm: [], pnpm: [], yarn: [] } }),
    )
    const pending = await runReleaseCheck({ root, stateDirectory: root, catalogPath: join(root, 'catalog.json') })
    assert.equal(pending.exitCode, 1)
    assert.deepEqual(pending.unresolved, ['Previously unknown format'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
