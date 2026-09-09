import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { frozenArgs } from '../maintenance/runner.js'
import { needsHistoricalRuntime, readSeedRows, seedData, type SeedRow } from '../scripts/seed-data.js'

import { makeObservation } from './maintenance-fixture.js'

import type { Fixture } from '../maintenance/model.js'
import type { Tool } from '../maintenance/provision.js'
import type { Catalog } from '../src/types.js'

test('historical Node retries require a runtime failure, not a network or lock error', () => {
  assert.equal(needsHistoricalRuntime('SyntaxError: Unexpected token ?'), true)
  assert.equal(needsHistoricalRuntime('ReferenceError: primordials is not defined'), true)
  assert.equal(needsHistoricalRuntime('ERR_INVALID_THIS: Value of this must be of type URLSearchParams'), true)
  assert.equal(needsHistoricalRuntime('Error: Cannot find module node:fs'), true)
  assert.equal(needsHistoricalRuntime("npm ERR! Cannot read properties of undefined (reading 'is-number')"), true)
  assert.equal(needsHistoricalRuntime("npm ERR! Cannot read property 'is-number' of undefined"), true)
  assert.equal(needsHistoricalRuntime('Actual tool version mismatch: '), true)
  assert.equal(
    needsHistoricalRuntime('/usr/bin/node /tmp/pnpm/bin/pnpm.js install --frozen-lockfile --ignore-scripts\n\n'),
    true,
  )
  assert.equal(needsHistoricalRuntime('ENOTFOUND registry.npmjs.org'), false)
  assert.equal(needsHistoricalRuntime('ERR_PNPM_NO_LOCKFILE'), false)
  assert.equal(needsHistoricalRuntime('ETIMEDOUT: maintenance command exceeded 180 seconds'), false)
})

test('resume orders attempts monotonically when timestamps tie or the clock moves backwards', async () => {
  const output = await mkdtemp(join(tmpdir(), 'infer-seed-order-'))
  try {
    await mkdir(join(output, 'rows'))
    const row: SeedRow = {
      id: 'z-old',
      key: 'same-combination',
      protocol: 'test',
      manager: 'npm',
      version: '1.0.0',
      fixtureId: 'one',
      fixtureHash: 'test',
      catalogHash: 'test',
      createdAt: '2026-09-09T00:00:00.000Z',
      attempt: 1,
      status: 'inconclusive',
    }
    await writeFile(join(output, 'rows/old.json'), JSON.stringify(row))
    await writeFile(join(output, 'rows/new.json'), JSON.stringify({ ...row, id: 'a-new', attempt: 2, status: 'pass' }))
    assert.equal((await readSeedRows(output)).at(-1)?.status, 'pass')
    await writeFile(
      join(output, 'rows/later.json'),
      JSON.stringify({
        ...row,
        id: 'later',
        attempt: 3,
        createdAt: '2026-09-08T00:00:00.000Z',
        status: 'incompatible',
      }),
    )
    assert.equal((await readSeedRows(output)).at(-1)?.id, 'later')
  } finally {
    await rm(output, { recursive: true, force: true })
  }
})

