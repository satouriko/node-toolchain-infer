import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import process from 'node:process'
import test from 'node:test'

import { digest, type Fixture } from '../maintenance/model.js'
import { retestInitial, type RetestToolRequest } from '../maintenance/retest-initial.js'
import { runFixture } from '../maintenance/runner.js'

import type { InitialReport } from '../maintenance/compile-initial.js'
import type { SeedRow } from '../scripts/seed-data.js'
import type { Catalog } from '../src/types.js'

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'retest-initial-test-'))
  const fixture: Fixture = {
    id: 'fixture',
    manager: 'npm',
    version: '2.0.0',
    directory: 'basic',
    lock: 'package-lock.json',
    match: { format: 3 },
    dependencies: { 'is-number': '7.0.0' },
  }
  const fixtureRoot = join(root, 'fixtures')
  await mkdir(join(fixtureRoot, 'basic'), { recursive: true })
  await writeFile(join(fixtureRoot, 'basic/package.json'), '{"dependencies":{"is-number":"7.0.0"}}')
  await writeFile(join(fixtureRoot, 'basic/package-lock.json'), '{"lockfileVersion":3}')
  const cli = join(root, 'fake-tool.cjs')
  await writeFile(
    cli,
    `const fs = require('node:fs'); fs.mkdirSync('node_modules/is-number', {recursive:true}); fs.writeFileSync('node_modules/is-number/package.json', '{"version":"7.0.0"}');`,
  )
  const catalog: Catalog = {
    schemaVersion: 1,
    generatedAt: '2026-09-09T00:00:00Z',
    sources: [],
    warnings: [],
    nodes: [{ version: process.versions.node }],
    managers: {
      npm: ['1.0.0', '2.0.0'].map((version) => ({
        version,
        node: '>=18',
        integrity: `official-${version}`,
        tarball: `https://registry.npmjs.org/npm/-/npm-${version}.tgz`,
      })),
      pnpm: [],
      yarn: [],
    },
  }
  const report: InitialReport = {
    catalogHash: digest(JSON.stringify(catalog)),
    fixtures: [],
    issues: [],
    exitCode: 1,
    retests: [
      {
        fixtureId: fixture.id,
        beforeVersion: '1.0.0',
        afterVersion: '2.0.0',
        reason: 'incomparable-transition',
        existingBefore: [],
        existingAfter: [],
        nodeCandidates: [process.versions.node],
        nodeCandidateNote: 'test',
      },
    ],
  }
  const calls: RetestToolRequest[] = []
  const nodeIntegrity = `sha256-${createHash('sha256')
    .update(await readFile(process.execPath))
    .digest('base64')}`
  const provisionTool = (request: RetestToolRequest) => {
    calls.push(request)
    return Promise.resolve({
      node: process.execPath,
      nodeVersion: request.node,
      nodeArch: request.nodeArch,
      nodeIntegrity,
      cli,
      version: request.release.version,
      integrity: request.release.integrity!,
      url: request.release.tarball!,
    })
  }
  return {
    root,
    fixtureRoot,
    output: join(root, 'evidence'),
    catalog,
    report,
    fixtures: [fixture],
    provisionTool,
    calls,
  }
}
async function rows(output: string): Promise<SeedRow[]> {
  return Promise.all(
    (await readdir(join(output, 'rows')))
      .filter((file) => file.endsWith('.json'))
      .map(async (file) => JSON.parse(await readFile(join(output, 'rows', file), 'utf8')) as SeedRow),
  )
}

test('paired retests use one verified Node binary, retain the complete catalog and resume without repeating installs', async () => {
  const options = await setup()
  try {
    const result = await retestInitial({ ...options, cacheDirectory: '.cache/maintenance' })
    assert.equal(result.completePairs, 1)
    assert.equal(result.writtenRows, 2)
    assert.ok(options.calls.every((request) => isAbsolute(request.cache)))
    assert.deepEqual(
      options.calls.map((request) => request.node),
      [process.versions.node, process.versions.node],
    )
    const saved = await rows(options.output)
    assert.equal(saved.length, 2)
    assert.ok(saved.every((row) => row.status === 'pass' && row.protocol === 'frozen-initial-matrix-v2'))
    assert.equal(saved[0].observation?.nodeIntegrity, saved[1].observation?.nodeIntegrity)
    assert.equal(saved[0].observation?.nodeArch, saved[1].observation?.nodeArch)
    assert.deepEqual(JSON.parse(await readFile(join(options.output, 'catalog.json'), 'utf8')), options.catalog)
    const again = await retestInitial(options)
    assert.equal(again.writtenRows, 0)
    assert.equal(again.reusedSides, 2)
    assert.equal(options.calls.length, 2)
    assert.equal((await rows(options.output)).length, 2)
  } finally {
    await rm(options.root, { recursive: true, force: true })
  }
})

