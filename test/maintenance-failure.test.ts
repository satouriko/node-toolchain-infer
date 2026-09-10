import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { recordFailure } from '../maintenance/failure.js'

test('operational failure logs retain nested installer output and every retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maintenance-failure-'))
  try {
    const cause = Object.assign(new Error('install failed'), {
      stdout: 'installer output',
      stderr: 'missing dependency',
    })
    const error = new Error('bootstrap incomplete', { cause })
    const first = await recordFailure(root, 'pnpm@4.12.3', error)
    const log = await readFile(join(root, first), 'utf8')
    assert.match(log, /bootstrap incomplete/)
    assert.match(log, /install failed/)
    assert.match(log, /installer output/)
    assert.match(log, /missing dependency/)
    const second = await recordFailure(root, 'pnpm@4.12.3', new Error('network unavailable'))
    assert.notEqual(first, second)
    assert.equal(await readFile(join(root, first), 'utf8'), log)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
