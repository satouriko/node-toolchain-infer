import { readFile, realpath, stat } from 'node:fs/promises'
import { dirname, join, resolve as resolvePath } from 'node:path'
import process from 'node:process'

import { parse as parseYaml } from 'yaml'

import { createSource } from './sources.js'
import { declarationText, errorCode, errorMessage, object, optionalObject } from './validation.js'
import { createWarning } from './warnings.js'
import { readYarnLock } from './yarn-lock.js'

import type { Collection, CollectOptions, Source, Warning } from './types.js'

const files = [
  'package.json',
  'pnpm-lock.yaml',
  'shrinkwrap.yaml',
  'yarn.lock',
  'npm-shrinkwrap.json',
  'package-lock.json',
  '.node-version',
  '.nvmrc',
  '.tool-versions',
]
const array = (value: unknown): unknown[] => {
  if (Array.isArray(value)) return value
  return value ? [value] : []
}
const textVersion = (text: string) =>
  text
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, '').trim())
    .find(Boolean) ?? ''
const lockKeys: Record<string, string> = {
  'pnpm-lock.yaml': 'pnpmLock',
  'shrinkwrap.yaml': 'pnpmShrinkwrap',
  'yarn.lock': 'yarnLock',
  'npm-shrinkwrap.json': 'shrinkwrap',
  'package-lock.json': 'npmLock',
}

export async function collect({ cwd = process.cwd(), node, packageManager }: CollectOptions = {}): Promise<Collection> {
  const start = await realpath(resolvePath(cwd))
  if (!(await stat(start)).isDirectory()) throw new Error(`cwd is not a directory: ${start}`)
  const warnings: Warning[] = []
  const sources: Source[] = []
  const ancestors: string[] = []
  let gitRoot: string | undefined
  for (let current = start; ; current = dirname(current)) {
    ancestors.push(current)
    try {
      const marker = await stat(join(current, '.git'))
      if (marker.isDirectory() || marker.isFile()) {
        gitRoot = current
        break
      }
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        warnings.push(createWarning('git-root-read-failed', { detail: errorMessage(error) }, { path: current }))
        break
      }
    }
    if (dirname(current) === current) break
  }
  const directories = gitRoot ? ancestors : [start]
  if (!gitRoot) warnings.push(createWarning('git-root-not-found', {}, { path: start }))
  if (node !== undefined && node !== '')
    sources.push(createSource('remoteNode', node, { depth: -1, path: 'input.node' }))
  if (packageManager !== undefined && packageManager !== '')
    sources.push(createSource('remotePackageManager', packageManager, { depth: -1, path: 'input.packageManager' }))
  for (const [depth, directory] of directories.entries()) {
    const entries = await Promise.all(
      files.map(async (name) => {
        const path = join(directory, name)
        try {
          return { name, path, text: await readFile(path, 'utf8') }
        } catch (error) {
          if (errorCode(error) !== 'ENOENT')
            warnings.push(createWarning('file-read-failed', { detail: errorMessage(error) }, { path }))
          return null
        }
      }),
    )
    for (const entry of entries) {
      if (!entry) continue
      const { name, path, text } = entry
      const add = (key: string, value: unknown, extra: Partial<Source> = {}) =>
        sources.push(createSource(key, value, { depth, path, index: sources.length, ...extra }))
      const parseFailure = (error: unknown) =>
        warnings.push(createWarning('file-parse-failed', { file: name, detail: errorMessage(error) }, { path }))
      if (name === 'package.json') {
        let manifest: Record<string, unknown>
        try {
          manifest = object(JSON.parse(text), name)
        } catch (error) {
          parseFailure(error)
          continue
        }
        if ('packageManager' in manifest) add('packageManager', manifest.packageManager)
        const volta = optionalObject(manifest.volta)
        const dev = optionalObject(manifest.devEngines)
        const engines = optionalObject(manifest.engines)
        if ('node' in volta) add('voltaNode', volta.node)
        for (const element of array(dev.runtime)) {
          const item = optionalObject(element)
          if (item.name === 'node') add('devRuntime', item.version)
        }
        for (const element of array(dev.packageManager)) {
          const item = optionalObject(element)
          add('devPackageManager', `${String(item.name)}@${declarationText(item.version ?? '*')}`)
        }
        for (const [field, key] of [
          ['node', 'enginesNode'],
          ['npm', 'enginesNpm'],
          ['pnpm', 'enginesPnpm'],
          ['yarn', 'enginesYarn'],
        ]) {
          if (field in engines) add(key, engines[field])
        }
      } else if (name === '.nvmrc' || name === '.node-version') {
        add(name === '.nvmrc' ? 'nvmrc' : 'nodeVersion', textVersion(text))
      } else if (name === '.tool-versions') {
        const line = text
          .split(/\r?\n/)
          .map((row) => row.replace(/#.*$/, '').trim())
          .find((row) => /^nodejs\s/.test(row))
        if (line) add('toolVersions', line.split(/\s+/).slice(1).join(' || '))
      } else {
        let format = 'unknown'
        const extra: Partial<Source> = {}
        try {
          if (name === 'yarn.lock') {
            const lock = readYarnLock(text)
            format = lock.family === 'classic' ? 'v1' : declarationText(lock.format ?? 'unknown')
            if (lock.family === 'zpm') extra.features = { yarnFamily: 'zpm' }
            if (lock.cacheKey !== undefined) extra.cacheKey = lock.cacheKey
            if (lock.error) parseFailure(lock.error)
          } else {
            const data = object(name.endsWith('.json') ? JSON.parse(text) : parseYaml(text), name)
            format = declarationText(
              data[name === 'shrinkwrap.yaml' ? 'shrinkwrapVersion' : 'lockfileVersion'] ?? 'unknown',
            )
            if (name === 'pnpm-lock.yaml')
              extra.features = { patches: Object.keys(optionalObject(data.patchedDependencies)).length > 0 }
            if (name === 'shrinkwrap.yaml') extra.features = { sharedWorkspace: 'importers' in data }
          }
        } catch (error) {
          parseFailure(error)
        }
        add(lockKeys[name], format, extra)
      }
    }
  }
  sources.sort((a, b) => a.depth - b.depth || a.rank - b.rank)
  return { sources, warnings, directories, root: gitRoot ?? start }
}