test('no common candidate writes explicit incomplete rows on both sides without falling back to host Node', async () => {
  const options = await setup()
  try {
    options.report.retests[0].nodeCandidates = ['0.0.1']
    const result = await retestInitial(options)
    assert.equal(result.exitCode, 2)
    assert.equal(options.calls.length, 0)
    const saved = await rows(options.output)
    assert.equal(saved.length, 2)
    assert.ok(saved.every((row) => row.status === 'inconclusive' && !row.observation && row.error))
    assert.equal((await retestInitial(options)).writtenRows, 0)
  } finally {
    await rm(options.root, { recursive: true, force: true })
  }
})

test('paired resume reruns obsolete settings without editing rows or requiring an incomplete retry', async () => {
  const options = await setup()
  try {
    const fixture = options.fixtures[0]
    fixture.manager = 'pnpm'
    fixture.version = '7.33.1'
    fixture.lock = 'pnpm-lock.yaml'
    fixture.match = { format: '6.0' }
    await rm(join(options.fixtureRoot, fixture.directory, 'package-lock.json'))
    await writeFile(
      join(options.fixtureRoot, fixture.directory, fixture.lock),
      'lockfileVersion: 6.0\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n',
    )
    options.catalog.managers.pnpm = options.catalog.managers.npm.map((release, index) => ({
      ...release,
      version: `7.33.${index}`,
    }))
    options.catalog.managers.npm = []
    options.report.catalogHash = digest(JSON.stringify(options.catalog))
    Object.assign(options.report.retests[0], { beforeVersion: '7.33.0', afterVersion: '7.33.1' })
    assert.equal((await retestInitial(options)).completePairs, 1)
    const historical = await rows(options.output)
    const originals = new Map<string, string>()
    for (const [index, row] of historical.entries()) {
      const status = index === 0 ? 'incompatible' : 'inconclusive'
      row.status = status
      Object.assign(row.observation!, { environment: undefined, status, exitCode: 1, installed: {}, semantic: false })
      const bytes = JSON.stringify(row)
      const path = join(options.output, 'rows', `${row.id}.json`)
      await writeFile(path, bytes)
      originals.set(path, bytes)
    }
    const corrected = await retestInitial(options)
    assert.equal(corrected.completePairs, 1)
    assert.equal(corrected.reusedSides, 0)
    assert.equal(corrected.writtenRows, 2)
    for (const [path, bytes] of originals) assert.equal(await readFile(path, 'utf8'), bytes)
    const all = await rows(options.output)
    assert.equal(all.length, 4)
    assert.equal(new Set(all.map((row) => row.key)).size, 2)
    const resumed = await retestInitial(options)
    assert.equal(resumed.reusedSides, 2)
    assert.equal(resumed.writtenRows, 0)
  } finally {
    await rm(options.root, { recursive: true, force: true })
  }
})

test('downloaded Node archive provenance is distinct from the executable byte checksum', async () => {
  const options = await setup()
  try {
    const binarySha256 = digest(await readFile(process.execPath))
    const result = await retestInitial({
      ...options,
      provisionTool: async (request) => ({
        ...(await options.provisionTool(request)),
        nodeIntegrity: 'sha256-verified-official-archive',
        nodeBinarySha256: binarySha256,
      }),
    })
    assert.equal(result.completePairs, 1)
    assert.ok(
      (await rows(options.output)).every(
        (row) => row.observation?.nodeIntegrity === 'sha256-verified-official-archive',
      ),
    )
  } finally {
    await rm(options.root, { recursive: true, force: true })
  }
})

