import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'

import semver from 'semver'

import { isStableVersion } from '../src/versions.js'

import { type BootstrapReceipt, bootstrapTool } from './bootstrap.js'
import { digest } from './model.js'

import type { Catalog, Manager, ManagerRelease } from '../src/types.js'

const exec = promisify(execFile)
export function verifyIntegrity(bytes: Buffer, integrity: string): void {
  const candidates = integrity
    .split(/\s+/)
    .map((value) => /^(sha512|sha384|sha256|sha1)-([A-Za-z0-9+/=]+)$/.exec(value))
    .filter((value) => value !== null)
  // Prefer the strongest declared digest; never silently fall back after its mismatch.
  const match = ['sha512', 'sha384', 'sha256', 'sha1']
    .flatMap((algorithm) => candidates.filter((item) => item[1] === algorithm))
    .at(0)
  if (!match || createHash(match[1]).update(bytes).digest('base64') !== match[2])
    throw new Error('Tarball integrity mismatch or unsupported integrity')
}
export function selectNode(range: string | null, versions: string[], current = process.versions.node): string {
  if (isStableVersion(current) && (!range || semver.satisfies(current, range))) return current
  const version = semver.maxSatisfying(versions.filter(isStableVersion), range ?? '*')
  if (!version) throw new Error(`No compatible Node available for ${range}`)
  return version
}
export interface ProvisionOptions {
  cacheDirectory?: string
  nodeArch?: 'x64' | 'arm64'
  timeoutMs?: number
  historicalNode?: boolean
  bootstrapDependencies?: boolean
}
export function selectHistoricalNode(release: ManagerRelease, catalog: Catalog): string {
  if (!release.releasedAt)
    return selectNode(
      release.node,
      catalog.nodes.map((item) => item.version),
    )
  const cutoff = Date.parse(release.releasedAt)
  if (!Number.isFinite(cutoff))
    throw new Error(`Invalid release date for historical Node selection: ${release.releasedAt}`)
  const versions = catalog.nodes
    .filter(
      (item) =>
        item.date
        && Date.parse(item.date) <= cutoff
        && !semver.prerelease(item.version)
        && (!release.node || semver.satisfies(item.version, release.node)),
    )
    .map((item) => item.version)
    .sort(semver.rcompare)
  const selected = versions.at(0)
  if (!selected) throw new Error(`No published historical Node satisfies ${release.node} on ${release.releasedAt}`)
  return selected
}
const downloads = new Map<string, Promise<Buffer>>()
const extractedNodes = new Map<string, Promise<string>>()
async function download(
  url: string,
  hosts: string[],
  options: ProvisionOptions,
  validate?: (bytes: Buffer) => void,
): Promise<Buffer> {
  if (!hosts.includes(new URL(url).hostname) || !url.startsWith('https:'))
    throw new Error(`Nonofficial download origin: ${url}`)
  const key = `${options.cacheDirectory ?? ''}:${url}`
  let pending = downloads.get(key)
  if (!pending) {
    pending = (async () => {
      const cacheFile = options.cacheDirectory ? join(options.cacheDirectory, 'downloads', digest(url)) : undefined
      if (cacheFile) {
        try {
          const cached = await readFile(cacheFile)
          validate?.(cached)
          return cached
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') await rm(cacheFile, { force: true })
        }
      }
      const response = await fetch(url, {
        signal: AbortSignal.timeout(options.timeoutMs ?? 120_000),
        redirect: 'error',
      })
      if (!response.ok) throw new Error(`Download HTTP ${response.status}: ${url}`)
      const bytes = Buffer.from(await response.arrayBuffer())
      validate?.(bytes)
      if (cacheFile) {
        await mkdir(dirname(cacheFile), { recursive: true })
        const temporary = `${cacheFile}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`
        await writeFile(temporary, bytes)
        await rename(temporary, cacheFile)
      }
      return bytes
    })()
    downloads.set(key, pending)
    // Both handlers settle cleanly; failed fetches never poison subsequent attempts.
    pending.then(
      () => {
        downloads.delete(key)
      },
      () => {
        downloads.delete(key)
      },
    )
  }
  const bytes = await pending
  validate?.(bytes)
  return bytes
}
async function extract(bytes: Buffer, directory: string, timeoutMs: number, regularOnly = false): Promise<void> {
  await mkdir(directory, { recursive: true })
  const archive = `${directory}.tgz`
  await writeFile(archive, bytes)
  try {
    const { stdout } = await exec('tar', ['-tzf', archive], {
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: 16 * 1024 * 1024,
    })
    if (stdout.split('\n').some((path) => path.startsWith('/') || path.split('/').includes('..')))
      throw new Error('Unsafe archive path')
    if (regularOnly) {
      if (
        stdout
          .split('\n')
          .filter(Boolean)
          .some((path) => !/^package\/[\w./-]*$/.test(path))
      )
        throw new Error('Unsafe native archive path')
      const listing = await exec('tar', ['-tvzf', archive], { timeout: timeoutMs, killSignal: 'SIGKILL' })
      if (
        listing.stdout
          .split('\n')
          .filter(Boolean)
          .some((entry) => !/^[-d]/.test(entry))
      )
        throw new Error('Unsafe native archive entry: only regular files and directories are allowed')
    }
    await exec('tar', ['-xzf', archive, '-C', directory, '--strip-components=1'], {
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
    })
  } finally {
    await rm(archive, { force: true })
  }
}
async function extractNode(bytes: Buffer, directory: string, checksum: string, timeoutMs: number): Promise<string> {
  let pending = extractedNodes.get(directory)
  if (!pending) {
    pending = (async () => {
      const binary = join(directory, 'bin/node')
      try {
        const stamp = JSON.parse(await readFile(join(directory, '.verified.json'), 'utf8')) as {
          archive: string
          binary: string
        }
        if (stamp.archive === checksum && digest(await readFile(binary)) === stamp.binary) return binary
      } catch {}
      await mkdir(dirname(directory), { recursive: true })
      const staging = await mkdtemp(`${directory}.staging-`)
      try {
        await extract(bytes, staging, timeoutMs)
        const binaryHash = digest(await readFile(join(staging, 'bin/node')))
        await writeFile(join(staging, '.verified.json'), JSON.stringify({ archive: checksum, binary: binaryHash }))
        await rm(directory, { recursive: true, force: true })
        await rename(staging, directory)
      } finally {
        await rm(staging, { recursive: true, force: true })
      }
      return binary
    })()
    extractedNodes.set(directory, pending)
    pending.then(
      () => {
        extractedNodes.delete(directory)
      },
      () => {
        extractedNodes.delete(directory)
      },
    )
  }
  return pending
}
export interface Tool {
  node: string
  nodeVersion: string
  nodeArch: string
  nodeIntegrity: string
  nodeBinarySha256?: string
  cli: string
  version: string
  integrity: string
  url: string
  bootstrap?: BootstrapReceipt
  execution?: 'node' | 'native'
  native?: NativeReceipt
}
export interface NativeReceipt {
  package: string
  version: string
  metadataUrl: string
  url: string
  integrity: string
  binarySha256: string
}
export function isNativeYarnRelease(release: ManagerRelease): boolean {
  return (
    release.runtime === 'native'
    && Boolean(semver.valid(release.version))
    && semver.major(release.version) >= 6
    && release.node === '*'
    && release.sourceUrl === 'https://repo.yarnpkg.com/releases'
    && !release.tarball
    && !release.bundle
    && !release.integrity
  )
}
/** Yarn publishes static musl builds for Linux; macOS artifacts use the host architecture.
 * Missing official packages remain an actionable provisioning failure, never an emulation fallback.
 */
