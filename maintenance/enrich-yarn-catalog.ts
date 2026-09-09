import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import semver from 'semver'

import { loadCatalog } from '../src/catalog.js'
import { parseRegistry } from '../src/metadata.js'
import { isStableVersion } from '../src/versions.js'

import { digest } from './model.js'
import { isNativeYarnRelease, provision } from './provision.js'

import type { Catalog, ManagerRelease, SourceReceipt } from '../src/types.js'

const exec = promisify(execFile)
const tagsUrl = 'https://repo.yarnpkg.com/tags'
const cliUrl = 'https://registry.npmjs.org/@yarnpkg%2Fcli'
const gitUrl = 'https://github.com/yarnpkg/berry.git'
interface GitTag {
  tag: string
  commit: string
}
export function parseYarnTags(value: unknown): string[] {
  const { tags } = value as { tags?: unknown }
  if (
    !Array.isArray(tags)
    || !tags.length
    || tags.some((tag: unknown) => typeof tag !== 'string' || !semver.valid(tag))
  )
    throw new Error('Official Yarn tags must contain exact valid versions')
  return [...new Set(tags as string[])].filter(isStableVersion).sort(semver.rcompare)
}
export function parseGitTags(body: string): Map<string, GitTag> {
  const records = new Map<string, GitTag>()
  const lines = body
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
  // Annotated tag objects are not commits: peeled refs always win, independent of line order.
  for (const peeled of [false, true])
    for (const [commit, ref] of lines) {
      const match = /^refs\/tags\/@yarnpkg\/cli\/(.+?)(\^\{\})?$/.exec(ref)
      if (!match || Boolean(match[2]) !== peeled) continue
      if (!/^[a-f\d]{40}$/.test(commit) || !semver.valid(match[1])) throw new Error('Invalid official Git tag')
      if (!isStableVersion(match[1])) continue
      records.set(match[1], { tag: `@yarnpkg/cli/${match[1]}`, commit })
    }
  return records
}
export interface EnrichYarnOptions {
  catalog: Catalog
  output: string
  cacheDirectory?: string
  versions?: string[]
  fetchBytes?: (url: string) => Promise<Buffer>
  gitTags?: () => Promise<string>
  gitCommit?: (commit: string) => Promise<Buffer>
  verifyBundle?: (release: ManagerRelease, directory: string) => Promise<Record<string, unknown>>
}
export function commitDate(bytes: Buffer, expected: string): string {
  const actual = createHash('sha1').update(`commit ${bytes.length}\0`).update(bytes).digest('hex')
  if (actual !== expected) throw new Error('Git commit object integrity mismatch')
  const match = /^committer .+ (\d+) [+-]\d{4}$/m.exec(bytes.toString())
  if (!match) throw new Error('Git commit has no committer timestamp')
  return new Date(Number(match[1]) * 1000).toISOString()
}
export interface EnrichYarnSummary {
  originalVersions: number
  tagVersions: number
  added: number
  verified: number
  failures: Array<{ version: string; error: string }>
  exitCode: 0 | 2
}
async function immutable(path: string, bytes: Buffer | string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  try {
    await writeFile(path, bytes, { flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    if (digest(await readFile(path)) !== digest(bytes))
      throw new Error(`Refusing to overwrite ${path}`, { cause: error })
  }
}
const json = (path: string, value: unknown): Promise<void> => immutable(path, `${JSON.stringify(value, null, 2)}\n`)
async function fetchOfficial(url: string): Promise<Buffer> {
  if (
    !['repo.yarnpkg.com', 'registry.npmjs.org', 'raw.githubusercontent.com', 'api.github.com'].includes(
      new URL(url).hostname,
    )
    || !url.startsWith('https:')
  )
    throw new Error(`Nonofficial metadata origin ${url}`)
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000), redirect: 'error' })
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`)
  return Buffer.from(await response.arrayBuffer())
}
/** Creates an independent catalog and immutable receipts; never rewrites the original matrix.
 * CLI: --input maintenance/evidence/initial-matrix/catalog.json --output .cache/yarn-catalog-enrichment
 * Uses a single ls-remote for all tag refs, then immutable commit URLs. Missing metadata stays explicit.
 */
export async function enrichYarnCatalog(options: EnrichYarnOptions): Promise<EnrichYarnSummary> {
  const output = resolve(options.output)
  const cache = resolve(options.cacheDirectory ?? '.cache/maintenance')
  const fetchBytes = options.fetchBytes ?? fetchOfficial
  const receipts = new Map<string, SourceReceipt>()
  async function source(url: string, id: string, loader = () => fetchBytes(url)): Promise<Buffer> {
    const path = join(output, 'sources', `${digest(url)}.body`)
    const receiptPath = `${path}.json`
    try {
      const bytes = await readFile(path)
      const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as SourceReceipt
      if (receipt.sha256 !== digest(bytes) || receipt.url !== url) throw new Error('Source receipt mismatch')
      receipts.set(url, receipt)
      return bytes
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const bytes = await loader()
    const receipt: SourceReceipt = { id, url, fetchedAt: new Date().toISOString(), sha256: digest(bytes) }
    await immutable(path, bytes)
    await json(receiptPath, receipt)
    receipts.set(url, receipt)
    return bytes
  }
  await json(join(output, 'original-catalog.json'), options.catalog)
  const [tagsBody, cliBody] = await Promise.all([source(tagsUrl, 'yarn-tags'), source(cliUrl, 'yarn-cli')])
  const versions = parseYarnTags(JSON.parse(tagsBody.toString()))
  const metadata = new Map(
    parseRegistry(JSON.parse(cliBody.toString()), { id: 'yarn-cli', url: cliUrl }).map((r) => [r.version, r]),
  )
  let gitBody: string
  const gitPath = join(output, 'git-tags.txt')
  try {
    gitBody = await readFile(gitPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    gitBody = await (
      options.gitTags
      ?? (async () =>
        (
          await exec('git', ['ls-remote', '--tags', gitUrl], {
            timeout: 120_000,
            killSignal: 'SIGKILL',
            maxBuffer: 32 * 1024 * 1024,
          })
        ).stdout)
    )()
    await immutable(gitPath, gitBody)
  }
  const gitTags = parseGitTags(gitBody)
  const gitReceipt: SourceReceipt = {
    id: 'yarn-git-tags',
    url: gitUrl,
    fetchedAt: receipts.get(tagsUrl)!.fetchedAt,
    sha256: digest(gitBody),
  }
  await json(join(output, 'git-tags-receipt.json'), { ...gitReceipt, command: ['git', 'ls-remote', '--tags', gitUrl] })
  receipts.set(gitUrl, gitReceipt)
  const existing = new Map(
    options.catalog.managers.yarn.filter((r) => isStableVersion(r.version)).map((r) => [r.version, r]),
  )
  const missing = versions.filter((version) => {
    const release = existing.get(version)
    return (
      (!options.versions || options.versions.includes(version))
      && release?.runtime !== 'native'
      && (!release?.integrity || (!release.tarball && !release.bundle))
    )
  })
  await json(join(output, 'missing-versions.json'), missing)
  const summary: EnrichYarnSummary = {
    originalVersions: existing.size,
    tagVersions: versions.length,
    added: 0,
    verified: 0,
    failures: [],
    exitCode: 0,
  }
  for (const release of existing.values()) {
    if (release.runtime === 'native' && !isNativeYarnRelease(release)) {
      summary.failures.push({ version: release.version, error: 'Invalid official native Yarn release descriptor' })
      summary.exitCode = 2
    }
  }
  const temporary = await mkdtemp(join(tmpdir(), 'yarn-enrichment-'))
  let gitPending: Promise<unknown> = Promise.resolve()
  const gitCommit =
    options.gitCommit
    ?? ((commit: string) => {
      const pending = gitPending.then(async () => {
        const repository = join(temporary, 'git')
        await exec('git', ['init', '--bare', repository], { timeout: 10_000 })
        await exec('git', ['-C', repository, 'fetch', '--depth=1', '--filter=blob:none', gitUrl, commit], {
          timeout: 120_000,
          killSignal: 'SIGKILL',
          maxBuffer: 4 * 1024 * 1024,
        })
        return (
          await exec('git', ['-C', repository, 'cat-file', 'commit', commit], { timeout: 10_000, encoding: 'buffer' })
        ).stdout
      })
      gitPending = pending.catch(() => {})
      return pending
    })
  const verify =
    options.verifyBundle
    ?? (async (release: ManagerRelease, directory: string) => {
      const tool = await provision('yarn', release, options.catalog, directory, undefined, {
        cacheDirectory: cache,
        timeoutMs: 120_000,
      })
      const command = [tool.node, tool.cli, '--version']
      const result = await exec(tool.node, command.slice(1), {
        cwd: directory,
        timeout: 120_000,
        killSignal: 'SIGKILL',
        maxBuffer: 4 * 1024 * 1024,
      })
      return {
        version: tool.version,
        command,
        stdout: result.stdout,
        stderr: result.stderr,
        node: tool.nodeVersion,
        nodeIntegrity: tool.nodeIntegrity,
        nodeBinarySha256: tool.nodeBinarySha256,
        nodeArch: tool.nodeArch,
      }
    })
  let cursor = 0
  async function worker(): Promise<void> {
    for (;;) {
      const version = missing.at(cursor++)
      if (!version) return
      let release: ManagerRelease = existing.get(version)
        ?? metadata.get(version) ?? { version, node: null, sourceUrl: tagsUrl }
      const provenance: Record<string, unknown> = { version, metadataUrl: release.sourceUrl }
      try {
        const git = gitTags.get(version)
        if (!git) throw new Error(`No immutable official Git tag for ${version}`)
        if (!metadata.has(version)) {
          const manifestUrl = `https://raw.githubusercontent.com/yarnpkg/berry/${git.commit}/packages/yarnpkg-cli/package.json`
          const manifest = JSON.parse((await source(manifestUrl, `yarn-manifest-${version}`)).toString()) as {
            version?: string
            engines?: { node?: string }
          }
          if (
            manifest.version !== version
            || (manifest.engines?.node !== undefined && !semver.validRange(manifest.engines.node))
          )
            throw new Error(`Invalid exact tag manifest for ${version}`)
          const commitUrl = `https://github.com/yarnpkg/berry/commit/${git.commit}`
          const commit = await source(commitUrl, `yarn-commit-${version}`, () => gitCommit(git.commit))
          release = { ...release, node: manifest.engines?.node ?? null, releasedAt: commitDate(commit, git.commit) }
          Object.assign(provenance, {
            enginesSource: manifestUrl,
            timeSource: commitUrl,
            timeField: 'Git commit object committer timestamp',
            timeCommand: ['git', 'cat-file', 'commit', git.commit],
            ...(release.node === null ? { warning: 'Official tag manifest has no engines.node; kept unknown' } : {}),
            timeMeaning: 'release tag commit time; not an npm publication timestamp',
          })
        } else Object.assign(provenance, { enginesSource: cliUrl, timeSource: cliUrl, timeField: `time[${version}]` })
        const url = `https://raw.githubusercontent.com/yarnpkg/berry/${git.commit}/packages/yarnpkg-cli/bin/yarn.js`
        const bytes = await source(url, `yarn-bundle-${version}`)
        const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
        release = { ...release, integrity, bundle: { ...git, url, size: bytes.length } }
        await immutable(join(output, 'bundles', `${digest(bytes)}.cjs`), bytes)
        // Provision rechecks the same cached bytes, including checksum and actual --version.
        await immutable(join(cache, 'downloads', digest(url)), bytes)
        existing.set(version, release)
        summary.added++
        const verified = await verify(release, join(temporary, version))
        if (verified.version !== version) throw new Error(`Actual bundle version mismatch for ${version}`)
        provenance.verification = verified
        summary.verified++
      } catch (error) {
        summary.failures.push({ version, error: String(error) })
        summary.exitCode = 2
        provenance.error = error instanceof Error ? { message: error.message, stack: error.stack } : String(error)
        // Keep a visible metadata-only version when its executable or exact source could not be verified.
        existing.set(version, release)
      }
      await json(join(output, 'releases', `${version}.json`), { release, ...provenance })
    }
  }
  try {
    await Promise.all([worker(), worker()])
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
  const catalog: Catalog = {
    ...options.catalog,
    generatedAt: receipts.get(tagsUrl)!.fetchedAt,
    sources: [...options.catalog.sources, ...receipts.values()],
    managers: {
      ...options.catalog.managers,
      yarn: [...existing.values()].sort((a, b) => semver.rcompare(a.version, b.version)),
    },
  }
  await json(join(output, 'catalog.json'), catalog)
  await json(join(output, 'report.json'), summary)
  return summary
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const value = (flag: string): string | undefined => process.argv.at(process.argv.indexOf(flag) + 1)
  Promise.resolve()
    .then(async () => {
      if (!process.argv.includes('--input') || !process.argv.includes('--output'))
        throw new Error('Required --input and --output')
      const input = resolve(value('--input')!)
      const output = resolve(value('--output')!)
      if (dirname(input) === output) throw new Error('Output must be separate from the original matrix')
      const result = await enrichYarnCatalog({
        catalog: await loadCatalog(input),
        output,
        ...(process.argv.includes('--cache-dir') ? { cacheDirectory: value('--cache-dir') } : {}),
      })
      console.log(JSON.stringify(result))
      process.exitCode = result.exitCode
    })
    .catch((error: unknown) => {
      console.error(error)
      process.exitCode = 2
    })
}
