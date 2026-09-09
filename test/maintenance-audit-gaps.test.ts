import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import test from 'node:test'
import { promisify } from 'node:util'

import { auditGaps, renderGapAuditMarkdown } from '../maintenance/audit-gaps.js'

import type { InitialPoint, InitialReport } from '../maintenance/compile-initial.js'

const exec = promisify(execFile)
const point = (version: string, outcome: InitialPoint['outcome']): InitialPoint => ({
  version,
  prerelease: version.includes('-'),
  outcome,
  evidenceIds: [`evidence-${version}`],
  rowIds: [`row-${version}`],
})
function report(points: InitialPoint[], range: string | null = '>=1.0.0'): InitialReport {
  return {
    catalogHash: 'catalog-hash',
    fixtures: [
      {
        fixtureId: 'npm-fixture',
        fixtureHash: 'fixture-hash',
        match: { format: 3, file: 'package-lock.json' },
        range,
        points,
        boundaries: [],
        issues: [],
      },
    ],
    issues: [],
    retests: [],
    exitCode: 0,
  }
}

test('all stable gaps preserve mixed outcomes and exact evidence while edges stay separate', () => {
  const input = report(
    [
      point('2.0.0', 'unsupported'),
      point('1.6.0', 'supported'),
      point('1.5.0', 'unknown'),
      point('1.4.0', 'supported'),
      point('1.3.0', 'unsupported'),
      point('1.2.0', 'unknown'),
      point('1.1.0', 'supported'),
      point('1.0.0', 'unsupported'),
    ],
    '>=1.1.0 <1.3.0 || >=1.4.0 <2.0.0',
  )
  const before = JSON.stringify(input)
  const fixture = auditGaps(input).fixtures[0]
  assert.deepEqual(
    fixture.stableGaps.map((gap) => ({
      before: gap.before.version,
      after: gap.after.version,
      points: gap.points.map((item) => [item.version, item.outcome, item.rangeMembership, item.rowIds]),
    })),
    [
      {
        before: '1.1.0',
        after: '1.4.0',
        points: [
          ['1.2.0', 'unknown', 'included', ['row-1.2.0']],
          ['1.3.0', 'unsupported', 'excluded', ['row-1.3.0']],
        ],
      },
      {
        before: '1.4.0',
        after: '1.6.0',
        points: [['1.5.0', 'unknown', 'included', ['row-1.5.0']]],
      },
    ],
  )
  assert.deepEqual(fixture.stableGaps[0].points[0].evidenceIds, ['evidence-1.2.0'])
  assert.deepEqual(
    fixture.edgeRuns.map((run) => [run.side, run.points.map((item) => item.version)]),
    [
      ['lower', ['1.0.0']],
      ['upper', ['2.0.0']],
    ],
  )
  assert.deepEqual(
    fixture.unknownPoints.included.map((item) => item.version),
    ['1.2.0', '1.5.0'],
  )
  assert.equal(JSON.stringify(input), before)
})

test('unknown points distinguish covered, excluded, and uncompiled ranges', () => {
  const points = [point('1.0.0', 'supported'), point('1.1.0', 'unknown'), point('2.0.0', 'supported')]
  const covered = auditGaps(report(points)).fixtures[0]
  const excluded = auditGaps(report(points, '>=2.0.0')).fixtures[0]
  const uncompiled = auditGaps(report(points, null)).fixtures[0]
  assert.deepEqual(
    covered.unknownPoints.included.map((item) => item.version),
    ['1.1.0'],
  )
  assert.deepEqual(
    excluded.unknownPoints.excluded.map((item) => item.version),
    ['1.1.0'],
  )
  assert.deepEqual(
    uncompiled.unknownPoints.uncompiled.map((item) => item.version),
    ['1.1.0'],
  )
  assert.equal(uncompiled.stableGaps[0].points[0].rangeMembership, 'uncompiled')
  assert.deepEqual(uncompiled.rangeContradictions, [])
  assert.deepEqual(
    uncompiled.uncompiledSupportedPoints.map((item) => item.version),
    ['1.0.0', '2.0.0'],
  )
})