export function nativeYarnPackage(platform: string = process.platform, arch: string = process.arch): string {
  if (!['darwin', 'linux'].includes(platform) || !['x64', 'arm64'].includes(arch))
    throw new Error(
      `Unsupported native Yarn platform ${platform}-${arch}; use a host with an official Yarn platform package`,
    )
  return `@yarnpkg/yarn-${arch === 'arm64' ? 'aarch64' : 'x86_64'}-${platform === 'darwin' ? 'apple-darwin' : 'unknown-linux-musl'}`
}
interface NativeYarnManifest {
  name?: string
  version?: string
  os?: string[]
  cpu?: string[]
  bin?: { yarn?: string }
  dist?: { tarball?: string; integrity?: string }
}
/** Explicit artifact verification can inspect an exact prerelease without admitting it to a maintenance matrix. */
export async function provisionNativeYarn(
  version: string,
  directory: string,
  options: ProvisionOptions = {},
): Promise<{ cli: string; receipt: NativeReceipt }> {
  if (semver.valid(version) !== version || semver.major(version) < 6)
    throw new Error(`Native Yarn requires an exact published version >=6: ${version}`)
  const name = nativeYarnPackage()
  const metadataUrl = `https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`
  const metadata = JSON.parse(
    (await download(metadataUrl, ['registry.npmjs.org'], options)).toString(),
  ) as NativeYarnManifest
  const validManifest = (manifest: NativeYarnManifest): boolean =>
    manifest.name === name
    && manifest.version === version
    && Array.isArray(manifest.os)
    && manifest.os.length === 1
    && manifest.os[0] === process.platform
    && Array.isArray(manifest.cpu)
    && manifest.cpu.length === 1
    && manifest.cpu[0] === process.arch
    && manifest.bin?.yarn === 'yarn'
  if (!validManifest(metadata) || !metadata.dist?.tarball || !metadata.dist.integrity)
    throw new Error(`Invalid official native Yarn package metadata: ${metadataUrl}`)
  const { tarball, integrity } = metadata.dist
  const expectedTarball = `https://registry.npmjs.org/${name}/-/${name.split('/')[1]}-${version}.tgz`
  if (tarball !== expectedTarball) throw new Error(`Unexpected official native Yarn artifact URL: ${tarball}`)
  const bytes = await download(tarball, ['registry.npmjs.org'], options, (value) => verifyIntegrity(value, integrity))
  await mkdir(directory, { recursive: true })
  const staging = await mkdtemp(join(directory, '.native-yarn-'))
  const timeoutMs = options.timeoutMs ?? 60_000
  try {
    await extract(bytes, staging, timeoutMs, true)
    const manifest = JSON.parse(await readFile(join(staging, 'package.json'), 'utf8')) as NativeYarnManifest
    if (!validManifest(manifest)) throw new Error('Native Yarn archive manifest does not match official metadata')
    const cli = join(staging, 'yarn')
    await chmod(cli, 0o755)
    const versionDirectory = await mkdtemp(join(tmpdir(), 'toolchain-version-'))
    try {
      const { stdout } = await exec(cli, ['--version'], {
        cwd: versionDirectory,
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: 4 * 1024 * 1024,
      })
      if (stdout.trim() !== version) throw new Error(`Actual tool version mismatch: ${stdout}`)
    } finally {
      await rm(versionDirectory, { recursive: true, force: true })
    }
    const receipt: NativeReceipt = {
      package: name,
      version,
      metadataUrl,
      url: tarball,
      integrity,
      binarySha256: digest(await readFile(cli)),
    }
    // Preserve each independently verified artifact and its receipt without overwriting prior evidence.
    await writeFile(join(staging, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' })
    return { cli, receipt }
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }
}
async function nativePnpm(
  dependencies: Record<string, string>,
  directory: string,
  options: ProvisionOptions,
): Promise<{ cli: string; receipt: NativeReceipt } | undefined> {
  const report = process.report.getReport() as { header?: { glibcVersionRuntime?: string } }
  const suffix = process.platform === 'linux' && !report.header?.glibcVersionRuntime ? '-musl' : ''
  const name = `@pnpm/exe.${process.platform}-${process.arch}${suffix}`
  const version = dependencies[name]
  if (!version) return undefined
  if (!semver.valid(version)) throw new Error(`Native package must have an exact published version: ${name}@${version}`)
  const metadataUrl = `https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`
  const metadata = JSON.parse((await download(metadataUrl, ['registry.npmjs.org'], options)).toString()) as {
    name?: string
    version?: string
    dist?: { tarball?: string; integrity?: string }
  }
  if (metadata.name !== name || metadata.version !== version || !metadata.dist?.tarball || !metadata.dist.integrity)
    throw new Error(`Invalid official native package metadata: ${metadataUrl}`)
  const { tarball, integrity } = metadata.dist
  const archive = await download(tarball, ['registry.npmjs.org'], options, (bytes) => verifyIntegrity(bytes, integrity))
  const target = join(directory, 'native-package')
  await extract(archive, target, options.timeoutMs ?? 60_000)
  const file = process.platform === 'win32' ? 'pnpm.exe' : 'pnpm'
  const cli = join(directory, `native-${file}`)
  await cp(join(target, file), cli)
  await chmod(cli, 0o755)
  return {
    cli,
    receipt: {
      package: name,
      version,
      metadataUrl,
      url: tarball,
      integrity,
      binarySha256: digest(await readFile(cli)),
    },
  }
}
export async function provision(
  manager: Manager,
  release: ManagerRelease,
  catalog: Catalog,
  directory: string,
  requestedNode?: string,
  options: ProvisionOptions = {},
): Promise<Tool> {
  if (!isStableVersion(release.version))
    throw new Error(`Prerelease versions are excluded: ${manager}@${release.version}`)
  const nativeYarn = manager === 'yarn' && isNativeYarnRelease(release)
  if (release.runtime === 'native' && !nativeYarn)
    throw new Error(`Invalid official native Yarn release descriptor: ${manager}@${release.version}`)
  if (!nativeYarn && ((!release.tarball && !release.bundle) || !release.integrity))
    throw new Error(`Missing official executable artifact/integrity for ${manager}@${release.version}`)
  if (
    requestedNode
    && (!isStableVersion(requestedNode)
      || !catalog.nodes.some((item) => item.version === requestedNode)
      || (release.node && !semver.satisfies(requestedNode, release.node)))
  )
    throw new Error(`Requested Node ${requestedNode} is unpublished or incompatible with ${release.node}`)
  const nodeVersion =
    requestedNode
    ?? (options.historicalNode
      ? selectHistoricalNode(release, catalog)
      : selectNode(
          release.node,
          catalog.nodes.map((item) => item.version),
        ))
  const nodeArch =
    options.nodeArch ?? (process.platform === 'darwin' && semver.major(nodeVersion) < 16 ? 'x64' : process.arch)
  const timeoutMs = options.timeoutMs ?? 60_000
  let node = process.execPath
  let nodeIntegrity = `sha256-${createHash('sha256')
    .update(await readFile(node))
    .digest('base64')}`
  if (nodeVersion !== process.versions.node || nodeArch !== process.arch) {
    if (!['linux', 'darwin'].includes(process.platform)) throw new Error('Node provisioning supports Linux and macOS')
    const filename = `node-v${nodeVersion}-${process.platform}-${nodeArch}.tar.gz`
    const base = `https://nodejs.org/dist/v${nodeVersion}`
    const sums = (await download(`${base}/SHASUMS256.txt`, ['nodejs.org'], options)).toString()
    const checksum = sums
      .split('\n')
      .find((line) => line.trim().split(/\s+/)[1] === filename)
      ?.split(/\s+/)[0]
    if (!checksum) throw new Error(`No official checksum for ${filename}`)
    const bytes = await download(`${base}/${filename}`, ['nodejs.org'], options, (value) => {
      if (digest(value) !== checksum) throw new Error('Node integrity mismatch')
    })
    nodeIntegrity = `sha256-${Buffer.from(checksum, 'hex').toString('base64')}`
    const nodeDirectory = join(
      options.cacheDirectory ?? directory,
      'nodes',
      `node-${nodeVersion}-${process.platform}-${nodeArch}-${checksum}`,
    )
    node = await extractNode(bytes, nodeDirectory, checksum, timeoutMs)
  }
  if (nativeYarn) {
    const native = await provisionNativeYarn(release.version, join(directory, `yarn-${release.version}`), options)
    await verifyRuntime(node, nodeVersion, nodeArch, timeoutMs)
    return {
      node,
      nodeVersion,
      nodeArch,
      nodeIntegrity,
      nodeBinarySha256: digest(await readFile(node)),
      cli: native.cli,
      version: release.version,
      integrity: native.receipt.integrity,
      url: native.receipt.url,
      execution: 'native',
      native: native.receipt,
    }
  }
  const integrity = release.integrity!
  if (release.bundle) {
    const { bundle } = release
    const expectedUrl = `https://raw.githubusercontent.com/yarnpkg/berry/${bundle.commit}/packages/yarnpkg-cli/bin/yarn.js`
    if (manager !== 'yarn' || release.tarball || !/^[a-f\d]{40}$/.test(bundle.commit) || bundle.url !== expectedUrl)
      throw new Error('Yarn bundle requires an immutable official commit URL and no ambiguous tarball')
    const bytes = await download(bundle.url, ['raw.githubusercontent.com'], options, (value) => {
      verifyIntegrity(value, integrity)
      if (value.length !== bundle.size) throw new Error('Yarn bundle size mismatch')
    })
    const toolDirectory = join(directory, `yarn-${release.version}`)
    await mkdir(toolDirectory, { recursive: true })
    const cli = join(toolDirectory, 'yarn.cjs')
    await writeFile(cli, bytes)
    const versionDirectory = await mkdtemp(join(tmpdir(), 'toolchain-version-'))
    try {
      const { stdout } = await exec(node, [cli, '--version'], {
        cwd: versionDirectory,
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, PATH: `${dirname(node)}:${process.env.PATH ?? ''}`, COREPACK_ENABLE_PROJECT_SPEC: '0' },
      })
      if (stdout.trim() !== release.version) throw new Error(`Actual tool version mismatch: ${stdout}`)
      await verifyRuntime(node, nodeVersion, nodeArch, timeoutMs)
    } finally {
      await rm(versionDirectory, { recursive: true, force: true })
    }
    return {
      node,
      nodeVersion,
      nodeArch,
      nodeIntegrity,
      nodeBinarySha256: digest(await readFile(node)),
      cli,
      version: release.version,
      integrity,
      url: bundle.url,
      execution: 'node',
    }
  }
  const bytes = await download(release.tarball!, ['registry.npmjs.org'], options, (value) =>
    verifyIntegrity(value, integrity),
  )
  const toolRoot = join(directory, `${manager}-${release.version}`)
  await rm(toolRoot, { recursive: true, force: true })
  const unpacked = join(toolRoot, 'package')
  await extract(bytes, unpacked, timeoutMs)
  const manifest = JSON.parse(await readFile(join(unpacked, 'package.json'), 'utf8')) as {
    name?: string
    bin?: string | Record<string, string>
    optionalDependencies?: Record<string, string>
  }
  if (!manifest.name || !/^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(manifest.name))
    throw new Error('Missing or unsafe package name')
  const toolDirectory = join(toolRoot, 'node_modules', manifest.name)
  await mkdir(dirname(toolDirectory), { recursive: true })
  await rename(unpacked, toolDirectory)
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[manager]
  if (!bin || bin.startsWith('/') || bin.split('/').includes('..'))
    throw new Error('Missing or unsafe package manager executable')
  let cli = join(toolDirectory, bin)
  const native =
    manager === 'pnpm' && manifest.optionalDependencies
      ? await nativePnpm(manifest.optionalDependencies, toolDirectory, options)
      : undefined
  if (native) cli = native.cli
  let bootstrap: BootstrapReceipt | undefined
  const versionDirectory = await mkdtemp(join(tmpdir(), 'toolchain-version-'))
  const checkVersion = async () => {
    const result = await exec(native ? cli : node, native ? ['--version'] : [cli, '--version'], {
      cwd: versionDirectory,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, PATH: `${dirname(node)}:${process.env.PATH ?? ''}`, COREPACK_ENABLE_PROJECT_SPEC: '0' },
    })
    if (![release.version, `${manager} ${release.version}`, `v${release.version}`].includes(result.stdout.trim()))
      throw new Error(`Actual tool version mismatch: ${result.stdout || '<empty stdout>'}\n${result.stderr}`)
    return result
  }
  try {
    try {
      await checkVersion()
    } catch (error) {
      const details = error as Error & { stderr?: string }
      if (
        native
        || !options.bootstrapDependencies
        || !/Cannot find module|Cannot find package|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND/.test(
          `${details.message} ${details.stderr ?? ''}`,
        )
      )
        throw error
      if (!options.cacheDirectory)
        throw new Error('Dependency bootstrap requires a persistent cacheDirectory', { cause: error })
      const installed = await bootstrapTool(toolDirectory, integrity, options.cacheDirectory, timeoutMs)
      bootstrap = installed.receipt
      await rm(toolDirectory, { recursive: true, force: true })
      await cp(installed.directory, toolDirectory, { recursive: true, verbatimSymlinks: true })
      cli = join(toolDirectory, bin)
      await checkVersion()
    }
  } finally {
    await rm(versionDirectory, { recursive: true, force: true })
  }
  await verifyRuntime(node, nodeVersion, nodeArch, timeoutMs)
  return {
    node,
    nodeVersion,
    nodeArch,
    nodeIntegrity,
    nodeBinarySha256: digest(await readFile(node)),
    cli,
    version: release.version,
    integrity,
    url: release.tarball!,
    bootstrap,
    execution: native ? 'native' : 'node',
    native: native?.receipt,
  }
}
async function verifyRuntime(node: string, nodeVersion: string, nodeArch: string, timeoutMs: number): Promise<void> {
  const actualNode = (await exec(node, ['--version'], { timeout: timeoutMs, killSignal: 'SIGKILL' })).stdout
    .trim()
    .replace(/^v/, '')
  if (actualNode !== nodeVersion) throw new Error('Actual Node version mismatch')
  const actualArch = (
    await exec(node, ['-p', 'process.arch'], { timeout: timeoutMs, killSignal: 'SIGKILL' })
  ).stdout.trim()
  if (actualArch !== nodeArch) throw new Error('Actual Node architecture mismatch')
}