test('initial matrix attempts every exact release and fixture, resumes, and preserves failed provisioning', async () => {
  const root = await mkdtemp(join(tmpdir(), 'infer-seed-test-'))
  const fixtures: Fixture[] = ['one', 'two'].map((id) => ({
    id,
    manager: 'npm',
    version: '1.0.0',
    directory: id,
    lock: 'package-lock.json',
    match: { format: id },
    dependencies: {},
  }))
  const catalog: Catalog = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sources: [],
    nodes: [],
    warnings: [],
    managers: {
      npm: ['1.0.0', '1.1.0', '2.0.0-beta.1', '2.0.0'].map((version) => ({
        version,
        node: '*',
        integrity: `integrity-${version}`,
      })),
      pnpm: [],
      yarn: [],
    },
  }
  const provisioned: string[] = []
  const installed: string[] = []
  let fail = true
  try {
    for (const fixture of fixtures) {
      await mkdir(join(root, 'fixtures', fixture.directory), { recursive: true })
      await writeFile(join(root, 'fixtures', fixture.directory, 'package.json'), '{}\n')
    }
    await writeFile(join(root, 'fixtures/recipes.json'), JSON.stringify(fixtures))
    const options = {
      root,
      catalog,
      concurrency: 2,
      quiet: true,
      provisionTool: ({ release }: { release: { version: string } }) => {
        provisioned.push(release.version)
        if (fail && release.version === '2.0.0')
          return Promise.reject(
            new Error('Unavailable historical executable', {
              cause: Object.assign(new Error('Bootstrap process exited'), { stderr: 'fixture-bootstrap-stderr' }),
            }),
          )
        const tool: Tool = {
          version: release.version,
          node: '/test/node',
          nodeVersion: '18.20.8',
          nodeArch: 'x64',
          nodeIntegrity: 'test',
          cli: '/test/cli',
          integrity: 'test',
          url: 'https://registry.npmjs.org',
        }
        return Promise.resolve(tool)
      },
      installFixture: ({ fixture, tool }: { fixture: Fixture; tool: Tool }) => {
        installed.push(`${tool.version}:${fixture.id}`)
        return Promise.resolve(
          makeObservation({
            id: `${tool.version}:${fixture.id}`,
            version: tool.version,
            command: frozenArgs(fixture.manager, tool.version),
            fixtureId: fixture.id,
            ...(fixture.controlDependencies
              ? {
                  frozenControl: makeObservation({
                    requestedDependencies: { ...fixture.dependencies, ...fixture.controlDependencies },
                    status: 'incompatible',
                    exitCode: 1,
                  }),
                }
              : {}),
          }),
        )
      },
    }
    const first = await seedData(options)
    assert.equal(first.totalCombinations, 6)
    assert.equal(first.attempted, 6)
    assert.equal(first.statuses.pass, 4)
    assert.equal(first.statuses.inconclusive, 2)
    assert.equal(provisioned.length, 3)
    assert.equal(installed.length, 4)
    const evidence = join(root, 'maintenance/evidence/initial-matrix')
    const failed = (await readSeedRows(evidence)).find((row) => row.status === 'inconclusive')!
    assert.match(await readFile(join(evidence, failed.logPath!), 'utf8'), /fixture-bootstrap-stderr/)
    const second = await seedData(options)
    assert.deepEqual(second.statuses, first.statuses)
    assert.equal(provisioned.length, 3, 'resume does not repeatedly retry unavailable releases')
    fail = false
    const third = await seedData({ ...options, retryIncomplete: true })
    assert.equal(third.statuses.pass, 6)
    assert.equal(third.statuses.inconclusive, 0)
    assert.equal(provisioned.length, 4)
    assert.equal(third.historyRows, 8, 'incomplete evidence remains in history after a successful retry')
    await writeFile(join(root, 'fixtures/one/package.json'), '{"changed": true}\n')
    const changed = await seedData(options)
    assert.equal(changed.attempted, 6)
    assert.equal(provisioned.length, 7, 'changed sample bytes create new combinations for all releases')
    assert.equal(changed.historyRows, 11)
    fixtures[0].controlDependencies = { example: '1.0.0' }
    await writeFile(join(root, 'fixtures/recipes.json'), JSON.stringify(fixtures))
    await seedData(options)
    assert.equal(provisioned.length, 10, 'old successful observations need a contradictory-manifest control')
    await seedData(options)
    assert.equal(provisioned.length, 10, 'the same successful control is reusable')
    fixtures[0].controlDependencies = { example: '2.0.0' }
    await writeFile(join(root, 'fixtures/recipes.json'), JSON.stringify(fixtures))
    await seedData(options)
    assert.equal(provisioned.length, 13, 'a changed control request requires fresh evidence')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