test('historical prerelease points are ignored by every audit count without changing evidence', () => {
  const input = report(
    [
      point('7.0.0-beta.0', 'unsupported'),
      point('7.0.0-beta.1', 'unknown'),
      point('7.0.0-beta.2', 'supported'),
      point('7.0.0', 'supported'),
      point('7.1.0-beta.0', 'unknown'),
      point('7.1.0', 'supported'),
    ],
    '>=7.0.0',
  )
  const before = JSON.stringify(input)
  const audit = auditGaps(input)
  assert.equal(audit.summary.pointCount, 2)
  assert.equal(audit.summary.unknownPointCount, 0)
  assert.equal(audit.summary.rangeContradictionCount, 0)
  assert.equal(audit.fixtures[0].firstSupported, '7.0.0')
  assert.deepEqual(audit.fixtures[0].edgeRuns, [])
  assert.deepEqual(audit.fixtures[0].stableGaps, [])
  assert.equal(renderGapAuditMarkdown(audit).includes('beta.'), false)
  assert.equal(JSON.stringify(input), before)
})

test('range contradictions use only stable conclusive points', () => {
  const fixture = auditGaps(
    report([
      point('1.0.0', 'supported'),
      point('1.5.0', 'unsupported'),
      point('2.0.0-beta.0', 'supported'),
      point('2.0.0-beta.1', 'unknown'),
    ]),
  ).fixtures[0]
  assert.deepEqual(
    fixture.rangeContradictions.map((item) => [item.kind, item.point.version]),
    [['unsupported-included', '1.5.0']],
  )
})

test('an entirely unsupported fixture is an edge with no supported anchor', () => {
  const fixture = auditGaps(report([point('1.0.0', 'unknown'), point('1.1.0', 'unsupported')], null)).fixtures[0]
  assert.deepEqual(fixture.stableGaps, [])
  assert.deepEqual(
    fixture.edgeRuns.map((run) => [run.side, run.outcome]),
    [
      ['no-supported-sample', 'unknown'],
      ['no-supported-sample', 'unsupported'],
    ],
  )
})

test('invalid or duplicate versions cannot silently corrupt the inventory', () => {
  assert.throws(() => auditGaps(report([point('invalid', 'unknown')])), /version/i)
  assert.throws(() => auditGaps(report([point('1.0.0', 'supported')], 'not-a-range')), /range/i)
  assert.throws(() => auditGaps(report([point('1.0.0', 'supported'), point('1.0.0', 'unknown')])), /duplicate/i)
})

test('Markdown includes every gap point and all evidence IDs without truncation', () => {
  const input = report(
    [
      point('1.0.0', 'supported'),
      point('1.1.0', 'unknown'),
      point('1.2.0', 'unsupported'),
      point('2.0.0', 'supported'),
    ],
    '>=1.0.0 <1.2.0 || >=2.0.0',
  )
  input.fixtures[0].points[1].evidenceIds.push('second-evidence')
  const markdown = renderGapAuditMarkdown(auditGaps(input))
  for (const text of [
    'npm-fixture',
    '1.1.0',
    '1.2.0',
    'row-1.1.0',
    'row-1.2.0',
    'evidence-1.1.0',
    'second-evidence',
    'included',
    'excluded',
  ])
    assert.ok(markdown.includes(text), text)
})

test('CLI writes only explicit output files and protects the source report', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'audit-gaps-'))
  try {
    const input = join(directory, 'input.json')
    const output = join(directory, 'audit.json')
    const markdown = join(directory, 'audit.md')
    const bytes = JSON.stringify(
      report([point('1.0.0', 'supported'), point('1.1.0', 'unknown'), point('2.0.0', 'supported')]),
    )
    await writeFile(input, bytes)
    const command = [resolve('node_modules/tsx/dist/cli.mjs'), resolve('maintenance/audit-gaps.ts'), '--report', input]
    await exec(process.execPath, [...command, '--json', output, '--markdown', markdown])
    assert.equal((JSON.parse(await readFile(output, 'utf8')) as { fixtures: unknown[] }).fixtures.length, 1)
    assert.match(await readFile(markdown, 'utf8'), /row-1\.1\.0/)
    assert.equal(await readFile(input, 'utf8'), bytes)
    assert.deepEqual((await readdir(directory)).sort(), ['audit.json', 'audit.md', 'input.json'])
    await assert.rejects(exec(process.execPath, [...command, '--json', input]), /overwrite.*report/i)
    assert.equal(await readFile(input, 'utf8'), bytes)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
