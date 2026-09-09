import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import semver from 'semver'

import { isStableVersion } from '../src/versions.js'

import { frozenControlError } from './frozen-control.js'
import { bugSummary, compatibilityOutcome, type KnownBugReview, loadKnownBugs, reviewedBug } from './known-bugs.js'
import { compileIntervals, type Fixture, type Interval, mergeHistory, type Observation } from './model.js'
import { readJson } from './run-matrix.js'
import { frozenArgs } from './runner.js'

import type { Catalog, CompatibilityRule, Manager } from '../src/types.js'

export interface Boundary {
  fixtureId: string
  before: string
  after: string
}
export function compileRules(
  fixtures: Fixture[],
  boundaries: Boundary[],
  observations: Observation[],
  versions: Record<Manager, string[]>,
  knownBugs: KnownBugReview[] = [],
): CompatibilityRule[] {
  const stableBoundaries = boundaries.filter((boundary) =>
    [boundary.before, boundary.after].every((id) => {
      const observation = observations.find((item) => item.id === id)
      return !observation || isStableVersion(observation.version)
    }),
  )
  const stableObservations = observations.filter((observation) => isStableVersion(observation.version))
  const rules: CompatibilityRule[] = []
  for (const fixture of fixtures) {
    const selected = stableBoundaries.filter((boundary) => boundary.fixtureId === fixture.id)
    if (!selected.length) continue
    const edges = selected
      .map((boundary) => {
        const before = observations.find((item) => item.id === boundary.before)
        const after = observations.find((item) => item.id === boundary.after)
        if (
          !before
          || !after
          || (!['pass', 'incompatible'].includes(before.status) && !reviewedBug(before, knownBugs))
          || (!['pass', 'incompatible'].includes(after.status) && !reviewedBug(after, knownBugs))
          || compatibilityOutcome(before, knownBugs) === compatibilityOutcome(after, knownBugs)
        )
          throw new Error('Boundary needs conclusive opposite outcomes')
        for (const observation of [before, after]) {
          if (JSON.stringify(observation.command) !== JSON.stringify(frozenArgs(fixture.manager, observation.version)))
            throw new Error('Boundary observation command differs from the required frozen command for its release')
          const controlError = frozenControlError(fixture, observation)
          if (controlError) throw new Error(controlError)
        }
        if (
          before.fixtureId !== fixture.id
          || after.fixtureId !== fixture.id
          || before.fixtureHash !== after.fixtureHash
          || before.manager !== fixture.manager
          || after.manager !== fixture.manager
          || before.platform !== after.platform
          || before.arch !== after.arch
          || before.node !== after.node
          || !before.nodeIntegrity
          || before.nodeIntegrity !== after.nodeIntegrity
          || (before.nodeArch ?? before.arch) !== (after.nodeArch ?? after.arch)
        )
          throw new Error('Boundary must use the same fixture, Node and platform')
        const environment = (observation: Observation) =>
          JSON.stringify(Object.entries(observation.environment ?? {}).sort(([a], [b]) => a.localeCompare(b)))
        if (environment(before) !== environment(after))
          throw new Error('Boundary must use the same install environment')
        const published = versions[fixture.manager]
          .filter((version) => !semver.prerelease(version))
          .sort(semver.compare)
        const index = published.indexOf(before.version)
        if (index === -1 || published[index + 1] !== after.version)
          throw new Error(
            'Boundary versions must be adjacent published stable releases; sparse samples are insufficient',
          )
        return { before, after }
      })
      .sort((a, b) => semver.compare(a.after.version, b.after.version))
    const intervals: Interval[] = []
    let open: Interval | undefined
    for (const edge of edges) {
      if (compatibilityOutcome(edge.after, knownBugs) === 'supported') {
        if (open) throw new Error('Duplicate lower boundary without intervening upper boundary')
        open = { lower: edge.after.version, evidenceIds: [edge.before.id, edge.after.id], confirmed: true }
        intervals.push(open)
      } else {
        if (!open) throw new Error('Upper boundary requires a confirmed lower boundary')
        open.upper = edge.after.version
        open.evidenceIds.push(edge.before.id, edge.after.id)
        open = undefined
      }
    }
    const applied = knownBugs.filter((bug) =>
      stableObservations.some((observation) => observation.fixtureId === fixture.id && reviewedBug(observation, [bug])),
    )
    rules.push({
      id: `measured-${fixture.id}`,
      manager: fixture.manager,
      match: fixture.match,
      range: compileIntervals(intervals),
      ...(applied.length ? { knownBugs: applied.map(bugSummary) } : {}),
    })
  }
  return rules
}
export async function compileCompatibility(root = process.cwd()): Promise<void> {
  const getArg = (name: string): string | undefined => {
    const index = process.argv.indexOf(name)
    return index === -1 ? undefined : process.argv[index + 1]
  }
  const catalogPath = getArg('--catalog')
  if (!catalogPath)
    throw new Error('Pass --catalog with the complete official catalog used to confirm adjacent versions')
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8')) as Catalog
  const observations = mergeHistory(
    await readJson<Observation[]>(join(root, 'maintenance/evidence/observations.json'), []),
    await readJson<Observation[]>(getArg('--observations') ?? join(root, 'maintenance/results/observations.json'), []),
  )
  const fixtures = await readJson<Fixture[]>(join(root, 'fixtures/recipes.json'), [])
  const boundaries = await readJson<Boundary[]>(join(root, 'maintenance/boundaries.json'), [])
  const rules = compileRules(
    fixtures,
    boundaries,
    observations,
    {
      npm: catalog.managers.npm.map((item) => item.version),
      pnpm: catalog.managers.pnpm.map((item) => item.version),
      yarn: catalog.managers.yarn.map((item) => item.version),
    },
    await loadKnownBugs(join(root, 'maintenance/known-bugs.json')),
  )
  await writeFile(
    join(root, 'data/compatibility.json'),
    `${JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), rules, observations: [] }, null, 2)}\n`,
  )
  console.log(`Compiled ${rules.length} rules from ${boundaries.length} confirmed boundaries`)
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  compileCompatibility().catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
