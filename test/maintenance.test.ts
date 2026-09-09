import assert from 'node:assert/strict'
import test from 'node:test'

import { classify, compileIntervals, evaluate, mergeHistory, newReleases } from '../maintenance/model.js'
import { detectFormat } from '../maintenance/runner.js'

import { makeObservation } from './maintenance-fixture.js'

test('native pnpm outdated-lockfile errors establish a rejected frozen control', () => {
  const attempt = {
    manager: 'pnpm' as const,
    command: ['install', '--frozen-lockfile'],
    exitCode: 1,
    before: {},
    after: {},
    semantic: false,
  }
  const output =
    'Error: pacquet_package_manager::outdated_lockfile\nCannot install with "frozen-lockfile" because pnpm-lock.yaml is not up\n to date with package.json.'
  assert.equal(classify({ ...attempt, output }), 'incompatible')
  assert.equal(classify({ ...attempt, output: 'Error: pacquet_package_manager::network_error' }), 'inconclusive')
  assert.equal(classify({ ...attempt, output: `ECONNRESET\n${output}` }), 'inconclusive')
})

test('historical Yarn lock token errors are incompatible while checksum failures alone remain inconclusive', () => {
  const attempt = {
    manager: 'yarn' as const,
    command: ['install', '--immutable'],
    exitCode: 1,
    before: {},
    after: {},
    semantic: false,
  }
  const token = 'Unknown token: { line: 3, col: 2, type: INVALID } 3:2 in /tmp/project/yarn.lock'
  const checksum = "YN0018: │ is-number@npm:7.0.0: The remote archive doesn't match the expected checksum"
  assert.equal(classify({ ...attempt, output: token }), 'incompatible')
  assert.equal(classify({ ...attempt, output: token.replace('yarn.lock', 'tool.js') }), 'inconclusive')
  assert.equal(classify({ ...attempt, output: checksum }), 'inconclusive')
  assert.equal(classify({ ...attempt, output: `ECONNRESET\n${checksum}` }), 'inconclusive')
})

test('legacy pnpm format detection preserves file name and shared-workspace structure', () => {
  assert.deepEqual(detectFormat('pnpm', 'shrinkwrapVersion: 3\n', 'shrinkwrap.yaml'), {
    format: '3',
    file: 'shrinkwrap.yaml',
    features: { sharedWorkspace: false },
  })
  assert.deepEqual(detectFormat('pnpm', 'shrinkwrapVersion: 4\nimporters: {}\n', 'shrinkwrap.yaml'), {
    format: '4',
    file: 'shrinkwrap.yaml',
    features: { sharedWorkspace: true },
  })
})

test('frozen success requires identical manifest/lock bytes and installed dependency', () => {
  const good = { exitCode: 0, output: '', before: { lock: 'a' }, after: { lock: 'a' }, semantic: true }
  assert.equal(classify(good), 'pass')
  assert.equal(classify({ ...good, after: { lock: 'b' } }), 'rewrite')
  assert.equal(classify({ ...good, semantic: false }), 'semantic-mismatch')
  assert.equal(classify({ ...good, exitCode: 1, output: 'ERR_PNPM_OUTDATED_LOCKFILE' }), 'incompatible')
  assert.equal(
    classify({ ...good, exitCode: 1, output: 'ERR_PNPM_FROZEN_LOCKFILE_WITH_OUTDATED_LOCKFILE' }),
    'incompatible',
  )
  assert.equal(classify({ ...good, exitCode: 1, output: 'ECONNRESET ERR_PNPM_OUTDATED_LOCKFILE' }), 'inconclusive')
  assert.equal(classify({ ...good, exitCode: 1, output: 'unexpected crash' }), 'inconclusive')
  assert.equal(
    classify({
      ...good,
      exitCode: 1,
      output:
        'npm error EUSAGE\nnpm error The `npm ci` command can only install with an existing\nnpm error package-lock.json with lockfileVersion >= 1.',
    }),
    'incompatible',
  )
  assert.equal(classify({ ...good, exitCode: 1, output: 'npm error EUSAGE unknown option' }), 'inconclusive')
  assert.equal(classify({ ...good, exitCode: 1, output: 'Unknown option --frozen-lockfile' }), 'inconclusive')
  assert.equal(
    classify({
      ...good,
      exitCode: 1,
      output: 'error An unexpected error occurred: "Unknown token 4:1 in /tmp/project/yarn.lock".',
    }),
    'incompatible',
  )
  assert.equal(classify({ ...good, exitCode: 1, output: 'Unknown token 4:1 in /tmp/tool.js' }), 'inconclusive')
  for (const output of [
    'ERR_PNPM_BROKEN_LOCKFILE',
    'ERR_PNPM_LOCKFILE_CONFIG_MISMATCH',
    'Error: pacquet_lockfile::parse_yaml\nFailed to parse lockfile content as YAML',
    'Headless installation requires a pnpm-lock.yaml file',
  ])
    assert.equal(classify({ ...good, exitCode: 1, output }), 'incompatible')
})
test('old npm command lists without ci explicitly reject the requested frozen command', () => {
  const attempt = {
    manager: 'npm' as const,
    command: ['ci', '--ignore-scripts'],
    exitCode: 1,
    output:
      'Usage: npm <command>\n\nwhere <command> is one of:\n    cache, config, help, i, install, shrinkwrap, version\n\nnpm <command> -h quick help on <command>',
    before: { lock: 'a' },
    after: { lock: 'a' },
    semantic: false,
  }
  assert.equal(classify(attempt), 'incompatible')
  assert.equal(classify({ ...attempt, output: attempt.output.replace('cache,', 'cache, ci,') }), 'inconclusive')
  assert.equal(classify({ ...attempt, command: ['install'] }), 'inconclusive')
  assert.equal(classify({ ...attempt, output: `ENOTFOUND registry.npmjs.org\n${attempt.output}` }), 'inconclusive')
  assert.equal(classify({ ...attempt, output: 'Unknown command: "ci"' }), 'incompatible')
})
test('successful history survives retries; failed evidence remains auditable', () => {
  const pass = makeObservation({ id: 'one', key: 'combo', status: 'pass' })
  const failure = makeObservation({ id: 'two', key: 'combo', status: 'inconclusive' })
  assert.deepEqual(mergeHistory([pass], [failure, pass]), [pass, failure])
})
test('release discovery includes old branch patches, excludes already seen exact versions', () => {
  assert.deepEqual(newReleases(['10.1.0', '9.9.9', '10.2.0-rc.1'], ['10.1.0']), ['9.9.9'])
})
test('only confirmed boundaries compile, keeping last interval open and restoring OR support', () => {
  assert.equal(
    compileIntervals([
      { lower: '2.0.0', upper: '3.0.0', evidenceIds: ['a', 'b'], confirmed: true },
      { lower: '4.0.0', evidenceIds: ['c'], confirmed: true },
    ]),
    '>=2.0.0 <3.0.0 || >=4.0.0',
  )
  assert.equal(compileIntervals([{ lower: '2.0.0', evidenceIds: ['a'], confirmed: false }]), null)
  assert.throws(() => compileIntervals([{ lower: '2.0.0-beta.1', evidenceIds: ['a'], confirmed: true }]), /Invalid/)
  assert.throws(() => compileIntervals([{ lower: '4.0.0', upper: '3.0.0', evidenceIds: ['a'], confirmed: true }]))
})
test('unknown format, mismatches, and unresolved work stay red; incomplete takes exit precedence', () => {
  assert.equal(evaluate({ unknownFormats: ['new'], mismatches: [], unresolved: [], incomplete: [] }).exitCode, 1)
  assert.equal(evaluate({ unknownFormats: [], mismatches: [], unresolved: ['old'], incomplete: [] }).exitCode, 1)
  assert.equal(
    evaluate({ unknownFormats: ['new'], mismatches: [], unresolved: [], incomplete: ['network'] }).exitCode,
    2,
  )
  assert.equal(evaluate({ unknownFormats: [], mismatches: [], unresolved: [], incomplete: [] }).exitCode, 0)
})

