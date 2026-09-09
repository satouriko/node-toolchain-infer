import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { detectRuntime, infer } from '../src/index.js'

import type { Catalog } from '../src/types.js'

const catalog: Catalog = {
  schemaVersion: 1,
  generatedAt: '2026-09-09T00:00:00Z',
  sources: [],
  warnings: [],
  nodes: [
    { version: '18.20.8', npm: '10.8.2' },
    { version: '22.9.0', npm: '10.9.0' },
  ],
  managers: {
    npm: [
      { version: '10.8.2', node: '>=18' },
      { version: '10.9.0', node: '>=18' },
    ],
    pnpm: [],
    yarn: [],
  },
}
const runtime = { node: '22.9.0', npm: '10.9.0' }
test('public infer integrates filesystem priorities and preserves runtime fallback without network', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'nti-api-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  await mkdir(join(cwd, '.git'))
  await writeFile(join(cwd, 'package.json'), JSON.stringify({ engines: { node: '18' } }))
  const result = await infer({ cwd, runtime, catalog, node: '>=18 <23' })
  assert.equal(result.node?.version, '18.20.8')
  assert.equal(result.packageManager?.version, '10.8.2')
  assert.equal(result.warnings.length, 0)
  const offline = await infer({
    cwd,
    runtime,
    fetcher: () => Promise.reject(new Error('offline')),
  })
  assert.equal(offline.node?.version, '22.9.0')
  assert.ok(offline.warnings.some((w) => w.code === 'metadata-unavailable'))
})
test('runtime npm comes from the selected Node installation, not PATH npm', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'nti-runtime-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bin = join(root, 'bin')
  await mkdir(bin)
  await writeFile(join(bin, 'node'), 'fixture')
  await mkdir(join(root, 'lib/node_modules/npm'), { recursive: true })
  await writeFile(join(root, 'lib/node_modules/npm/package.json'), JSON.stringify({ name: 'npm', version: '10.8.2' }))
  const result = await detectRuntime({
    execPath: join(bin, 'node'),
    nodeVersion: '18.20.8',
    localManagers: false,
    env: { PATH: '/not/npm' },
  })
  assert.deepEqual(result.runtime, { node: '18.20.8', npm: '10.8.2' })
})
test('CLI describes semver inputs and warns on unsupported options', async () => {
  const execute = promisify(execFile)
  const help = await execute(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--help'])
  assert.match(help.stdout, /--package-manager/)
  await assert.rejects(execute(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--wrong']), /Unknown option/)
})

test('infer fetches an explicitly pinned prerelease separately and derives only stable Node candidates', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'nti-api-prerelease-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  await mkdir(join(cwd, '.git'))
  await writeFile(join(cwd, 'package.json'), JSON.stringify({ packageManager: 'pnpm@10.0.0-rc.1' }))
  const requests: string[] = []
  const result = await infer({
    cwd,
    runtime,
    fetcher: (url) => {
      requests.push(url)
      let body: unknown
      if (url === 'https://nodejs.org/dist/index.json')
        body = [...catalog.nodes, { version: '23.0.0-rc.1', npm: '10.9.0' }]
      else if (url === 'https://repo.yarnpkg.com/tags') body = { tags: ['4.0.0', '5.0.0-rc.1'] }
      else if (url === 'https://repo.yarnpkg.com/releases') body = { releaseLines: { zpm: { tags: ['6.0.0-rc.20'] } } }
      else if (url === 'https://registry.npmjs.org/pnpm/10.0.0-rc.1')
        body = { name: 'pnpm', version: '10.0.0-rc.1', engines: { node: '>=18' } }
      else {
        const name = decodeURIComponent(new URL(url).pathname.slice(1))
        const versions: Record<string, string> = { npm: '10.9.0', pnpm: '9.0.0' }
        const version = versions[name] ?? '4.0.0'
        body = { versions: { [version]: { name, version, engines: { node: '>=18' } } } }
      }
      return Promise.resolve({
        status: 200,
        ok: true,
        headers: { get: () => null },
        text: () => Promise.resolve(JSON.stringify(body)),
      })
    },
  })
  assert.equal(result.packageManager?.version, '10.0.0-rc.1')
  assert.equal(result.node?.version, '22.9.0')
  assert.deepEqual(result.candidates.nodes, ['22.9.0', '18.20.8'])
  assert.ok(requests.includes('https://registry.npmjs.org/pnpm/10.0.0-rc.1'))
  assert.equal(requests.length, 9, 'eight stable sources plus one explicit manifest, no prerelease enumeration')
})

test('an explicit catalog remains offline even when it lacks a pinned prerelease', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'nti-api-offline-pin-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  await mkdir(join(cwd, '.git'))
  const result = await infer({
    cwd,
    runtime,
    catalog,
    packageManager: 'pnpm@10.0.0-rc.1',
    fetcher: () => {
      throw new Error('unexpected network request')
    },
  })
  assert.equal(result.packageManager?.name, 'npm')
  assert.ok(result.warnings.some((warning) => warning.code === 'constraint-conflict'))
})
