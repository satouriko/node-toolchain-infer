import {
  digest,
  type Fixture,
  FROZEN_LOCKFILES,
  FROZEN_PROTOCOL,
  frozenControlAccepted,
  type Observation,
} from './model.js'
import { frozenArgs } from './runner.js'

/** A frozen install proves lock enforcement if the changed-manifest control rejects or preserves locked versions.
 * This checks both observed input sets; neither tool version heuristics nor an unexecuted control qualify.
 */
export function frozenControlError(fixture: Fixture, baseline: Observation): string | undefined {
  if (baseline.status !== 'pass' || !fixture.controlDependencies) return undefined
  const control = baseline.frozenControl
  if (!control) return 'Pass lacks its required frozen-lock control observation'
  const requested = { ...fixture.dependencies, ...fixture.controlDependencies }
  if (
    !control.requestedDependencies
    || JSON.stringify(Object.keys(control.requestedDependencies).sort())
      !== JSON.stringify(Object.keys(requested).sort())
    || Object.entries(requested).some(([name, version]) => control.requestedDependencies![name] !== version)
  )
    return 'Frozen control requested dependencies differ from the current fixture control contract'
  for (const field of [
    'manager',
    'version',
    'actualVersion',
    'toolIntegrity',
    'node',
    'nodeIntegrity',
    'platform',
    'arch',
    'nodeArch',
  ] as const)
    if (control[field] !== baseline[field]) return `Frozen control ${field} differs from baseline`
  const environment = (observation: Observation) =>
    JSON.stringify(Object.entries(observation.environment ?? {}).sort(([a], [b]) => a.localeCompare(b)))
  if (environment(control) !== environment(baseline)) return 'Frozen control install environment differs from baseline'
  if (
    control.bootstrap?.lockfileSha256 !== baseline.bootstrap?.lockfileSha256
    || control.bootstrap?.installedTreeSha256 !== baseline.bootstrap?.installedTreeSha256
    || control.native?.integrity !== baseline.native?.integrity
    || control.native?.binarySha256 !== baseline.native?.binarySha256
  )
    return 'Frozen control executed a different bootstrap dependency graph or native distribution'
  if (
    control.protocol !== FROZEN_PROTOCOL
    || !frozenControlAccepted(fixture, control)
    || typeof control.logPath !== 'string'
    || !control.logPath.trim()
    || JSON.stringify(control.command) !== JSON.stringify(frozenArgs(fixture.manager, baseline.version))
  )
    return 'Frozen control must explicitly reject the changed manifest or retain the original locked dependencies without changing files'
  const original = baseline.inputHashes
  const inputs = control.inputHashes
  if (
    !original
    || !inputs
    || !inputs['package.json']
    || inputs['package.json'] === '<missing>'
    || inputs['package.json'] === original['package.json']
    || JSON.stringify(Object.keys(inputs).sort()) !== JSON.stringify(Object.keys(original).sort())
    || Object.keys(original).some((file) => file !== 'package.json' && inputs[file] !== original[file])
    || control.fixtureHash !== digest(JSON.stringify(inputs))
  )
    return 'Frozen control inputs must change only the manifest and preserve the exact lock and configuration bytes'
  const watched = [...new Set([...Object.keys(inputs), ...FROZEN_LOCKFILES])].sort()
  const before = control.beforeHashes as Record<string, string> | null | undefined
  if (
    !before
    || JSON.stringify(Object.keys(before).sort()) !== JSON.stringify(watched)
    || watched.some((file) => before[file] !== (inputs[file] ?? '<missing>'))
  )
    return 'Frozen control before hashes do not describe its claimed input bytes'
  return undefined
}
