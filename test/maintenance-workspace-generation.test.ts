import assert from 'node:assert/strict'
import test from 'node:test'

import { pnpmGenerationPlan } from '../maintenance/generate-fixtures.js'
import { frozenArgs } from '../maintenance/runner.js'

import type { Fixture } from '../maintenance/model.js'

const fixture: Fixture = {
  id: 'shared',
  manager: 'pnpm',
  version: '2.25.7',
  directory: 'shared',
  lock: 'shrinkwrap.yaml',
  match: { format: '4', features: { sharedWorkspace: true } },
  dependencies: {},
}

test('shared workspace generation preserves declared input shape across the official option rename', () => {
  for (const version of ['2.25.7', '3.0.0-alpha.2', '3.0.0-alpha.3', '3.0.0', '9.15.9']) {
    const option = ['2.25.7', '3.0.0-alpha.2'].includes(version)
      ? 'shared-workspace-shrinkwrap'
      : 'shared-workspace-lockfile'
    assert.deepEqual(pnpmGenerationPlan({ ...fixture, version }), {
      command: ['install', '--ignore-scripts', `--${option}`],
      files: { '.npmrc': `${option}=true\n`, 'pnpm-workspace.yaml': 'packages:\n  - packages/*\n' },
    })
    assert.ok(frozenArgs('pnpm', version).every((arg) => !arg.includes('shared-workspace')))
  }
})

test('ordinary pnpm generation does not silently enable workspace generation', () => {
  for (const match of [{ format: '3' }, { format: '3', features: { sharedWorkspace: false } }])
    assert.deepEqual(pnpmGenerationPlan({ ...fixture, match }), {
      command: ['install', '--ignore-scripts'],
      files: {},
    })
})