test('legacy pnpm explicitly rejects an out-of-date manifest in frozen mode', () => {
  const attempt = {
    manager: 'pnpm' as const,
    command: ['install', '--frozen-lockfile', '--ignore-scripts'],
    exitCode: 1,
    output: 'ERROR Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not up-to-date with package.json',
    before: { lock: 'same' },
    after: { lock: 'same' },
    semantic: false,
  }
  assert.equal(classify(attempt), 'incompatible')
  const historical = {
    ...attempt,
    command: ['install', '--frozen-shrinkwrap', '--ignore-scripts'],
    output: 'ERROR Cannot install with "frozen-shrinkwrap" because shrinkwrap.yaml is not up-to-date with package.json',
  }
  assert.equal(classify(historical), 'incompatible')
  assert.equal(
    classify({ ...historical, output: 'Cannot install with "frozen-shrinkwrap" because an unknown error occurred' }),
    'inconclusive',
  )
  assert.equal(classify({ ...historical, output: `ECONNRESET\n${historical.output}` }), 'inconclusive')
  assert.equal(
    classify({ ...attempt, output: attempt.output.replace('pnpm-lock.yaml', 'shrinkwrap.yaml') }),
    'incompatible',
  )
  assert.equal(classify({ ...attempt, output: `ECONNRESET\n${attempt.output}` }), 'inconclusive')
  assert.equal(
    classify({ ...attempt, output: 'Cannot install with "frozen-lockfile" because an unknown error occurred' }),
    'inconclusive',
  )
})

test('historical pnpm headless manifest rejection is explicit incompatibility, not a generic headless failure', () => {
  const message = 'Cannot run headless installation because shrinkwrap.yaml is not up-to-date with package.json'
  const attempt = {
    manager: 'pnpm' as const,
    command: ['install', '--frozen-shrinkwrap', '--ignore-scripts'],
    exitCode: 1,
    output: `Performing headless installation\nERROR\u2009 ${message}\nat @pnpm/headless/lib/index.js:128`,
    before: { 'shrinkwrap.yaml': 'same' },
    after: { 'shrinkwrap.yaml': 'same' },
    semantic: false,
  }
  assert.equal(classify(attempt), 'incompatible')
  for (const output of [
    'Performing headless installation',
    'Cannot run headless installation because an unknown error occurred',
    'Cannot run headless installation because shrinkwrap.yaml is unreadable',
    `ECONNRESET\n${attempt.output}`,
    `Unsupported engine\n${attempt.output}`,
    `TypeError: cb.apply is not a function\nat @pnpm/headless/lib/index.js:128`,
  ])
    assert.equal(classify({ ...attempt, output }), 'inconclusive', output)
  assert.equal(classify({ ...attempt, manager: 'npm' }), 'inconclusive')
})
