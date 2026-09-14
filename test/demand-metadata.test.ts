import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'

import { collect, fetchCatalog, infer, loadRules, resolve } from '../src/index.js'

import type { Fetcher } from '../src/types.js'

async function project(t: TestContext, manifest: unknown) {
  const cwd = await mkdtemp(join(tmpdir(), 'nti-demand-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  await mkdir(join(cwd, '.git'))
  await writeFile(join(cwd, 'package.json'), JSON.stringify(manifest))
  return cwd
}
const nodeUrl = 'https://nodejs.org/dist/index.json'
const npmUrl = 'https://registry.npmjs.org/npm'
const pnpmUrl = 'https://registry.npmjs.org/pnpm'
const runtime = { node: '24.10.0', npm: '11.6.1', pnpm: '10.34.5', yarn: '4.0.0' }
function official(requests: string[], pnpmVersion = '11.17.0'): Fetcher {
  return (url) => {
    requests.push(url)
    let body: unknown
    if (url === nodeUrl)
      body = [
        { version: 'v18.20.8', npm: '10.8.2' },
        { version: 'v24.10.0', npm: '11.6.1' },
      ]
    else if (url === npmUrl)
      body = {
        versions: {
          '10.8.2': { name: 'npm', version: '10.8.2', engines: { node: '>=18' } },
          '11.6.1': { name: 'npm', version: '11.6.1', engines: { node: '>=20' } },
        },
      }
    else if (url === pnpmUrl)
      body = {
        versions: {
          [pnpmVersion]: { name: 'pnpm', version: pnpmVersion, engines: { node: '>=22.13' } },
        },
      }
    else if (url === `${pnpmUrl}/11.17.0`) body = { name: 'pnpm', version: '11.17.0', engines: { node: '>=22.13' } }
    else if (url === 'https://repo.yarnpkg.com/tags') body = { tags: ['4.0.0'] }
    else if (url === 'https://repo.yarnpkg.com/releases') body = { releaseLines: { zpm: { tags: ['6.0.0'] } } }
    else if (url === 'https://registry.npmjs.org/yarn' || url.includes('@yarnpkg%2Fcli'))
      body = {
        versions: { '4.0.0': { name: 'yarn', version: '4.0.0', engines: { node: '>=18' } } },
      }
    else throw new Error(`Unexpected request: ${url}`)
    return Promise.resolve({
      status: 200,
      ok: true,
      headers: { get: () => null },
      text: () => Promise.resolve(JSON.stringify(body)),
    })
  }
}

test('projects without a manager selector fetch only Node and npm', async (t) => {
  const requests: string[] = []
  const result = await infer({ cwd: await project(t, {}), runtime, fetcher: official(requests) })
  assert.equal(result.packageManager?.name, 'npm')
  assert.deepEqual(requests.sort(), [nodeUrl, npmUrl].sort())
})

test('inactive manager engines and a lower-priority Yarn lock do not request Yarn', async (t) => {
  const cwd = await project(t, { packageManager: 'pnpm@11.17.0', engines: { yarn: '4.0.0' } })
  await writeFile(join(cwd, 'yarn.lock'), '# yarn lockfile v1\n')
  const requests: string[] = []
  const result = await infer({ cwd, runtime, fetcher: official(requests) })
  assert.equal(result.packageManager?.name, 'pnpm')
  assert.deepEqual(requests.sort(), [nodeUrl, pnpmUrl].sort())
  assert.ok(result.trace.some((entry) => entry.manager === 'yarn' && entry.status === 'ignored'))
})

test('a missing pnpm pin fetches its manifest without unrelated manager data', async (t) => {
  const requests: string[] = []
  const result = await infer({
    cwd: await project(t, { packageManager: 'pnpm@11.17.0' }),
    runtime,
    fetcher: official(requests, '10.34.5'),
  })
  assert.equal(result.packageManager?.version, '11.17.0')
  assert.deepEqual(requests.sort(), [nodeUrl, pnpmUrl, `${pnpmUrl}/11.17.0`].sort())
})

test('a higher-priority Node constraint can require fetching npm fallback', async (t) => {
  const requests: string[] = []
  const result = await infer({
    cwd: await project(t, { packageManager: 'pnpm@11.17.0' }),
    runtime,
    node: '18',
    fetcher: official(requests),
  })
  assert.equal(result.node?.version, '18.20.8')
  assert.equal(result.packageManager?.name, 'npm')
  assert.equal(result.packageManager.version, '10.8.2')
  assert.deepEqual(requests, [nodeUrl, pnpmUrl, npmUrl])
})

test('an invalid manager selector does not fetch any alternative manager', async (t) => {
  const requests: string[] = []
  const result = await infer({
    cwd: await project(t, { packageManager: 'pnpm@invalid-version' }),
    runtime,
    fetcher: official(requests),
  })
  assert.equal(result.packageManager?.name, 'npm')
  assert.deepEqual(requests.sort(), [nodeUrl, npmUrl].sort())
})

test('demand fetching preserves exhaustive selection across competing declarations', async (t) => {
  const cwd = await project(t, {})
  const catalog = await fetchCatalog({ fetcher: official([]) })
  const rules = await loadRules()
  for (const node of ['18', '24', '>=18', '<18']) {
    for (const packageManager of ['pnpm@11.17.0', 'yarn@4.0.0', 'npm@10.8.2', 'pnpm@invalid']) {
      for (const npm of ['>=11', '^10', '*']) {
        await writeFile(
          join(cwd, 'package.json'),
          JSON.stringify({
            packageManager,
            volta: { node: '18' },
            devEngines: { packageManager: { name: 'yarn', version: '4.0.0' } },
            engines: { npm, pnpm: '>=11', yarn: '^4' },
          }),
        )
        const { sources } = await collect({ cwd, node })
        const expected = resolve({ sources, runtime }, catalog, rules)
        const actual = await infer({ cwd, node, runtime, rules, fetcher: official([]) })
        const context = JSON.stringify({ node, packageManager, npm })
        assert.deepEqual(actual.node, expected.node, context)
        assert.deepEqual(actual.packageManager, expected.packageManager, context)
        assert.deepEqual(actual.candidates, expected.candidates, context)
        assert.deepEqual(
          actual.trace.map((entry) => entry.status),
          expected.trace.map((entry) => entry.status),
          context,
        )
      }
    }
  }
})
