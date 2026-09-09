export type Manager = 'npm' | 'pnpm' | 'yarn'
export type SourceTarget = 'node' | 'manager' | 'lock'
export type VersionReason = 'exact' | 'current' | 'maximum' | 'bundled' | 'local'
export interface Warning {
  code: string
  message: string
  sourceId?: string
  path?: string
  blockers?: string[]
  fetchedAt?: string
}
export interface Runtime {
  node: string
  npm: string
  pnpm?: string
  yarn?: string
}
export interface Source {
  id: string
  kind: string
  target: SourceTarget
  value: unknown
  depth: number
  rank: number
  manager?: Manager
  format?: string | number
  features?: Record<string, unknown>
  cacheKey?: string | number
  path?: string
  conditional?: boolean
  key?: string
}
export interface SourceDefinition {
  key: string
  kind: string
  target: SourceTarget
  rank: number
  manager?: Manager
  conditional?: boolean
}
export interface NodeRelease {
  version: string
  npm?: string | null
  lts?: string | false
  date?: string
}
export interface ManagerRelease {
  version: string
  node: string | null
  /** Native executables have no host Node requirement; their normalized node constraint is *. */
  runtime?: 'node' | 'native'
  releasedAt?: string
  sourceUrl?: string
  tarball?: string
  bundle?: { url: string; commit: string; tag: string; size: number }
  integrity?: string
  observedRuntime?: boolean
}
export interface SourceReceipt {
  id: string
  url: string
  fetchedAt: string
  sha256: string
  checkedAt?: string
  etag?: string
  lastModified?: string
}
export interface Catalog {
  schemaVersion: 1
  generatedAt: string
  sources: SourceReceipt[]
  nodes: NodeRelease[]
  managers: Record<Manager, ManagerRelease[]>
  warnings: Warning[]
}
export interface KnownBug {
  id: string
  range: string
  reason: string
  url: string
}
export interface CompatibilityRule {
  id: string
  manager: Manager
  range: string | null
  match: {
    file?: string
    format?: string | number
    classic?: boolean
    features?: Record<string, unknown>
    cacheKeyMin?: number
    cacheKeyMax?: number
  }
  knownBugs?: KnownBug[]
}
export interface CompatibilityData {
  schemaVersion: 1
  generatedAt: string
  rules: CompatibilityRule[]
  observations: unknown[]
}
export interface NormalizedSource extends Source {
  manager: Manager
  range: string
  ranges: string[]
  exact: string | null
  invalid?: string
  index: number
  derivedNodeRanges: string[]
  lockfile?: boolean
  compatibilityKnown?: boolean
  ruleIds?: string[]
  knownBugs?: KnownBug[]
}
export interface TraceEntry extends NormalizedSource {
  status: 'invalid' | 'accepted' | 'ignored' | 'inactive'
  reason?: string
  blockers?: string[]
  remainingNodes?: number
  remainingManagerVersions?: number
}
export interface Constraint {
  id: string
  target: SourceTarget
  manager?: Manager
  range: string
  ranges: string[]
  derivedNodeRanges: string[]
  ruleIds?: string[]
}
export interface ResolveInput {
  sources?: Source[]
  runtime: Runtime
}
export interface ResolveResult {
  candidates: { nodes: string[]; managerVersions: string[] }
  node: { version: string; reason: VersionReason; bundledNpm: string | null } | null
  packageManager: {
    name: Manager
    version: string
    reason: VersionReason
    nodeRange: string | null
    runtime?: 'node' | 'native'
  } | null
  warnings: Warning[]
  trace: TraceEntry[]
  constraints: Constraint[]
  dataTimestamp: string | null
}
export interface CollectOptions {
  cwd?: string
  node?: string
  packageManager?: string
}
export interface Collection {
  sources: Source[]
  warnings: Warning[]
  directories: string[]
  root: string
}
export interface FetchResponse {
  status: number
  ok: boolean
  headers: { get: (name: string) => string | null }
  text: () => Promise<string>
}
export interface FetchOptions {
  signal?: AbortSignal
  headers?: Record<string, string>
}
export type Fetcher = (url: string, options: FetchOptions) => Promise<FetchResponse>
export interface CatalogOptions {
  fetcher?: Fetcher
  signal?: AbortSignal
  onSource?: (event: CatalogEvent) => void
}
export interface CatalogEvent {
  id: string
  url: string
  status: 'loading' | 'ready' | 'error' | 'stale'
  count?: number
  fetchedAt?: string
  error?: string
}
