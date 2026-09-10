import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'

import { digest } from './model.js'

import type { Buffer } from 'node:buffer'

const exec = promisify(execFile)
export interface BootstrapReceipt {
  protocol: 1
  node: string
  npmVersion: string
  npmCliHash: string
  command: string[]
  lockfilePath: string
  lockfileSha256: string
  logPath: string
  installedTreeSha256?: string
  manifestPreparation?: {
    original: { content: string; sha256: string }
    installation: { content: string; sha256: string }
  }
}
interface PreparedTool {
  directory: string
  receipt: BootstrapReceipt
}
/** Keep the dependency graph and installer output usable after the CI cache is gone. */
export async function preserveBootstrap(receipt: BootstrapReceipt, evidence: string): Promise<BootstrapReceipt> {
  const lock = await readFile(receipt.lockfilePath)
  if (digest(lock) !== receipt.lockfileSha256) throw new Error('Bootstrap dependency lock digest mismatch')
  const log = await readFile(receipt.logPath)
  const prefix = `bootstrap/${receipt.lockfileSha256}`
  const lockfilePath = `${prefix}/package-lock.json`
  const logPath = `${prefix}/${digest(log)}.log`
  await mkdir(join(evidence, prefix), { recursive: true })
  await writeFile(join(evidence, lockfilePath), lock)
  await writeFile(join(evidence, logPath), log)
  return { ...receipt, lockfilePath, logPath }
}
const prepared = new Map<string, Promise<PreparedTool>>()
async function treeHash(directory: string): Promise<string> {
  const root = resolve(directory)
  const entries: Array<[string, string]> = []
  async function visit(relative: string): Promise<void> {
    for (const entry of (await readdir(join(directory, relative), { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(relative, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isSymbolicLink()) {
        const target = await readlink(join(directory, path))
        const absolute = resolve(directory, relative, target)
        if (absolute !== root && !absolute.startsWith(`${root}${sep}`))
          throw new Error(`Bootstrap contains an external symlink: ${path}`)
        entries.push([path, `link:${target}`])
      } else if (entry.isFile()) entries.push([path, digest(await readFile(join(directory, path)))])
      else throw new Error(`Unsupported bootstrap file: ${path}`)
    }
  }
  await visit('')
  return digest(JSON.stringify(entries))
}
export async function bootstrapTool(
  source: string,
  toolIntegrity: string,
  cacheDirectory: string,
  timeoutMs: number,
): Promise<PreparedTool> {
  const executable = await realpath(process.execPath)
  const binaryDirectory = dirname(executable)
  let npmDirectory: string | undefined
  let npmVersion: string | undefined
  for (const candidate of [
    join(binaryDirectory, '../lib/node_modules/npm'),
    join(binaryDirectory, 'node_modules/npm'),
  ]) {
    try {
      const manifest = JSON.parse(await readFile(join(candidate, 'package.json'), 'utf8')) as {
        name?: string
        version?: string
      }
      if (manifest.name === 'npm' && manifest.version) {
        npmDirectory = candidate
        npmVersion = manifest.version
        break
      }
    } catch {}
  }
  if (!npmDirectory || !npmVersion) throw new Error('Cannot locate the current Node-bound npm for dependency bootstrap')
  const npmCli = join(npmDirectory, 'bin/npm-cli.js')
  const npmCliHash = digest(await readFile(npmCli))
  const key = digest(
    JSON.stringify({
      protocol: 1,
      toolIntegrity,
      node: process.versions.node,
      npmVersion,
      npmCliHash,
      manifestPreparation: 'omit-tool-development-dependencies-v1',
      platform: process.platform,
      arch: process.arch,
    }),
  )
  const target = join(cacheDirectory, 'prepared', key)
  let pending = prepared.get(target)
  if (!pending) {
    pending = (async () => {
      const directory = join(target, 'tool')
      let previousLock: Buffer | undefined
      try {
        const receipt = JSON.parse(await readFile(join(target, 'receipt.json'), 'utf8')) as BootstrapReceipt
        const lock = await readFile(receipt.lockfilePath)
        if (digest(lock) === receipt.lockfileSha256) previousLock = lock
        if (
          previousLock
          && digest(await readFile(join(directory, 'package-lock.json'))) === receipt.lockfileSha256
          && receipt.installedTreeSha256 === (await treeHash(directory))
        )
          return { directory, receipt }
      } catch {}
      await mkdir(target, { recursive: true })
      const attempt = await mkdtemp(join(target, 'attempt-'))
      const isolated = join(attempt, 'tool')
      await cp(source, isolated, { recursive: true, verbatimSymlinks: true })
      const manifestPath = join(isolated, 'package.json')
      const originalManifest = await readFile(manifestPath, 'utf8')
      const manifest = JSON.parse(originalManifest) as { devDependencies?: unknown }
      // npm still resolves omitted dev dependencies when the tool itself is the project root.
      // Prepare only its runtime graph, then restore the exact published manifest below.
      delete manifest.devDependencies
      const installationManifest = `${JSON.stringify(manifest, null, 2)}\n`
      await writeFile(manifestPath, installationManifest)
      if (previousLock) await writeFile(join(isolated, 'package-lock.json'), previousLock)
      const command = [
        executable,
        npmCli,
        previousLock ? 'ci' : 'install',
        '--global=false',
        '--ignore-scripts',
        '--omit=dev',
        '--no-audit',
        '--no-fund',
        '--registry=https://registry.npmjs.org',
      ]
      const logPath = join(attempt, 'bootstrap.log')
      try {
        const result = await exec(executable, command.slice(1), {
          cwd: isolated,
          timeout: timeoutMs,
          killSignal: 'SIGKILL',
          maxBuffer: 16 * 1024 * 1024,
          env: {
            ...process.env,
            PATH: `${binaryDirectory}:${process.env.PATH ?? ''}`,
            npm_config_cache: join(cacheDirectory, 'npm-cache'),
            npm_config_registry: 'https://registry.npmjs.org',
            npm_config_userconfig: process.platform === 'win32' ? 'NUL' : '/dev/null',
          },
        })
        await writeFile(logPath, `${command.join(' ')}\n${result.stdout}${result.stderr}`)
      } catch (error) {
        const details = error as Error & { stdout?: string; stderr?: string }
        await writeFile(
          logPath,
          `${command.join(' ')}\n${details.stdout ?? ''}${details.stderr ?? ''}\n${String(error)}`,
        )
        throw new Error(`Dependency bootstrap incomplete; log: ${logPath}`, { cause: error })
      }
      const lock = await readFile(join(isolated, 'package-lock.json'))
      const lockfileSha256 = digest(lock)
      const evidence = join(cacheDirectory, 'bootstrap', key, lockfileSha256)
      await mkdir(evidence, { recursive: true })
      const lockfilePath = join(evidence, 'package-lock.json')
      await writeFile(lockfilePath, lock)
      const savedLogPath = join(evidence, `${digest(await readFile(logPath))}.log`)
      await cp(logPath, savedLogPath)
      await writeFile(manifestPath, originalManifest)
      const receipt: BootstrapReceipt = {
        protocol: 1,
        node: process.versions.node,
        npmVersion,
        npmCliHash,
        command,
        lockfilePath,
        lockfileSha256,
        logPath: savedLogPath,
        installedTreeSha256: await treeHash(isolated),
        manifestPreparation: {
          original: { content: originalManifest, sha256: digest(originalManifest) },
          installation: { content: installationManifest, sha256: digest(installationManifest) },
        },
      }
      await rm(directory, { recursive: true, force: true })
      await rename(isolated, directory)
      await writeFile(join(target, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`)
      await rm(attempt, { recursive: true, force: true })
      return { directory, receipt }
    })()
    prepared.set(target, pending)
    pending.then(
      () => {
        prepared.delete(target)
      },
      () => {
        prepared.delete(target)
      },
    )
  }
  return pending
}
