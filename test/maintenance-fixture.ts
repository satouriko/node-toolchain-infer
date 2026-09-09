import { FROZEN_PROTOCOL, type Observation } from '../maintenance/model.js'

export function makeObservation(overrides: Partial<Observation> = {}): Observation {
  return {
    protocol: FROZEN_PROTOCOL,
    inputHashes: overrides.inputHashes ?? overrides.beforeHashes ?? {},
    id: 'test-receipt',
    key: 'test-key',
    manager: 'npm',
    version: '1.0.0',
    actualVersion: '1.0.0',
    node: '18.20.8',
    nodeIntegrity: 'test-node-integrity',
    toolIntegrity: 'test-tool-integrity',
    toolUrl: 'https://registry.npmjs.org/npm/-/npm-1.0.0.tgz',
    platform: 'linux',
    arch: 'x64',
    fixtureId: 'test-fixture',
    fixtureHash: 'test-fixture-hash',
    command: ['ci'],
    status: 'pass',
    exitCode: 0,
    beforeHashes: {},
    afterHashes: {},
    installed: {},
    semantic: true,
    logPath: 'test.log',
    createdAt: '2026-09-09T00:00:00.000Z',
    ...overrides,
  }
}
