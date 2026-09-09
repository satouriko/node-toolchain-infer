import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

import semver from 'semver'

import type { InitialFixtureReport, InitialPoint, InitialReport } from './compile-initial.js'

export type RangeMembership = 'included' | 'excluded' | 'uncompiled'
export interface GapPoint extends InitialPoint {
  rangeMembership: RangeMembership
}
export interface OutcomeRun {
  outcome: InitialPoint['outcome']
  points: GapPoint[]
}
export interface StableGap {
  before: GapPoint
  points: GapPoint[]
  after: GapPoint
}
export interface RangeContradiction {
  kind: 'supported-excluded' | 'unsupported-included'
  point: GapPoint
}
export interface FixtureGapAudit {
  fixtureId: string
  fixtureHash: string
  match: InitialFixtureReport['match']
  range: string | null
  pointCount: number
  firstSupported: string | null
  lastSupported: string | null
  stableGaps: StableGap[]
  edgeRuns: Array<OutcomeRun & { side: 'lower' | 'upper' | 'no-supported-sample' }>
  rangeContradictions: RangeContradiction[]
  unknownPoints: Record<RangeMembership, GapPoint[]>
  uncompiledSupportedPoints: GapPoint[]
}
export interface GapAudit {
  schemaVersion: 1
  catalogHash: string
  fixtures: FixtureGapAudit[]
  summary: {
    fixtureCount: number
    pointCount: number
    stableGapCount: number
    rangeContradictionCount: number
    unknownPointCount: number
    uncompiledFixtureCount: number
  }
}
function outcomeRuns(points: GapPoint[]): OutcomeRun[] {
  const runs: OutcomeRun[] = []
  for (const point of points) {
    const previous = runs.at(-1)
    if (previous?.outcome === point.outcome) previous.points.push(point)
    else runs.push({ outcome: point.outcome, points: [point] })
  }
  return runs
}
function fixtureAudit(fixture: InitialFixtureReport): FixtureGapAudit {
  if (fixture.range !== null && !semver.validRange(fixture.range))
    throw new Error(`Invalid range for ${fixture.fixtureId}: ${fixture.range}`)
  const versions = new Set<string>()
  const points: GapPoint[] = fixture.points
    .map((point) => {
      if (!semver.valid(point.version)) throw new Error(`Invalid version for ${fixture.fixtureId}: ${point.version}`)
      if (versions.has(point.version)) throw new Error(`Duplicate version for ${fixture.fixtureId}: ${point.version}`)
      versions.add(point.version)
      if (point.prerelease !== !!semver.prerelease(point.version))
        throw new Error(`Prerelease flag disagrees with version: ${fixture.fixtureId}, ${point.version}`)
      if (!['supported', 'unsupported', 'unknown'].includes(point.outcome))
        throw new Error(`Invalid outcome for ${fixture.fixtureId}, ${point.version}`)
      let rangeMembership: RangeMembership = 'uncompiled'
      if (fixture.range !== null)
        rangeMembership = semver.satisfies(point.version, fixture.range) ? 'included' : 'excluded'
      return {
        ...point,
        evidenceIds: [...point.evidenceIds],
        rowIds: [...point.rowIds],
        ...(point.exceptions ? { exceptions: point.exceptions.map((entry) => ({ ...entry })) } : {}),
        rangeMembership,
      }
    })
    .filter((point) => !point.prerelease)
    .sort((a, b) => semver.compare(a.version, b.version))
  const stable = points.filter((point) => !point.prerelease)
  const stableGaps: StableGap[] = []
  let before: GapPoint | undefined
  let pending: GapPoint[] = []
  for (const point of stable) {
    if (point.outcome === 'supported') {
      if (before && pending.length) stableGaps.push({ before, points: pending, after: point })
      before = point
      pending = []
    } else if (before) pending.push(point)
  }
  const first = points.findIndex((point) => point.outcome === 'supported')
  const last = points.map((point) => point.outcome).lastIndexOf('supported')
  const edgeRuns: FixtureGapAudit['edgeRuns'] =
    first === -1
      ? outcomeRuns(points).map((run) => ({ ...run, side: 'no-supported-sample' }))
      : [
          ...outcomeRuns(points.slice(0, first)).map((run) => ({ ...run, side: 'lower' as const })),
          ...outcomeRuns(points.slice(last + 1)).map((run) => ({ ...run, side: 'upper' as const })),
        ]
  const rangeContradictions: RangeContradiction[] = []
  const unknownPoints: FixtureGapAudit['unknownPoints'] = { included: [], excluded: [], uncompiled: [] }
  for (const point of points) {
    if (point.outcome === 'unknown') unknownPoints[point.rangeMembership].push(point)
    else if (point.outcome === 'supported' && point.rangeMembership === 'excluded')
      rangeContradictions.push({ kind: 'supported-excluded', point })
    else if (point.outcome === 'unsupported' && point.rangeMembership === 'included')
      rangeContradictions.push({ kind: 'unsupported-included', point })
  }
  return {
    fixtureId: fixture.fixtureId,
    fixtureHash: fixture.fixtureHash,
    match: { ...fixture.match },
    range: fixture.range,
    pointCount: points.length,
    firstSupported: first === -1 ? null : points[first].version,
    lastSupported: last === -1 ? null : points[last].version,
    stableGaps,
    edgeRuns,
    rangeContradictions,
    unknownPoints,
    uncompiledSupportedPoints: points.filter(
      (point) => point.outcome === 'supported' && point.rangeMembership === 'uncompiled',
    ),
  }
}
/** Inventory measured discontinuities without changing evidence or inferring support for unknown points. */
export function auditGaps(report: InitialReport): GapAudit {
  const fixtures = report.fixtures.map(fixtureAudit)
  const sum = (count: (fixture: FixtureGapAudit) => number): number =>
    fixtures.reduce((total, fixture) => total + count(fixture), 0)
  return {
    schemaVersion: 1,
    catalogHash: report.catalogHash,
    fixtures,
    summary: {
      fixtureCount: fixtures.length,
      pointCount: sum((fixture) => fixture.pointCount),
      stableGapCount: sum((fixture) => fixture.stableGaps.length),
      rangeContradictionCount: sum((fixture) => fixture.rangeContradictions.length),
      unknownPointCount: sum((fixture) =>
        Object.values(fixture.unknownPoints).reduce((count, points) => count + points.length, 0),
      ),
      uncompiledFixtureCount: sum((fixture) => Number(fixture.range === null)),
    },
  }
}
const cell = (value: string): string =>
  value
    .replaceAll('\\', '\\\\')
    .replaceAll('|', String.raw`\|`)
    .replaceAll('\n', '<br>')
