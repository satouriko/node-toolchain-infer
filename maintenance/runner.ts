import { execFile, spawn } from 'node:child_process'
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'

import semver from 'semver'
import { parse } from 'yaml'

import { readYarnLock } from '../src/yarn-lock.js'

import {
  classify,
  digest,
  type Fixture,
  FROZEN_LOCKFILES,
  FROZEN_PROTOCOL,
  frozenControlAccepted,
  type Observation,
} from './model.js'

import type { Tool } from './provision.js'
import type { CompatibilityRule, Manager } from '../src/types.js'

const exec = promisify(execFile)

export function frozenArgs(manager: Manager, version: string): string[] {
  if (manager === 'npm') return ['ci', '--ignore-scripts', '--no-audit', '--no-fund']
  // The official 3.0.0-alpha.3 CLI renamed this flag; alpha.2 and older use shrinkwrap.
  if (manager === 'pnpm')
    return [
      'install',
      semver.lt(version, '3.0.0-alpha.3') ? '--frozen-shrinkwrap' : '--frozen-lockfile',
      '--ignore-scripts',
    ]
  return semver.major(version) < 2
    ? ['install', '--frozen-lockfile', '--ignore-scripts', '--non-interactive']
    : ['install', '--immutable']
}
export class FormatDetectionError extends Error {
  constructor(manager: Manager, cause: unknown) {
    super(`Unable to parse ${manager} lock format: ${String(cause)}`, { cause })
    this.name = 'FormatDetectionError'
  }
}
export function detectFormat(manager: Manager, content: string, file?: string): CompatibilityRule['match'] {
  try {
    return parseFormat(manager, content, file)
  } catch (error) {
    throw new FormatDetectionError(manager, error)
  }
}
function parseFormat(manager: Manager, content: string, file?: string): CompatibilityRule['match'] {
  if (manager === 'npm') {
    const value: unknown = (JSON.parse(content) as { lockfileVersion?: unknown }).lockfileVersion
    if (typeof value !== 'number') throw new Error('Unknown npm lock format')
    return file ? { format: value, file } : { format: value }
  }
  if (manager === 'yarn') {
    const lock = readYarnLock(content)
    if (lock.error) throw lock.error
    if (lock.format === undefined) throw new Error('Unknown yarn lock format')
    return {
      format: lock.format,
      classic: lock.family === 'classic',
      ...(lock.family === 'zpm' ? { features: { yarnFamily: 'zpm' } } : {}),
    }
  }
  const document = parse(content) as {
    lockfileVersion?: unknown
    shrinkwrapVersion?: unknown
    importers?: unknown
  } | null
  if (file === 'shrinkwrap.yaml') {
    const value = document?.shrinkwrapVersion
    if (typeof value !== 'string' && typeof value !== 'number') throw new Error('Unknown legacy pnpm lock format')
    return { format: String(value), file, features: { sharedWorkspace: document?.importers !== undefined } }
  }
  const value = document?.lockfileVersion
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error(`Unknown ${manager} lock format`)
  return { format: String(value) }
}
export async function execute(
  tool: Tool,
  args: string[],
  cwd: string,
  environment: Record<string, string> = {},
): Promise<{ exitCode: number | null; output: string }> {
  return new Promise((resolve) => {
    let output = ''
    const child = spawn(
      tool.execution === 'native' ? tool.cli : tool.node,
      tool.execution === 'native' ? args : [tool.cli, ...args],
      {
        cwd,
        env: {
          ...process.env,
          PATH: `${dirname(tool.node)}:${process.env.PATH ?? ''}`,
          CI: '1',
          COREPACK_ENABLE_PROJECT_SPEC: '0',
          YARN_ENABLE_SCRIPTS: 'false',
          // Early Yarn 2 prereleases reject this later setting before installing anything.
          YARN_ENABLE_TELEMETRY: semver.major(tool.version) >= 3 ? '0' : undefined,
          npm_config_registry: 'https://registry.npmjs.org',
          npm_config_fetch_retries: '0',
          npm_config_fetch_timeout: '15000',
          npm_config_userconfig: join(cwd, '.npm-userconfig'),
          npm_config_globalconfig: join(cwd, '.npm-globalconfig'),
          npm_config_cache: join(cwd, '.npm-cache'),
          npm_config_store_dir: join(cwd, '.pnpm-store'),
          npm_config_store: join(cwd, '.pnpm-store'),
          npm_config_store_path: join(cwd, '.pnpm-store'),
          pnpm_store_path: join(cwd, '.pnpm-store'),
          YARN_CACHE_FOLDER: join(cwd, '.yarn-cache'),
          YARN_GLOBAL_FOLDER: join(cwd, '.yarn-global'),
          YARN_ENABLE_GLOBAL_CACHE: 'false',
          PNPM_HOME: join(cwd, '.pnpm-home'),
          ...environment,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    const timeout = setTimeout(() => {
      output += '\nETIMEDOUT: maintenance command exceeded 180 seconds'
      child.kill('SIGKILL')
    }, 180_000)
    child.stdout.on('data', (chunk) => {
      output += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      output += String(chunk)
    })
    child.on('error', (error) => {
      output += String(error)
    })
    child.on('close', (exitCode) => {
      clearTimeout(timeout)
      resolve({ exitCode, output })
    })
  })
}
export async function hashes(directory: string, files: string[]): Promise<Record<string, string>> {
  const output: Record<string, string> = {}
  for (const file of [...files].sort()) {
    try {
      output[file] = digest(await readFile(join(directory, file)))
    } catch {
      output[file] = '<missing>'
    }
  }
  return output
}
export async function fixtureFiles(directory: string): Promise<string[]> {
  const files: string[] = []
  async function visit(relative: string): Promise<void> {
    for (const item of await readdir(join(directory, relative), { withFileTypes: true })) {
      const path = join(relative, item.name)
      if (item.isDirectory()) await visit(path)
      else if (item.isFile() && item.name !== 'receipt.json' && item.name !== 'generation.log') files.push(path)
    }
  }
  await visit('')
  return files.sort()
}
export async function fixtureEnvironment(fixture: Fixture, source: string): Promise<Record<string, string>> {
  const environment: Record<string, string> = {}
  if (fixture.manager !== 'pnpm') return environment
  // Format compatibility requires the same settings as the lock's author.
  // Different manager defaults must not become a false format-version boundary.
  const lock = parse(await readFile(join(source, fixture.lock), 'utf8')) as {
    settings?: Record<string, unknown>
  } | null
  for (const [setting, key] of [
    ['autoInstallPeers', 'npm_config_auto_install_peers'],
    ['excludeLinksFromLockfile', 'npm_config_exclude_links_from_lockfile'],
  ]) {
    const value = lock?.settings?.[setting]
    if (typeof value === 'boolean') environment[key] = String(value)
  }
  return environment
}
export function sameEnvironment(a: Observation['environment'], b: Observation['environment']): boolean {
  const ordered = (value: Observation['environment']) =>
    JSON.stringify(Object.entries(value ?? {}).sort(([left], [right]) => left.localeCompare(right)))
  return ordered(a) === ordered(b)
}
export async function runFixture(
  fixture: Fixture,
  tool: Tool,
  fixtureRoot: string,
  work: string,
  receipts: string,
): Promise<Observation> {
  await rm(work, { recursive: true, force: true })
  await mkdir(work, { recursive: true })
  const source = join(fixtureRoot, fixture.directory)
  const files = await fixtureFiles(source)
  for (const file of files) {
    await mkdir(dirname(join(work, file)), { recursive: true })
    await cp(join(source, file), join(work, file))
  }
  const inputHashes = await hashes(work, files)
  const fixtureHash = digest(JSON.stringify(inputHashes))
  const observedFiles = [...new Set([...files, ...FROZEN_LOCKFILES])]
  const beforeHashes = await hashes(work, observedFiles)
  const command = frozenArgs(fixture.manager, tool.version)
  const environment = await fixtureEnvironment(fixture, work)
  const recordedEnvironment = Object.keys(environment).length ? environment : undefined
  const result = await execute(tool, command, work, environment)
  if (fixture.manager === 'npm' && result.exitCode !== 0) {
    // npm often prints only the error message on stderr and writes the causal stack into its local cache.
    const debugDirectory = join(work, '.npm-cache/_logs')
    try {
      for (const name of (await readdir(debugDirectory)).filter((filename) => filename.endsWith('.log')).sort())
        result.output += `\n[npm debug: ${name}]\n${await readFile(join(debugDirectory, name), 'utf8')}`
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        result.output += `\nUnable to read npm debug logs: ${String(error)}`
    }
  }
  const installed: Record<string, string> = {}
  for (const name of Object.keys(fixture.dependencies)) {
    try {
      installed[name] = (
        JSON.parse(await readFile(join(work, 'node_modules', name, 'package.json'), 'utf8')) as { version: string }
      ).version
    } catch {
      installed[name] = '<missing>'
    }
  }
  let semanticMethod: 'node-modules' | 'pnp' = 'node-modules'
  let verificationFailure = false
  if (fixture.manager === 'yarn' && result.exitCode === 0 && Object.values(installed).includes('<missing>')) {
    for (const file of ['.pnp.cjs', '.pnp.js']) {
      try {
        await readFile(join(work, file))
      } catch {
        continue
      }
      semanticMethod = 'pnp'
      const code =
        'const out = {}; for (const name of JSON.parse(process.argv[1])) out[name] = require(name + "/package.json").version; console.log("NTI_DEPENDENCIES " + JSON.stringify(out));'
      const args = ['--require', join(work, file), '--eval', code, JSON.stringify(Object.keys(fixture.dependencies))]
      try {
        const checked = await exec(tool.node, args, { cwd: work, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 })
        result.output += `\n[PnP dependency verification] ${tool.node} ${args.join(' ')}\n${checked.stdout}${checked.stderr}`
        const line = checked.stdout.split('\n').find((item) => item.startsWith('NTI_DEPENDENCIES '))
        if (!line) throw new Error('No dependency manifest verification result')
        const actual = JSON.parse(line.slice('NTI_DEPENDENCIES '.length)) as Record<string, unknown>
        for (const name of Object.keys(fixture.dependencies))
          installed[name] = typeof actual[name] === 'string' ? actual[name] : '<missing>'
      } catch (error) {
        verificationFailure = true
        const details = error as Error & { stdout?: string; stderr?: string }
        result.output += `\nPnP dependency verification incomplete: ${String(error)}\n${details.stdout ?? ''}${details.stderr ?? ''}`
      }
      break
    }
  }
  const afterHashes = await hashes(work, observedFiles)
  const semantic = Object.entries(fixture.dependencies).every(([name, version]) => installed[name] === version)
  let status = verificationFailure
    ? 'inconclusive'
    : classify({
        ...result,
        manager: fixture.manager,
        command,
        before: beforeHashes,
        after: afterHashes,
        semantic,
      })
  let frozenControl: Observation | undefined
  if (status === 'pass' && fixture.controlDependencies) {
    const controlSource = `${work}-control-source`
    const controlWork = `${work}-control-project`
    try {
      await rm(controlSource, { recursive: true, force: true })
      await mkdir(controlSource, { recursive: true })
      for (const file of files) {
        await mkdir(dirname(join(controlSource, file)), { recursive: true })
        await cp(join(source, file), join(controlSource, file))
      }
      const manifest = JSON.parse(await readFile(join(controlSource, 'package.json'), 'utf8')) as Record<
        string,
        unknown
      >
      const dependencies = { ...fixture.dependencies, ...fixture.controlDependencies }
      manifest.dependencies = dependencies
      const manifestText = `${JSON.stringify(manifest, null, 2)}\n`
      await writeFile(join(controlSource, 'package.json'), manifestText)
      frozenControl = await runFixture(
        {
          ...fixture,
          id: `${fixture.id}:frozen-control`,
          directory: '.',
          dependencies,
          controlDependencies: undefined,
        },
        tool,
        controlSource,
        controlWork,
        receipts,
      )
      result.output += `\n[Contradictory manifest control]\n${manifestText}Result: ${frozenControl.status}; ${frozenControl.logPath}\n`
      if (!frozenControlAccepted(fixture, frozenControl)) {
        status = 'inconclusive'
        result.output +=
          'Frozen enforcement was not established: the control must reject the changed manifest or retain the original locked versions without changing files.\n'
      }
    } catch (error) {
      status = 'inconclusive'
      result.output += `\nFrozen enforcement control incomplete: ${String(error)}\n`
    } finally {
      await rm(controlSource, { recursive: true, force: true })
      await rm(controlWork, { recursive: true, force: true })
    }
  }
  const key = digest(
    JSON.stringify({
      protocol: FROZEN_PROTOCOL,
      manager: fixture.manager,
      version: tool.version,
      toolIntegrity: tool.integrity,
      nativeIntegrity: tool.native?.integrity,
      bootstrapLockSha256: tool.bootstrap?.lockfileSha256,
      node: tool.nodeVersion,
      nodeIntegrity: tool.nodeIntegrity,
      nodeArch: tool.nodeArch,
      platform: process.platform,
      arch: process.arch,
      fixtureHash,
      command,
      environment: recordedEnvironment,
    }),
  )
  const createdAt = new Date().toISOString()
  const id = `${key}-${digest(createdAt).slice(0, 12)}`
  const logPath = `logs/${id}.log`
  await mkdir(join(receipts, 'logs'), { recursive: true })
  await writeFile(
    join(receipts, logPath),
    `${tool.execution === 'native' ? tool.cli : `${tool.node} ${tool.cli}`} ${command.join(' ')}\n${recordedEnvironment ? `[Fixture environment] ${JSON.stringify(environment)}\n` : ''}${result.output}`,
  )
  return {
    protocol: FROZEN_PROTOCOL,
    inputHashes,
    id,
    key,
    manager: fixture.manager,
    version: tool.version,
    actualVersion: tool.version,
    node: tool.nodeVersion,
    nodeIntegrity: tool.nodeIntegrity,
    nodeArch: tool.nodeArch,
    toolIntegrity: tool.integrity,
    native: tool.native,
    bootstrap: tool.bootstrap,
    toolUrl: tool.url,
    platform: process.platform,
    arch: process.arch,
    fixtureId: fixture.id,
    fixtureHash,
    command,
    environment: recordedEnvironment,
    status,
    exitCode: result.exitCode,
    beforeHashes,
    afterHashes,
    installed,
    requestedDependencies: fixture.dependencies,
    semantic,
    semanticMethod,
    frozenControl,
    logPath,
    createdAt,
  }
}
