import { errorMessage } from './validation.js'

import type { MetadataRequestFailure } from './types.js'

const retryableCodes = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
])
const retryableStatuses = new Set([429, 500, 502, 503, 504])

function causesOf(error: unknown): MetadataRequestFailure['causes'] {
  const causes: MetadataRequestFailure['causes'] = []
  const seen = new Set<unknown>()
  const visit = (value: unknown) => {
    if (seen.has(value) || causes.length >= 16) return
    seen.add(value)
    const item = value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
    causes.push({
      name: typeof item.name === 'string' ? item.name : 'Error',
      message: errorMessage(value),
      ...(typeof item.code === 'string' ? { code: item.code } : {}),
    })
    if (item.cause !== undefined) visit(item.cause)
    if (Array.isArray(item.errors)) for (const nested of item.errors) visit(nested)
  }
  visit(error)
  return causes
}

export class MetadataHttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfter: string | null = null,
  ) {
    super(`HTTP ${status}`)
    this.name = 'MetadataHttpError'
  }
}

export class MetadataRequestError extends Error {
  constructor(
    readonly failure: MetadataRequestFailure,
    cause: unknown,
  ) {
    const detail = failure.causes.map((item) => `${item.code ? `${item.code}: ` : ''}${item.message}`).join(' -> ')
    super(`${failure.sourceId} (${failure.url}): ${detail} (${failure.attempts} attempts, ${failure.elapsedMs} ms)`, {
      cause,
    })
    this.name = 'MetadataRequestError'
  }
}

function retryable(error: unknown): boolean {
  if (error instanceof MetadataHttpError) return retryableStatuses.has(error.status)
  const causes = causesOf(error)
  const codes = causes.flatMap((cause) => (cause.code ? [cause.code] : []))
  // A generic fetch error must not hide a permanent TLS or other transport failure.
  if (codes.length) return codes.every((code) => retryableCodes.has(code))
  return causes.some(
    (cause) =>
      cause.name === 'TimeoutError'
      || (cause.name === 'TypeError' && /fetch failed|failed to fetch|networkerror|load failed/i.test(cause.message)),
  )
}

export function withSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort)
      reject(signal.reason)
    }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      },
    )
    if (signal.aborted) abort()
  })
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>
    const abort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, ms)
    signal.addEventListener('abort', abort, { once: true })
  })
}

/** Three attempts share one deadline, including response bodies and backoff. */
export async function requestMetadata<T>(
  source: { id: string; url: string },
  request: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
  timeoutMs = 20_000,
): Promise<T> {
  if (signal.aborted) throw signal.reason
  const started = Date.now()
  const controller = new AbortController()
  const abort = () => controller.abort(signal.reason)
  signal.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(
    () => controller.abort(new DOMException('Metadata request deadline exceeded', 'TimeoutError')),
    timeoutMs,
  )
  let attempts = 0
  let failure: unknown
  let interruption: unknown
  const attempt = async () => {
    controller.signal.throwIfAborted()
    const active = new AbortController()
    const cancel = () => active.abort(controller.signal.reason)
    controller.signal.addEventListener('abort', cancel, { once: true })
    try {
      return await withSignal(request(active.signal), active.signal)
    } finally {
      controller.signal.removeEventListener('abort', cancel)
      // An HTTP error may leave an unread body. Release it before another attempt.
      active.abort()
    }
  }
  try {
    while (attempts < 3) {
      attempts++
      try {
        return await attempt()
      } catch (error) {
        failure = error
        if (controller.signal.aborted || attempts === 3 || !retryable(error)) break
        let wait = (attempts === 1 ? 200 : 800) * (0.8 + Math.random() * 0.4)
        if (error instanceof MetadataHttpError && error.retryAfter) {
          const seconds = Number(error.retryAfter)
          const retryAfter = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(error.retryAfter) - Date.now()
          if (Number.isFinite(retryAfter)) wait = Math.max(wait, retryAfter)
        }
        try {
          await delay(wait, controller.signal)
        } catch (waitError) {
          interruption = waitError
          break
        }
      }
    }
    signal.throwIfAborted()
    throw new MetadataRequestError(
      {
        sourceId: source.id,
        url: source.url,
        attempts,
        elapsedMs: Date.now() - started,
        ...(failure instanceof MetadataHttpError ? { status: failure.status } : {}),
        causes: [...causesOf(failure), ...(interruption === undefined ? [] : causesOf(interruption))],
      },
      failure,
    )
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
  }
}