function pointTable(points: GapPoint[]): string[] {
  return [
    '| Version | Outcome | Range membership | Evidence IDs | Row IDs |',
    '| --- | --- | --- | --- | --- |',
    ...points.map(
      (point) =>
        `| ${[point.version, point.outcome, point.rangeMembership, point.evidenceIds.join(', '), point.rowIds.join(', ')].map(cell).join(' | ')} |`,
    ),
    '',
  ]
}
export function renderGapAuditMarkdown(audit: GapAudit): string {
  const { summary } = audit
  const lines = [
    '# Compatibility gap inventory',
    '',
    `${summary.fixtureCount} fixtures; ${summary.pointCount} points; ${summary.stableGapCount} stable internal gaps; ${summary.rangeContradictionCount} range contradictions.`,
    '',
    'Only stable release points contribute to this inventory. Included unknown points remain unknown; uncompiled means no range exists. Archived prerelease evidence remains unchanged.',
    '',
  ]
  for (const fixture of audit.fixtures) {
    lines.push(`## ${cell(fixture.fixtureId)}`, '', `Range: ${fixture.range ?? '(uncompiled)'}`, '')
    for (const gap of fixture.stableGaps)
      lines.push(
        `### Stable gap: ${gap.before.version} → ${gap.after.version}`,
        '',
        ...pointTable([gap.before, ...gap.points, gap.after]),
      )
    for (const edge of fixture.edgeRuns)
      lines.push(`### ${edge.side} edge: ${edge.outcome}`, '', ...pointTable(edge.points))
    for (const contradiction of fixture.rangeContradictions)
      lines.push(`### Range contradiction: ${contradiction.kind}`, '', ...pointTable([contradiction.point]))
    for (const membership of ['included', 'excluded', 'uncompiled'] as const) {
      const unknown = fixture.unknownPoints[membership]
      if (unknown.length) lines.push(`### Unknown points: ${membership}`, '', ...pointTable(unknown))
    }
    if (fixture.uncompiledSupportedPoints.length)
      lines.push('### Supported points without a compiled range', '', ...pointTable(fixture.uncompiledSupportedPoints))
    if (
      !fixture.stableGaps.length
      && !fixture.edgeRuns.length
      && !fixture.rangeContradictions.length
      && !Object.values(fixture.unknownPoints).some((points) => points.length)
      && !fixture.uncompiledSupportedPoints.length
    )
      lines.push('No measured gaps or contradictions.', '')
  }
  return `${lines.join('\n')}\n`
}
async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return resolve(path)
  }
}
export async function auditGapReportFile(options: {
  report: string
  json?: string
  markdown?: string
}): Promise<GapAudit> {
  const source = await canonicalPath(options.report)
  const outputs = [options.json, options.markdown].filter((path): path is string => path !== undefined)
  const destinations = await Promise.all(outputs.map(canonicalPath))
  if (destinations.includes(source)) throw new Error('Cannot overwrite the source report with audit output')
  if (new Set(destinations).size !== destinations.length) throw new Error('JSON and Markdown output paths must differ')
  const audit = auditGaps(JSON.parse(await readFile(source, 'utf8')) as InitialReport)
  for (const [path, content] of [
    [options.json, `${JSON.stringify(audit, null, 2)}\n`],
    [options.markdown, renderGapAuditMarkdown(audit)],
  ] as const) {
    if (path) {
      await mkdir(dirname(resolve(path)), { recursive: true })
      await writeFile(path, content)
    }
  }
  return audit
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  Promise.resolve()
    .then(async () => {
      const { values } = parseArgs({
        options: {
          report: { type: 'string' },
          json: { type: 'string' },
          markdown: { type: 'string' },
          help: { type: 'boolean' },
        },
      })
      if (values.help) {
        console.log('Usage: audit-gaps --report <report.json> [--json <audit.json>] [--markdown <audit.md>]')
        return
      }
      if (!values.report) throw new Error('Required --report <report.json>')
      const audit = await auditGapReportFile({ report: values.report, json: values.json, markdown: values.markdown })
      if (!values.json && !values.markdown) console.log(JSON.stringify(audit, null, 2))
    })
    .catch((error: unknown) => {
      console.error(error)
      process.exitCode = 2
    })
}
