import { declarationText } from './validation.js'

import type { Source, SourceDefinition } from './types.js'

const definitions: Array<[string, string, Source['target'], number, Source['manager']?, boolean?]> = [
  ['remoteNode', 'input.node', 'node', 1],
  ['remotePackageManager', 'input.packageManager', 'manager', 2],
  ['packageManager', 'packageManager', 'manager', 3],
  ['pnpmLock', 'pnpm-lock.yaml', 'lock', 4, 'pnpm'],
  ['pnpmShrinkwrap', 'shrinkwrap.yaml', 'lock', 5, 'pnpm'],
  ['yarnLock', 'yarn.lock', 'lock', 6, 'yarn'],
  ['shrinkwrap', 'npm-shrinkwrap.json', 'lock', 7, 'npm'],
  ['npmLock', 'package-lock.json', 'lock', 8, 'npm'],
  ['voltaNode', 'volta.node', 'node', 9],
  ['nodeVersion', '.node-version', 'node', 10],
  ['nvmrc', '.nvmrc', 'node', 11],
  ['toolVersions', '.tool-versions', 'node', 12],
  ['devRuntime', 'devEngines.runtime', 'node', 13],
  ['devPackageManager', 'devEngines.packageManager', 'manager', 14],
  ['enginesNode', 'engines.node', 'node', 15],
  ['enginesNpm', 'engines.npm', 'manager', 16, 'npm', true],
  ['enginesPnpm', 'engines.pnpm', 'manager', 16, 'pnpm', true],
  ['enginesYarn', 'engines.yarn', 'manager', 16, 'yarn', true],
]
export const SOURCE_DEFINITIONS: SourceDefinition[] = definitions.map(
  ([key, kind, target, rank, manager, conditional]) => ({
    key,
    kind,
    target,
    rank,
    ...(manager ? { manager } : {}),
    ...(conditional ? { conditional: true } : {}),
  }),
)
export function createSource(
  key: string,
  value: unknown,
  { depth = 0, path = '', index = 0, ...extra }: Partial<Source> & { index?: number } = {},
): Source {
  const definition = SOURCE_DEFINITIONS.find((source) => source.key === key)
  if (!definition) throw new Error(`Unknown source: ${key}`)
  return {
    ...definition,
    id: `${depth}:${key}:${index}`,
    depth,
    path,
    value,
    ...(definition.target === 'lock' ? { format: declarationText(value ?? 'unknown') } : {}),
    ...extra,
  }
}
