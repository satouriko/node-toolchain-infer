import { execFile } from 'node:child_process'
import { readFile, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'

import semver from 'semver'

import { optionalObject } from './validation.js'
import { createWarning } from './warnings.js'

import type { Catalog, Runtime, Warning } from './types.js'

const execute = promisify(execFile)
export interface RuntimeOptions {
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
  if (localManagers)
    await Promise.all(
      (['pnpm', 'yarn'] as const).map(async (manager) => {
        try {
          const { stdout } = await execute(process.platform === 'win32' ? `${manager}.cmd` : manager, ['--version'], {
            cwd: binaryDirectory,
            env: { ...env, COREPACK_ENABLE_NETWORK: '0', COREPACK_ENABLE_PROJECT_SPEC: '0' },
            timeout: 5000,
            maxBuffer: 64 * 1024,
            windowsHide: true,
          })
          const version = semver.valid(stdout.trim())
          if (version) runtime[manager] = version
        } catch {
          /* Missing optional local commands simply provide no candidate. */
        }
      }),
    )
  return { runtime, warnings }
}
