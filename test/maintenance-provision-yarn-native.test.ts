import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import test from 'node:test'
import { promisify } from 'node:util'

import { digest } from '../maintenance/model.js'
import { nativeYarnPackage, provision, provisionNativeYarn } from '../maintenance/provision.js'
import { execute } from '../maintenance/runner.js'

import type { Catalog, ManagerRelease } from '../src/types.js'
import type { Buffer } from 'node:buffer'

const exec = promisify(execFile)
const release: ManagerRelease = {
  version: '6.0.0',
  node: '*',
  runtime: 'native',
  sourceUrl: 'https://repo.yarnpkg.com/releases',
}
const catalog: Catalog = {
  schemaVersion: 1,
  generatedAt: '',
  sources: [],
  warnings: [],
  nodes: [{ version: process.versions.node }],
  managers: { npm: [], pnpm: [], yarn: [release] },
}

test('native Yarn platform selection uses official static Linux artifacts and reports unsupported hosts', () => {
  assert.equal(nativeYarnPackage('darwin', 'arm64'), '@yarnpkg/yarn-aarch64-apple-darwin')
  assert.equal(nativeYarnPackage('darwin', 'x64'), '@yarnpkg/yarn-x86_64-apple-darwin')
  assert.equal(nativeYarnPackage('linux', 'arm64'), '@yarnpkg/yarn-aarch64-unknown-linux-musl')
  assert.equal(nativeYarnPackage('linux', 'x64'), '@yarnpkg/yarn-x86_64-unknown-linux-musl')
  assert.throws(() => nativeYarnPackage('win32', 'x64'), /Unsupported native Yarn platform/)
  assert.throws(() => nativeYarnPackage('linux', 'ia32'), /Unsupported native Yarn platform/)
})

test('native Yarn verifies official metadata, safe archive, strongest SRI, executable version and immutable receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-yarn-test-'))
  const originalFetch = globalThis.fetch
  const name = nativeYarnPackage()
  const metadataUrl = `https://registry.npmjs.org/${encodeURIComponent(name)}/6.0.0`
  const tarball = `https://registry.npmjs.org/${name}/-/${name.split('/')[1]}-6.0.0.tgz`
  const manifest = { name, version: '6.0.0', os: [process.platform], cpu: [process.arch], bin: { yarn: 'yarn' } }
  let metadata: Record<string, unknown>
  let bytes: Buffer
  const requests: string[] = []
  async function archive(options: { manifest?: unknown; version?: string; link?: boolean } = {}): Promise<void> {
    await rm(join(root, 'package'), { recursive: true, force: true })
    await mkdir(join(root, 'package'))
    await writeFile(join(root, 'package/package.json'), JSON.stringify(options.manifest ?? manifest))
    const script = `#!/bin/sh\nprintf '${options.version ?? '6.0.0'}\\n'\n`
    if (options.link) await symlink('/bin/sh', join(root, 'package/yarn'))
    else await writeFile(join(root, 'package/yarn'), script)
    await exec('tar', ['-czf', join(root, 'archive.tgz'), '-C', root, 'package'])
    bytes = await readFile(join(root, 'archive.tgz'))
    metadata = {
      ...manifest,
      dist: { tarball, integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` },
    }
  }
  globalThis.fetch = (input) => {
    let url: string
    if (typeof input === 'string') url = input
    else if (input instanceof URL) url = input.href
    else url = input.url
    requests.push(url)
    if (url === metadataUrl) return Promise.resolve(Response.json(metadata))
    assert.equal(url, tarball, 'native Yarn must not fetch Berry bundles, Node archives or bootstrap packages')
    return Promise.resolve(new Response(Uint8Array.from(bytes)))
  }
  try {
    await archive()
    const tool = await provision('yarn', release, catalog, join(root, 'tools'), undefined, {
      bootstrapDependencies: true,
    })
    assert.equal(tool.execution, 'native')
    assert.equal(tool.bootstrap, undefined)
    assert.equal(tool.native?.binarySha256, digest(await readFile(tool.cli)))
    assert.equal(tool.url, tarball)
    assert.deepEqual(JSON.parse(await readFile(join(dirname(tool.cli), 'receipt.json'), 'utf8')), tool.native)
    assert.equal((await execute(tool, ['--version'], root)).output.trim(), '6.0.0')
    assert.deepEqual(requests, [metadataUrl, tarball])
    const firstReceipt = await readFile(join(dirname(tool.cli), 'receipt.json'), 'utf8')
    const second = await provisionNativeYarn('6.0.0', join(root, 'tools'))
    assert.notEqual(second.cli, tool.cli)
    assert.equal(await readFile(join(dirname(tool.cli), 'receipt.json'), 'utf8'), firstReceipt)

    for (const invalid of [
      { name: '@other/yarn' },
      { version: '6.0.1' },
      { os: ['wrong'] },
      { cpu: ['wrong'] },
      { bin: { yarn: '../yarn' } },
      { dist: { tarball, integrity: undefined } },
    ]) {
      await archive()
      metadata = { ...metadata!, ...invalid }
      await assert.rejects(provisionNativeYarn('6.0.0', root), /Invalid official native Yarn package metadata/)
    }
    await archive()
    metadata!.dist = { tarball: 'https://registry.npmjs.org/unrelated.tgz', integrity: 'sha512-invalid' }
    await assert.rejects(provisionNativeYarn('6.0.0', root), /Unexpected official native Yarn artifact URL/)
    await archive()
    metadata!.dist = {
      tarball,
      integrity: `sha512-invalid sha256-${createHash('sha256').update(bytes!).digest('base64')}`,
    }
    await assert.rejects(provisionNativeYarn('6.0.0', root), /integrity mismatch/)
    await archive({ manifest: { ...manifest, version: '6.0.1' } })
    await assert.rejects(provisionNativeYarn('6.0.0', root), /archive manifest/)
    await archive({ version: '6.0.1' })
    await assert.rejects(provisionNativeYarn('6.0.0', root), /Actual tool version mismatch/)
    await archive({ link: true })
    await assert.rejects(provisionNativeYarn('6.0.0', root), /Unsafe native archive entry/)
    await assert.rejects(
      provision('yarn', { ...release, version: '6.0.0-rc.20' }, catalog, root),
      /Prerelease versions are excluded/,
    )
    await assert.rejects(
      provision('yarn', { ...release, sourceUrl: 'other' }, catalog, root),
      /Invalid official native Yarn release descriptor/,
    )
  } finally {
    globalThis.fetch = originalFetch
    await rm(root, { recursive: true, force: true })
  }
})