test('provisioning failure remains auditable and explicit retry appends successful rows', async () => {
  const options = await setup()
  try {
    const failed = await retestInitial({
      ...options,
      provisionTool: () => Promise.reject(new Error('missing historical executable')),
    })
    assert.equal(failed.exitCode, 2)
    const old = await rows(options.output)
    assert.equal(old.length, 2)
    const retried = await retestInitial({ ...options, retryIncomplete: true })
    assert.equal(retried.completePairs, 1)
    const all = await rows(options.output)
    assert.equal(all.length, 4)
    for (const row of old)
      assert.deepEqual(
        all.find((item) => item.id === row.id),
        row,
      )
  } finally {
    await rm(options.root, { recursive: true, force: true })
  }
})

test('partial retry retains a conclusive side while rerunning only the incomplete side', async () => {
  const options = await setup()
  const installed: string[] = []
  let fail = true
  try {
    const installFixture = async (request: import('../maintenance/retest-initial.js').RetestInstallRequest) => {
      installed.push(request.tool.version)
      if (fail && request.tool.version === '2.0.0') throw new Error('transient command failure')
      return runFixture(request.fixture, request.tool, request.root, request.directory, request.evidence)
    }
    assert.equal((await retestInitial({ ...options, installFixture })).exitCode, 2)
    fail = false
    const retried = await retestInitial({ ...options, installFixture, retryIncomplete: true })
    assert.equal(retried.completePairs, 1)
    assert.equal(retried.reusedSides, 1)
    assert.deepEqual(installed, ['1.0.0', '2.0.0', '2.0.0'])
    assert.equal((await rows(options.output)).length, 3)
  } finally {
    await rm(options.root, { recursive: true, force: true })
  }
})

test('filtering by one endpoint retains both sides and worker concurrency stays bounded', async () => {
  const options = await setup()
  let active = 0
  let maximum = 0
  let synchronize = false
  let arrived = 0
  let release = () => {}
  const firstPair = new Promise<void>((resolve) => {
    release = resolve
  })
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    options.fixtures = ['a', 'b', 'c'].map((id) => ({ ...options.fixtures[0], id }))
    options.report.retests = options.fixtures.map((fixture) => ({
      ...options.report.retests[0],
      fixtureId: fixture.id,
    }))
    const provisionTool = async (request: RetestToolRequest) => {
      active++
      maximum = Math.max(maximum, active)
      if (synchronize && arrived < 2) {
        arrived++
        if (arrived === 2) release()
        await firstPair
      }
      try {
        return await options.provisionTool(request)
      } finally {
        active--
      }
    }
    const filtered = await retestInitial({
      ...options,
      fixtureIds: ['b'],
      versions: ['2.0.0'],
      provisionTool,
      concurrency: 2,
    })
    assert.equal(filtered.selectedPairs, 1)
    assert.deepEqual((await rows(options.output)).map((row) => row.version).sort(), ['1.0.0', '2.0.0'])
    synchronize = true
    // Meet at the first two jobs instead of assuming a 20 ms delay overlaps under load.
    timeout = setTimeout(release, 10_000)
    const complete = await retestInitial({ ...options, provisionTool, concurrency: 2 })
    assert.equal(complete.completePairs, 3)
    assert.equal(maximum, 2)
  } finally {
    clearTimeout(timeout)
    release()
    await rm(options.root, { recursive: true, force: true })
  }
})

test('bootstrap dependency locks and logs are copied into durable evidence and reused independently of cache', async () => {
  const options = await setup()
  try {
    const lock = '{"lockfileVersion":3,"packages":{"":{"dependencies":{"tiny":"1.0.0"}}}}'
    const lockfilePath = join(options.root, 'bootstrap-lock.json')
    const logPath = join(options.root, 'bootstrap.log')
    await writeFile(lockfilePath, lock)
    await writeFile(logPath, 'dependency installation log')
    const provisionTool = async (request: RetestToolRequest) => ({
      ...(await options.provisionTool(request)),
      bootstrap: {
        protocol: 1 as const,
        node: process.versions.node,
        npmVersion: '10.0.0',
        npmCliHash: 'test-cli',
        command: ['install', '--ignore-scripts'],
        lockfilePath,
        lockfileSha256: digest(lock),
        logPath,
      },
    })
    assert.equal((await retestInitial({ ...options, provisionTool })).completePairs, 1)
    for (const row of await rows(options.output)) {
      const bootstrap = row.observation?.bootstrap
      assert.ok(bootstrap)
      assert.ok(!bootstrap.lockfilePath.startsWith('/'))
      assert.equal(await readFile(join(options.output, bootstrap.lockfilePath), 'utf8'), lock)
      assert.equal(await readFile(join(options.output, bootstrap.logPath), 'utf8'), 'dependency installation log')
    }
    await rm(lockfilePath)
    await rm(logPath)
    assert.equal((await retestInitial({ ...options, provisionTool })).reusedSides, 2)
  } finally {
    await rm(options.root, { recursive: true, force: true })
  }
})

