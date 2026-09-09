import type { Catalog, Warning } from '../../src/types.js'

export type ErrorCode = 'network' | 'timeout' | 'json' | 'http' | 'metadata' | 'cancelled' | 'calculation'

export interface InputState {
  runtime: Record<string, string>
  fields: Record<string, string>
  searchDepth: number
  additional: Array<{
    key: string
    depth: number
    value: string
    sharedWorkspace?: boolean
    yarnFamily?: 'berry' | 'zpm'
  }>
}
export interface UiVersion {
  sourceUrl?: string
  version: string
  npm?: string | null
  node?: string | null
  nodeDeclared?: boolean
  runtime?: 'node' | 'native'
}
export interface UiCatalog {
  schemaVersion: 1
  warnings: Warning[]
  generatedAt: string | null
  nodes: UiVersion[]
  managers: Record<string, UiVersion[]>
  sources: Catalog['sources']
}
export interface SourceReceipt {
  id: string
  name: string
  url: string
  fields: string
  status: string
  count?: number
  fetchedAt?: string
  error?: string
  errorCode?: ErrorCode
}
export interface UiTrace {
  key: string
  depth: number
  order: number
  rank: number
  name: string
  value: string
  normalized?: string
  status: string
  kind?: string
  detail: string
  inference?: string
  manager?: string
  blockers?: string[]
  remainingNodes?: number
  remainingPMs?: number
  derivations?: Array<{ versions: string[]; count: number; node: string }>
}
export interface UiResult {
  node: { version: string; reason: string; source?: string } | null
  packageManager: {
    name: string
    version: string
    reason: string
    source?: string
    nodeRange?: string | null
    runtime?: 'node' | 'native'
    preferredDetail?: string
  } | null
  nodeCandidates: string[]
  pmCandidates: string[]
  nodeConstraints: Array<{ range: string; source: string }>
  pmConstraints: Array<{ range: string; source: string; inferred?: boolean }>
  derivedNodeRanges: string[]
  warnings: Array<{ code?: string; source: string; message: string; blockers: string[] }>
  trace: UiTrace[]
  selectionVerified: boolean
  nodeCompatibility: string
  versionData?: { fetchedAt: string | null; sources: Catalog['sources'] }
}
