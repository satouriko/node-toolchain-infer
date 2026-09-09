import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import test from 'node:test'
import { promisify } from 'node:util'
import { gzipSync } from 'node:zlib'

import { parse } from 'yaml'

const workflow = parse(await readFile(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8'))
const step = workflow.jobs.publish.steps.find((value: { id?: string }) => value.id === 'registry')
const script = step.run.match(/^node --input-type=module <<'NODE'\n([\s\S]*)\nNODE\s*$/)?.[1]
assert.ok(script, 'The publication check must have an executable Node script')

const local = gzipSync('package contents')
local[9] = 3
const published = Buffer.from(local)
published[9] = 19
const integrity = (bytes: Buffer) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`

async function checkPublication(bytes: Buffer, declaredIntegrity = integrity(bytes), status = 200) {
  const root = await mkdtemp(join(tmpdir(), 'publication-check-'))
  const output = join(root, 'output')
  try {
    await mkdir(join(root, '.cache/release'), { recursive: true })
    await writeFile(join(root, '.cache/release/node-toolchain-infer-0.1.0.tgz'), local)
    const tarball = 'https://registry.npmjs.org/node-toolchain-infer/-/node-toolchain-infer-0.1.0.tgz'
    const metadata = { name: 'node-toolchain-infer', version: '0.1.0', dist: { integrity: declaredIntegrity, tarball } }
    const responses = [
      [
        'https://registry.npmjs.org/node-toolchain-infer/0.1.0',
        Buffer.from(JSON.stringify(metadata)).toString('base64'),
        status,
      ],
      [tarball, bytes.toString('base64'), 200],
    ]
    const setup = `
const responses = new Map(${JSON.stringify(responses)}.map(([url, body, status]) => [url, { body, status }]))
globalThis.fetch = async (url) => {
  const response = responses.get(String(url))
  if (!response) throw new Error('Unexpected request: ' + url)
  return new Response(Buffer.from(response.body, 'base64'), { status: response.status })
}
`
    await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', setup + script], {
      cwd: root,
      env: { ...process.env, VERSION: '0.1.0', GITHUB_OUTPUT: output },
      timeout: 10_000,
    })
    return await readFile(output, 'utf8')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('publication retry accepts identical tar contents with different gzip OS headers', async () => {
  assert.equal(await checkPublication(published), 'publish=false\n')
})

test('publication retry rejects changed package contents', async () => {
  await assert.rejects(checkPublication(gzipSync('changed package contents')), { stderr: /Error:.*different package/ })
})

test('publication retry verifies the downloaded archive against registry integrity', async () => {
  const tampered = Buffer.from(published)
  tampered[9] = 7
  await assert.rejects(checkPublication(tampered, integrity(published)), { stderr: /Error:.*integrity/ })
})

test('publication check only permits a new release when the registry returns 404', async () => {
  assert.equal(await checkPublication(published, integrity(published), 404), 'publish=true\n')
  await assert.rejects(checkPublication(published, integrity(published), 503), { stderr: /Error:.*HTTP 503/ })
})