test('bootstrap receipts survive a failed paired runtime verification before any observation exists', async () => {
  const options = await setup()
  try {
    const lockfilePath = join(options.root, 'bootstrap-lock.json')
    const logPath = join(options.root, 'bootstrap.log')
    const lock = '{"lockfileVersion":3}'
    await writeFile(lockfilePath, lock)
    await writeFile(logPath, 'dependency install before runtime failure')
    const result = await retestInitial({
      ...options,
      provisionTool: async (request) => ({
        ...(await options.provisionTool(request)),
        nodeIntegrity: 'wrong-binary',
        bootstrap: {
          protocol: 1,
          node: process.versions.node,
          npmVersion: '10.0.0',
          npmCliHash: 'test-cli',
          command: ['install'],
          lockfilePath,
          lockfileSha256: digest(lock),
          logPath,
        },
      }),
    })
    assert.equal(result.exitCode, 2)
    assert.equal(await readFile(join(options.output, 'bootstrap', digest(lock), 'package-lock.json'), 'utf8'), lock)
    const provisionDirs = await readdir(join(options.output, 'provision'))
    const receipt = JSON.parse(
      await readFile(join(options.output, 'provision', provisionDirs[0], '0.json'), 'utf8'),
    ) as { bootstrap: { logPath: string } }
    assert.equal(
      await readFile(join(options.output, receipt.bootstrap.logPath), 'utf8'),
      'dependency install before runtime failure',
    )
  } finally {
    await rm(options.root, { recursive: true, force: true })
  }
})

test('a runtime integrity mismatch on one side prevents both paired installs', async () => {
  const options = await setup()
  let installed = 0
  try {
    const provisionTool = async (request: RetestToolRequest) => ({
      ...(await options.provisionTool(request)),
      ...(request.release.version === '2.0.0' ? { nodeIntegrity: 'wrong-binary' } : {}),
    })
    const result = await retestInitial({
      ...options,
      provisionTool,
      installFixture: () => {
        installed++
        throw new Error('must not execute')
      },
    })
    assert.equal(result.exitCode, 2)
    assert.equal(installed, 0)
    assert.ok(
      (await rows(options.output)).every((row) => row.status === 'inconclusive' && row.error?.includes('executable')),
    )
  } finally {
    await rm(options.root, { recursive: true, force: true })
  }
})

test('an architecture claim cannot substitute for the actual selected Node runtime architecture', async () => {
  const options = await setup()
  try {
    const nodeArch = process.arch === 'arm64' ? 'x64' : 'arm64'
    const result = await retestInitial({ ...options, nodeArch })
    assert.equal(result.exitCode, 2)
    assert.ok(
      (await rows(options.output)).every((row) => row.status === 'inconclusive' && row.error?.includes('architecture')),
    )
  } finally {
    await rm(options.root, { recursive: true, force: true })
  }
})

test('an explicit published Node may override report candidates while preserving both endpoints', async () => {
  const options = await setup()
  try {
    options.report.retests[0].nodeCandidates = []
    const result = await retestInitial({ ...options, node: process.versions.node })
    assert.equal(result.completePairs, 1)
    assert.deepEqual(
      options.calls.map((request) => request.node),
      [process.versions.node, process.versions.node],
    )
  } finally {
    await rm(options.root, { recursive: true, force: true })
  }
})

test('explicit runtime overrides require fixed catalog membership and both engines', async () => {
  for (const incompatible of [false, true]) {
    const options = await setup()
    try {
      if (incompatible) {
        options.catalog.managers.npm[1].node = '<18'
        options.report.catalogHash = digest(JSON.stringify(options.catalog))
      }
      const result = await retestInitial({ ...options, node: incompatible ? process.versions.node : '0.0.1' })
      assert.equal(result.exitCode, 2)
      assert.equal(options.calls.length, 0)
      assert.ok((await rows(options.output)).every((row) => row.status === 'inconclusive'))
    } finally {
      await rm(options.root, { recursive: true, force: true })
    }
  }
})
