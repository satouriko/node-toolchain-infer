import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { fetchCatalog } from '../src/catalog.js'
import { infer } from '../src/index.js'
import { MetadataHttpError, MetadataRequestError, requestMetadata } from '../src/metadata-request.js'

import type { CatalogEvent, Fetcher, FetchResponse } from '../src/types.js'

const pnpmUrl = 'https://registry.npmjs.org/pnpm'
const yarnUrl = 'https://repo.yarnpkg.com/releases'

function response(body: unknown, status = 200): FetchResponse {
  return { status, ok: status === 200, headers: { get: () => null }, text: () => Promise.resolve(JSON.stringify(body)) }
}

function officialResponse(url: string): FetchResponse {
  if (url.includes('nodejs.org')) return response([{ version: 'v24.10.0', npm: '11.6.1' }])
  if (url.endsWith('/tags')) return response({ tags: ['4.0.0'] })
  if (url === yarnUrl) return response({ releaseLines: { zpm: { tags: ['6.0.0'] } } })
  const name = decodeURIComponent(new URL(url).pathname.slice(1))
  let version = '4.0.0'
  if (name === 'pnpm') version = '11.17.0'
  else if (name === 'npm') version = '11.6.1'
  return response({ versions: { [version]: { name, version, engines: { node: '>=22.13' } } } })
}

test('transient source failures retry twice without refetching successful sources', async () => {
  const calls = new Map<string, number>()
  const fetcher: Fetcher = (url) => {
    const attempt = (calls.get(url) ?? 0) + 1
    calls.set(url, attempt)
    if (url === pnpmUrl && attempt < 3)
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }),
      })
    return Promise.resolve(officialResponse(url))
  }
  const catalog = await fetchCatalog({ fetcher })
  assert.equal(catalog.managers.pnpm[0].version, '11.17.0')
  assert.equal(calls.get(pnpmUrl), 3)
  assert.ok([...calls].filter(([url]) => url !== pnpmUrl).every(([, count]) => count === 1))
})

test('exhausted retries retain the source and nested transport diagnostics', async () => {
  const events: CatalogEvent[] = []
  let calls = 0
  const fetcher: Fetcher = (url) => {
    if (url !== pnpmUrl) return Promise.resolve(officialResponse(url))
    calls++
    throw new TypeError('fetch failed', {
      cause: Object.assign(new Error('connection reset by peer'), { code: 'ECONNRESET' }),
    })
  }
  await assert.rejects(fetchCatalog({ fetcher, onSource: (event) => events.push(event) }), (error: Error) => {
    assert.match(error.message, /https:\/\/registry\.npmjs\.org\/pnpm/)
    assert.match(error.message, /ECONNRESET.*connection reset by peer/)
    assert.match(error.message, /3 attempts/)
    return true
  })
  assert.equal(calls, 3)
  const failed = events.find((event) => event.id === 'pnpm' && event.status === 'error')!
  assert.equal(failed.failure?.attempts, 3)
  assert.equal(failed.failure.causes.at(-1)?.code, 'ECONNRESET')
  assert.ok(failed.failure.elapsedMs >= 0)
})

test('partial catalogs keep successful sources and report the failed source', async () => {
  const catalog = await fetchCatalog({
    allowPartial: true,
    fetcher: (url) => Promise.resolve(url === yarnUrl ? response({}, 404) : officialResponse(url)),
  })
  assert.equal(catalog.nodes[0].version, '24.10.0')
  assert.equal(catalog.managers.pnpm[0].version, '11.17.0')
  assert.equal(catalog.sources.length, 7)
  assert.equal(catalog.warnings[0].code, 'metadata-source-unavailable')
  assert.equal(catalog.warnings[0].path, yarnUrl)
  assert.equal(catalog.warnings[0].requestFailures?.[0].status, 404)
})

test('infer fetches only Node and pnpm for a pnpm project', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'nti-partial-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  await mkdir(join(cwd, '.git'))
  await writeFile(join(cwd, 'package.json'), JSON.stringify({ packageManager: 'pnpm@11.17.0' }))
  const requests: string[] = []
  const result = await infer({
    cwd,
    runtime: { node: '24.10.0', npm: '11.6.1', pnpm: '10.34.5' },
    fetcher: (url) => {
      requests.push(url)
      return Promise.resolve(url === yarnUrl ? response({}, 404) : officialResponse(url))
    },
  })
  assert.equal(result.packageManager?.version, '11.17.0')
  assert.equal(result.packageManager.reason, 'exact')
  assert.deepEqual(requests.sort(), ['https://nodejs.org/dist/index.json', pnpmUrl].sort())
  assert.equal(result.warnings.length, 0)
})

test('cancelling one consumer does not cancel another consumer of a shared request', async () => {
  const controller = new AbortController()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const calls: AbortSignal[] = []
  const fetcher: Fetcher = async (url, options) => {
    calls.push(options.signal!)
    await gate
    assert.equal(options.signal?.aborted, false)
    return officialResponse(url)
  }
  const first = fetchCatalog({ fetcher, signal: controller.signal })
  const firstRejected = assert.rejects(first, /cancel first/)
  const second = fetchCatalog({ fetcher })
  controller.abort(new Error('cancel first'))
  await firstRejected
  release()
  assert.equal((await second).sources.length, 8)
  assert.equal(calls.length, 8)
})

