import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { commitDate, enrichYarnCatalog, parseGitTags, parseYarnTags } from '../maintenance/enrich-yarn-catalog.js'
import { loadCatalog } from '../src/catalog.js'

import type { Catalog } from '../src/types.js'

test('official tag enumeration excludes prereleases and peeled commits take precedence', () => {
  assert.deepEqual(parseYarnTags({ tags: ['3.0.0-rc.1', '2.4.0', '2.4.0'] }), ['2.4.0'])
  const commit = 'b'.repeat(40)
  const tags = parseGitTags(
    `${commit}\trefs/tags/@yarnpkg/cli/2.4.0^{}\n${'a'.repeat(40)}\trefs/tags/@yarnpkg/cli/2.4.0\n`,
  )
  assert.equal(tags.get('2.4.0')?.commit, commit)
  assert.equal(parseGitTags(`${commit}\trefs/tags/@yarnpkg/cli/3.0.0-beta.1`).size, 0)
  assert.throws(() => parseYarnTags({ tags: ['invalid'] }), /version/)
})

test('enrichment retains original artifacts, adds metadata and tag-only bundles with auditable immutable sources', async () => {
  const output = await mkdtemp(join(tmpdir(), 'enrich-yarn-test-'))
  const gitObject = Buffer.from(
    'tree aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nauthor Test <test@example.com> 1575158400 +0000\ncommitter Test <test@example.com> 1575158400 +0000\n\nRelease\n',
  )
  const commit = createHash('sha1').update(`commit ${gitObject.length}\0`).update(gitObject).digest('hex')
  const original: Catalog = {
    schemaVersion: 1,
    generatedAt: '2026-09-09T00:00:00Z',
    nodes: [],
    sources: [],
    warnings: [],
    managers: {
      npm: [{ version: '1.0.0', node: null, integrity: 'original', tarball: 'original-url' }],
      pnpm: [],
      yarn: [
        { version: '6.0.0', node: '*', runtime: 'native', sourceUrl: 'https://repo.yarnpkg.com/releases' },
        {
          version: '4.0.0',
          node: '>=18',
          integrity: 'existing',
          tarball: 'existing-url',
          sourceUrl: 'existing-source',
        },
      ],
    },
  }
  const before = JSON.stringify(original)
  const verified: string[] = []
  const requests: string[] = []
  try {
    const result = await enrichYarnCatalog({
      catalog: original,
      output,
      cacheDirectory: join(output, 'cache'),
      gitTags: () =>
        Promise.resolve(['2.0.0', '2.1.0'].map((version) => `${commit}\trefs/tags/@yarnpkg/cli/${version}`).join('\n')),
      gitCommit: () => Promise.resolve(gitObject),
      fetchBytes: (url) => {
        requests.push(url)
        if (url.endsWith('/tags'))
          return Promise.resolve(
            Buffer.from(JSON.stringify({ tags: ['6.0.0', '4.0.0', '2.0.0', '2.1.0', '3.0.0-beta.1'] })),
          )
        if (url.includes('registry.npmjs.org'))
          return Promise.resolve(
            Buffer.from(
              JSON.stringify({
                versions: {
                  '2.0.0': {
                    version: '2.0.0',
                    engines: { node: '>=10' },
                    dist: { tarball: 'not-executable', integrity: 'wrong' },
                  },
                  '4.0.0': { version: '4.0.0', engines: { node: '>=99' } },
                },
                time: { '2.0.0': '2020-01-01T00:00:00Z' },
              }),
            ),
          )
        if (url.endsWith('/package.json'))
          return Promise.resolve(Buffer.from(JSON.stringify({ version: '2.1.0', engines: { node: '>=8' } })))
        if (url.includes('/git/commits/'))
          return Promise.resolve(
            Buffer.from(JSON.stringify({ sha: commit, committer: { date: '2019-12-01T00:00:00Z' } })),
          )
        return Promise.resolve(Buffer.from('console.log("fixture bundle")'))
      },
      verifyBundle: (release) => {
        verified.push(release.version)
        return Promise.resolve({ version: release.version })
      },
    })
    assert.equal(JSON.stringify(original), before)
    assert.equal(result.added, 2)
    assert.equal(result.exitCode, 0)
    const catalog = await loadCatalog(join(output, 'catalog.json'))
    assert.deepEqual(catalog.managers.npm, original.managers.npm)
    assert.deepEqual(
      catalog.managers.yarn.find((r) => r.version === '4.0.0'),
      original.managers.yarn[1],
    )
    assert.deepEqual(
      catalog.managers.yarn.find((r) => r.version === '6.0.0'),
      original.managers.yarn[0],
    )
    const rc = catalog.managers.yarn.find((r) => r.version === '2.1.0')!
    assert.equal(rc.node, '>=8')
    assert.equal(rc.releasedAt, '2019-12-01T00:00:00.000Z')
    assert.ok(rc.bundle?.url.includes(commit))
    assert.match(rc.integrity!, /^sha512-/)
    assert.equal(rc.tarball, undefined)
    assert.deepEqual(verified.sort(), ['2.0.0', '2.1.0'])
    assert.equal(requests.filter((url) => url.includes('/git/commits/')).length, 0)
    assert.throws(() => commitDate(Buffer.from('tampered'), commit), /integrity/)
    assert.match(await readFile(join(output, 'releases/2.1.0.json'), 'utf8'), /committer/)
  } finally {
    await rm(output, { recursive: true, force: true })
  }
})

test('an official bundle with a different actual version stays in the full catalog as an unresolved artifact', async () => {
  const output = await mkdtemp(join(tmpdir(), 'enrich-yarn-mismatch-test-'))
  const version = '2.0.5'
  const catalog: Catalog = {
    schemaVersion: 1,
    generatedAt: '2026-09-09T00:00:00Z',
    nodes: [],
    sources: [],
    warnings: [],
    managers: { npm: [], pnpm: [], yarn: [{ version, node: '>=10', sourceUrl: 'fresh-registry' }] },
  }
  try {
    const result = await enrichYarnCatalog({
      catalog,
      output,
      cacheDirectory: join(output, 'cache'),
      gitTags: () => Promise.resolve(`${'a'.repeat(40)}\trefs/tags/@yarnpkg/cli/${version}`),
      fetchBytes: (url) => {
        let body = 'console.log("2.0.4")'
        if (url.endsWith('/tags')) body = JSON.stringify({ tags: [version] })
        else if (url.includes('registry.npmjs.org'))
          body = JSON.stringify({ versions: { [version]: { version, engines: { node: '>=8' } } } })
        return Promise.resolve(Buffer.from(body))
      },
      verifyBundle: () => Promise.resolve({ version: '2.0.4' }),
    })
    assert.equal(result.exitCode, 2)
    assert.equal(result.added, 1)
    assert.equal(result.verified, 0)
    const saved = await loadCatalog(join(output, 'catalog.json'))
    assert.equal(saved.managers.yarn[0].version, version)
    assert.equal(saved.managers.yarn[0].node, '>=10', 'existing metadata remains fresh when its artifact is filled')
    assert.ok(saved.managers.yarn[0].bundle)
    assert.deepEqual(JSON.parse(await readFile(join(output, 'missing-versions.json'), 'utf8')), [version])
    assert.match(await readFile(join(output, 'releases', `${version}.json`), 'utf8'), /mismatch/)
  } finally {
    await rm(output, { recursive: true, force: true })
  }
})
