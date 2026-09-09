export function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label}: expected an object.`)
  return value as Record<string, unknown>
}
export function optionalObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
export function errorCode(error: unknown): unknown {
  return optionalObject(error).code
}
export function timestamp(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error(`${label}: invalid timestamp.`)
}

export function declarationText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
  return JSON.stringify(value) || ''
}
export function isAbsent(value: unknown): value is null | undefined {
  return value === null || value === undefined
}
