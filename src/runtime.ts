import { execFile } from 'node:child_process'
import { readFile, realpath } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'

import semver from 'semver'

import { optionalObject } from './validation.js'
import { detectVoltaManagers, environmentPath } from './volta-runtime.js'
import { createWarning } from './warnings.js'

import type { Catalog, Runtime, Warning } from './types.js'

const execute = promisify(execFile)
export interface RuntimeOptions {
  cwd?: string
  execPath?: string
  nodeVersion?: string
  catalog?: Catalog
  env?: Record<string, string | undefined>
  localManagers?: boolean
}
export interface RuntimeDetection {
  runtime: Runtime
  warnings: Warning[]
}
export async function detectRuntime({
  cwd = process.cwd(),
  execPath = process.execPath,
  nodeVersion = process.versions.node,
  catalog,
  env = process.env,
  localManagers = true,
}: RuntimeOptions = {}): Promise<RuntimeDetection> {
  const node = semver.valid(nodeVersion)
  if (!node) throw new Error(`Invalid running Node version: ${nodeVersion}`)
  const executable = await realpath(execPath)
  const binaryDirectory = dirname(executable)
  const packages = [
    join(binaryDirectory, '../lib/node_modules/npm/package.json'),
    join(binaryDirectory, 'node_modules/npm/package.json'),
  ]
  let npm: string | null = null
  for (const path of packages) {
    try {
      const manifest = optionalObject(JSON.parse(await readFile(path, 'utf8')))
      if (manifest.name === 'npm' && typeof manifest.version === 'string') npm = semver.valid(manifest.version)
      if (npm) break
    } catch {
      /* A Node distribution may put npm in the next known location. */
    }
  }
  const warnings: Warning[] = []
  if (!npm) {
    npm = catalog?.nodes.find((record) => record.version === node)?.npm ?? null
    if (npm) warnings.push(createWarning('npm-from-release-metadata', {}))
  }
  if (!npm)
    throw new Error(
      `Cannot determine npm bound to Node ${node}; provide runtime.npm or official metadata for this Node release.`,
    )
  const runtime: Runtime = { node, npm }
  if (localManagers) {
    const directEnv = Object.fromEntries(
      Object.entries(env).filter(([key]) => process.platform !== 'win32' || key.toLowerCase() !== 'path'),
    )
    const volta = await detectVoltaManagers({
      cwd,
      node,
      env,
      probe: async (entrypoint) => {
        const script = /\.[cm]?js$/i.test(entrypoint)
        const { stdout } = await execute(
          script ? executable : entrypoint,
          script ? [entrypoint, '--version'] : ['--version'],
          {
            cwd: binaryDirectory,
            env: {
              ...directEnv,
              PATH: [binaryDirectory, environmentPath(env)].filter(Boolean).join(delimiter),
              COREPACK_ENABLE_NETWORK: '0',
              COREPACK_ENABLE_AUTO_PIN: '0',
              COREPACK_ENABLE_PROJECT_SPEC: '0',
              YARN_IGNORE_PATH: '1',
            },
            timeout: 5000,
            maxBuffer: 64 * 1024,
            windowsHide: true,
          },
        )
        return semver.valid(stdout.trim())
      },
    })
    if (volta.versions.npm) runtime.localNpm = volta.versions.npm
    const probeEnv = volta.bypassPath === undefined ? env : { ...directEnv, PATH: volta.bypassPath }
    await Promise.all(
      (['pnpm', 'yarn'] as const).map(async (manager) => {
        if (volta.handled.has(manager)) {
          if (volta.versions[manager]) runtime[manager] = volta.versions[manager]
          return
        }
        for (const projectSpec of [true, false]) {
          try {
            const { stdout } = await execute(process.platform === 'win32' ? `${manager}.cmd` : manager, ['--version'], {
              cwd: projectSpec ? cwd : binaryDirectory,
              env: {
                ...probeEnv,
                COREPACK_ENABLE_NETWORK: '0',
                COREPACK_ENABLE_AUTO_PIN: '0',
                COREPACK_ENABLE_PROJECT_SPEC: projectSpec ? '1' : '0',
              },
              timeout: 5000,
              maxBuffer: 64 * 1024,
              windowsHide: true,
            })
            const version = semver.valid(stdout.trim())
            if (version) {
              runtime[manager] = version
              break
            }
          } catch {
            /* An uncached project version may still have a usable machine default. */
          }
        }
      }),
    )
  }
  return { runtime, warnings }
}
