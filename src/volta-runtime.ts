import { constants } from 'node:fs'
import { access, readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'

import semver from 'semver'

import { errorCode, optionalObject } from './validation.js'
import { readVoltaConfig, type VoltaSettings } from './volta-config.js'

import type { Manager } from './types.js'

function within(root: string, path: string) {
  const part = relative(root, path)
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`))
}

export function environmentPath(env: Record<string, string | undefined>) {
  const key =
    process.platform === 'win32'
      ? Object.keys(env)
          .sort()
          .find((name) => name.toLowerCase() === 'path')
      : 'PATH'
  return (key ? env[key] : undefined) ?? ''
}

async function commandPath(manager: string, cwd: string, env: Record<string, string | undefined>) {
  const paths = environmentPath(env).split(delimiter)
  const suffixes = process.platform === 'win32' ? ['.exe', '.cmd', '.bat'] : ['']
  for (const directory of paths)
    for (const suffix of suffixes) {
      const path = resolve(cwd, directory, `${manager}${suffix}`)
      try {
        await access(path, constants.X_OK)
        if (!(await stat(path)).isFile()) continue
        return { path, real: await realpath(path) }
      } catch {
        // Follow PATH order, ignoring entries that cannot be executed.
      }
    }
  return null
}

async function projectSettings(cwd: string): Promise<VoltaSettings> {
  for (let directory = resolve(cwd); ; directory = dirname(directory)) {
    const path = join(directory, 'package.json')
    try {
      if (basename(dirname(directory)) !== 'node_modules') {
        const manifest = optionalObject(JSON.parse(await readFile(path, 'utf8')))
        return (await readVoltaConfig(path, manifest)).settings
      }
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') return {}
    }
    if (dirname(directory) === directory) return {}
  }
}

async function json(path: string) {
  try {
    return optionalObject(JSON.parse(await readFile(path, 'utf8')))
  } catch {
    return {}
  }
}

/** Resolve only already-installed Volta tools. Never execute a Volta shim or `volta which`. */
export async function detectVoltaManagers({
  cwd,
  node,
  env,
  probe,
}: {
  cwd: string
  node: string
  env: Record<string, string | undefined>
  probe: (entrypoint: string) => Promise<string | null>
}) {
  const configuredHome = resolve(
    env.VOLTA_HOME
      ?? (process.platform === 'win32'
        ? join(env.LOCALAPPDATA ?? join(env.USERPROFILE ?? homedir(), 'AppData/Local'), 'Volta')
        : join(env.HOME ?? homedir(), '.volta')),
  )
  const home = await realpath(configuredHome).catch(() => configuredHome)
  const installCommand = process.platform === 'win32' ? await commandPath('volta', cwd, env) : null
  const install = env.VOLTA_INSTALL_DIR ?? (installCommand ? dirname(installCommand.real) : undefined)
  const handled = new Set<Manager>()
  const versions: Partial<Record<Manager, string>> = {}
  let bypassPath: string | undefined
  if (env.VOLTA_BYPASS !== undefined) {
    const shims = [join(home, 'bin')]
    if (process.platform === 'win32' && install) shims.push(await realpath(install).catch(() => resolve(install)))
    const directories = await Promise.all(
      environmentPath(env)
        .split(delimiter)
        .map(async (directory) => ({
          directory,
          real: await realpath(resolve(cwd, directory)).catch(() => resolve(cwd, directory)),
        })),
    )
    bypassPath = directories
      .filter(({ real }) => !shims.includes(real))
      .map(({ directory }) => directory)
      .join(delimiter)
    return { handled, versions, bypassPath }
  }
  for (const manager of ['npm', 'pnpm', 'yarn'] as const) {
    const command = await commandPath(manager, cwd, env)
    if (
      command
      && (within(join(configuredHome, 'bin'), command.path)
        || within(join(home, 'bin'), command.real)
        || within(join(home, 'tools/image', manager), command.real)
        || (manager === 'pnpm' && within(join(home, 'tools/image/packages/pnpm'), command.real))
        || (manager === 'npm' && within(join(home, 'tools/image/node'), command.real))
        || (process.platform === 'win32' && install && dirname(command.real) === resolve(install))
        || /^volta-shim(?:\.exe)?$/i.test(basename(command.real)))
    )
      handled.add(manager)
  }
  if (!handled.size) return { handled, versions, bypassPath }
  const project = await projectSettings(cwd)
  const defaults = await json(join(home, 'tools/user/platform.json'))
  async function cachedVersion(root: string, manager: Manager, value: unknown) {
    if (typeof value !== 'string' || semver.valid(value) !== value) return null
    try {
      const manifest = await json(join(root, 'package.json'))
      if (manifest.name !== manager || manifest.version !== value) return null
      const requirement = optionalObject(manifest.engines).node
      if (
        requirement !== undefined
        && (typeof requirement !== 'string'
          || !semver.validRange(requirement)
          || !semver.satisfies(node, requirement, { includePrerelease: true }))
      )
        return null
      const bin = typeof manifest.bin === 'string' ? manifest.bin : optionalObject(manifest.bin)[manager]
      if (typeof bin !== 'string') return null
      const entrypoint = await realpath(resolve(root, bin))
      if (!within(await realpath(root), entrypoint)) return null
      return (await probe(entrypoint)) === value ? value : null
    } catch {
      // Incomplete or unusable caches are not installed runtime candidates.
      return null
    }
  }
  for (const manager of handled) {
    if (manager === 'pnpm' && env.VOLTA_FEATURE_PNPM === undefined) {
      const config = await json(join(home, 'tools/user/bins/pnpm.json'))
      if (config.name !== 'pnpm' || config.package !== 'pnpm') continue
      let prefix: string
      if (config.manager === 'Pnpm') prefix = '5'
      else if (config.manager === 'Yarn') prefix = 'lib'
      else if (config.manager === 'Npm') prefix = process.platform === 'win32' ? '' : 'lib'
      else continue
      const version = await cachedVersion(
        join(home, 'tools/image/packages/pnpm', prefix, 'node_modules/pnpm'),
        manager,
        config.version,
      )
      if (version) versions.pnpm = version
      continue
    }
    // Volta projects with a Node pin use that Node's bundled npm unless npm is pinned too.
    const defaultNpm = !project.node || project.npm ? optionalObject(defaults.node).npm : undefined
    const candidates = [project[manager]?.value, manager === 'npm' ? defaultNpm : defaults[manager]]
    for (const value of new Set(candidates)) {
      if (typeof value !== 'string' || semver.valid(value) !== value) continue
      const version = await cachedVersion(join(home, 'tools/image', manager, value), manager, value)
      if (!version) continue
      versions[manager] = version
      break
    }
  }
  return { handled, versions, bypassPath }
}
