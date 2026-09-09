import { formatWarning } from '../../src/warnings.js'

import { getLocale } from './i18n.js'

import type { ErrorCode, UiResult, UiTrace } from './ui-types.js'

export type { ErrorCode } from './ui-types.js'
type TextPair = readonly [string, string]
const errors: Record<ErrorCode, TextPair> = {
  network: [
    '网络请求失败，请检查连接后重新获取官方数据。',
    'Network request failed. Check the connection and refresh official data.',
  ],
  timeout: ['官方数据请求超时，请稍后重试。', 'Official data request timed out. Please retry.'],
  json: [
    '官方接口返回了无效的 JSON，无法读取版本数据。',
    'The official endpoint returned invalid JSON; version data could not be read.',
  ],
  http: ['官方接口返回 HTTP 错误，请稍后重试。', 'The official endpoint returned an HTTP error. Please retry.'],
  metadata: [
    '官方版本数据格式无效，无法完成计算。',
    'Official version metadata is invalid; calculation could not complete.',
  ],
  cancelled: ['请求已取消。', 'Request cancelled.'],
  calculation: [
    '计算未能完成，请检查输入或重新获取官方数据。',
    'Calculation could not complete. Check the inputs or refresh official data.',
  ],
}
const choose = (pair: TextPair, locale = getLocale()) => pair[locale === 'en' ? 1 : 0]
export function classifyError(detail: string): ErrorCode {
  if (/timeout|timed out/i.test(detail)) return 'timeout'
  if (/JSON/i.test(detail)) return 'json'
  if (/HTTP/i.test(detail)) return 'http'
  if (/abort|cancel/i.test(detail)) return 'cancelled'
  if (/fetch|network|load failed|connection/i.test(detail)) return 'network'
  return 'metadata'
}
export function errorText(code: ErrorCode, locale = getLocale()): string {
  return choose(errors[code], locale)
}
export class WebsiteDataError extends Error {
  constructor(
    readonly codes: ErrorCode[],
    cause: unknown,
  ) {
    super('Official metadata could not be acquired.', { cause })
    this.name = 'WebsiteDataError'
  }
}
export function failureText(error: unknown): string {
  if (error instanceof WebsiteDataError) return [...new Set(error.codes)].map((code) => errorText(code)).join(' ')
  return errorText('calculation')
}
export function warningText(warning: UiResult['warnings'][number], locale = getLocale()): string {
  return formatWarning(warning, locale === 'en' ? 'en' : 'zh-CN')
}
export function traceText(trace: UiTrace, locale = getLocale()): string {
  if (trace.warning) return formatWarning(trace.warning, locale === 'en' ? 'en' : 'zh-CN')
  if (trace.status === 'accepted')
    return choose(['与更高优先级的条件一起保留。', 'Retained with higher-priority conditions.'], locale)
  if (trace.status === 'skipped')
    return choose([`仅在选定 ${trace.manager} 时适用。`, `Applies only when ${trace.manager} is selected.`], locale)
  return trace.detail
}
export function inferenceText(inference: NonNullable<UiTrace['inference']>, locale = getLocale()): string {
  if (inference.known) {
    const ids = inference.ruleIds.join(', ')
    return choose([`随包兼容规则：${ids}。`, `Bundled compatibility rules: ${ids}.`], locale)
  }
  return choose(
    [
      '未知锁格式：保留包管理器类型，版本范围使用 *。',
      'Unknown lock format: retain manager identity with version range *.',
    ],
    locale,
  )
}