test('cancelling all consumers aborts pending requests without retrying', async () => {
  const controller = new AbortController()
  const signals: AbortSignal[] = []
  const fetcher: Fetcher = async (_url, options) => {
    signals.push(options.signal!)
    return new Promise((_resolve, reject) => {
      options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true })
    })
  }
  const result = fetchCatalog({ fetcher, signal: controller.signal })
  const rejected = assert.rejects(result, /cancel all/)
  controller.abort(new Error('cancel all'))
  await rejected
  assert.equal(signals.length, 8)
  assert.ok(signals.every((signal) => signal.aborted))
})

test('permanent HTTP, certificate and parse failures are not retried', async () => {
  const failures = [
    () => response({}, 404),
    () => {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('expired'), { code: 'CERT_HAS_EXPIRED' }) })
    },
    () => ({ ...response({}), text: () => Promise.resolve('{invalid json') }),
  ]
  for (const fail of failures) {
    let calls = 0
    await assert.rejects(
      fetchCatalog({
        fetcher: (url) => {
          if (url !== pnpmUrl) return Promise.resolve(officialResponse(url))
          calls++
          return Promise.resolve(fail())
        },
      }),
    )
    assert.equal(calls, 1)
  }
})

test('rate limits and service outages retry at most three times', async () => {
  for (const status of [429, 503]) {
    let calls = 0
    const catalog = await fetchCatalog({
      allowPartial: true,
      fetcher: (url) => {
        if (url !== pnpmUrl) return Promise.resolve(officialResponse(url))
        calls++
        return Promise.resolve(response({}, status))
      },
    })
    assert.equal(calls, 3)
    assert.equal(catalog.warnings[0].requestFailures?.[0].status, status)
  }
})

test('a transport failure while reading the body retries that source', async () => {
  let calls = 0
  const catalog = await fetchCatalog({
    fetcher: (url) => {
      if (url !== pnpmUrl || ++calls !== 1) return Promise.resolve(officialResponse(url))
      return Promise.resolve({
        ...response({}),
        text: () => Promise.reject(Object.assign(new Error('body interrupted'), { code: 'UND_ERR_SOCKET' })),
      })
    },
  })
  assert.equal(calls, 2)
  assert.equal(catalog.managers.pnpm[0].version, '11.17.0')
})

test('the total deadline aborts a hanging response body', async () => {
  const controller = new AbortController()
  let requestSignal: AbortSignal | undefined
  let calls = 0
  await assert.rejects(
    requestMetadata(
      { id: 'pnpm', url: pnpmUrl },
      async (signal) => {
        calls++
        requestSignal = signal
        return new Promise(() => {})
      },
      controller.signal,
      25,
    ),
    (error: unknown) => {
      assert.ok(error instanceof MetadataRequestError)
      assert.equal(error.failure.causes[0].name, 'TimeoutError')
      assert.equal(error.failure.attempts, 1)
      return true
    },
  )
  assert.equal(calls, 1)
  assert.equal(requestSignal?.aborted, true)
})

test('Retry-After stays within the total deadline and preserves the HTTP failure', async () => {
  let calls = 0
  await assert.rejects(
    requestMetadata(
      { id: 'pnpm', url: pnpmUrl },
      () => {
        calls++
        throw new MetadataHttpError(429, '60')
      },
      new AbortController().signal,
      25,
    ),
    (error: unknown) => {
      assert.ok(error instanceof MetadataRequestError)
      assert.equal(error.failure.status, 429)
      assert.ok(error.failure.causes.some((cause) => cause.name === 'TimeoutError'))
      return true
    },
  )
  assert.equal(calls, 1)
})

test('cancelling during backoff prevents another attempt', async () => {
  const controller = new AbortController()
  let calls = 0
  const pending = requestMetadata(
    { id: 'pnpm', url: pnpmUrl },
    () => {
      calls++
      throw new MetadataHttpError(503)
    },
    controller.signal,
  )
  const rejected = assert.rejects(pending, /cancel backoff/)
  await new Promise((resolve) => {
    setTimeout(resolve, 20)
  })
  controller.abort(new Error('cancel backoff'))
  await rejected
  assert.equal(calls, 1)
})

test('HTTP retries close unfinished response bodies before starting another attempt', async (t) => {
  let opened = 0
  let closed = 0
  const server = createServer((_request, reply) => {
    opened++
    reply.on('close', () => {
      closed++
    })
    reply.writeHead(503, { 'Content-Type': 'application/json' })
    reply.write('{')
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const localUrl = `http://127.0.0.1:${address.port}`
  const releases: Array<Promise<void>> = []
  await fetchCatalog({
    allowPartial: true,
    fetcher: async (url, options) => {
      if (url !== pnpmUrl) return officialResponse(url)
      assert.equal(closed, opened, 'the previous HTTP body must be released before retrying')
      releases.push(
        new Promise((resolve) => {
          options.signal!.addEventListener('abort', () => resolve(), { once: true })
        }),
      )
      return fetch(localUrl, options)
    },
  })
  await Promise.race([
    Promise.all(releases),
    new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error('HTTP requests were left open')), 1000)
    }),
  ])
  assert.equal(opened, 3)
})
