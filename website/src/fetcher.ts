import type { Fetcher } from '../../src/types.js'

/** Let the browser revalidate its HTTP cache without adding CORS preflight request headers. */
export const browserMetadataFetcher: Fetcher = (url, options) =>
  fetch(url, {
    signal: options.signal,
    headers: { Accept: 'application/json' },
    cache: 'no-cache',
  })
