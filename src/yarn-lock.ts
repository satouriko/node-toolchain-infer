import { parse as parseYaml } from 'yaml'

import { object, optionalObject } from './validation.js'

export interface YarnLock {
  family: 'classic' | 'berry' | 'zpm'
  format?: string | number
  cacheKey?: string | number
  error?: Error
}

/** Yarn's native JSON and Berry YAML locks can use the same metadata version. */
export function readYarnLock(content: string): YarnLock {
  if (/^# yarn lockfile v1\s*$/m.test(content)) return { family: 'classic', format: 1 }
  const text = content.trimStart()
  const lock: YarnLock = { family: text.startsWith('{') ? 'zpm' : 'berry' }
  try {
    const data = object(lock.family === 'zpm' ? JSON.parse(text) : parseYaml(text), 'yarn.lock')
    const metadata = optionalObject(data.__metadata)
    if (typeof metadata.version === 'string' || typeof metadata.version === 'number') lock.format = metadata.version
    if (typeof metadata.cacheKey === 'string' || typeof metadata.cacheKey === 'number')
      lock.cacheKey = metadata.cacheKey
  } catch (error) {
    lock.error = error instanceof Error ? error : new Error(String(error))
  }
  return lock
}
