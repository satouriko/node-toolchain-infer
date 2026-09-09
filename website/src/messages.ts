import { getLocale } from './i18n.js'

import type { ErrorCode, UiResult } from './ui-types.js'

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
// Translate prose only. Captured parameters are inserted once and are never passed
// through a text replacement catalog, so source values remain byte-for-byte intact.
const exact: Record<string, string> = {
  'Empty version declaration.': '版本声明为空。',
  'Unknown package manager.': '未知的包管理器。',
  'Unknown conditional package manager.': '未知的条件包管理器。',
  'A concrete running Node version and its bound npm version are required.':
    '需要当前 Node 的完整版本及其绑定的 npm 版本。',
  'Version data contains no runnable Node/package-manager pair.': '版本数据中没有可运行的 Node 与包管理器组合。',
  'Retained with higher-priority conditions.': '与更高优先级的条件一起保留。',
  'Conflicts with higher-priority conditions; ignored together with its derived Node requirements.':
    '与更高优先级条件冲突；本条及其推导的 Node 要求一起忽略。',
  'This declaration has no runnable candidate together with retained higher-priority conditions; it and its derived conditions were ignored.':
    '本条与更高优先级条件一起没有可运行候选；本条及其推导条件已忽略。',
  'Unknown lock format: retain manager identity with version range *.':
    '未知锁格式：保留包管理器类型，版本范围使用 *。',
}
const dynamic: Array<[RegExp, (...values: string[]) => string]> = [
  [
    /^Prerelease versions are excluded: (.*?)\.$/,
    (version) => `没有匹配的显式声明，预发布版本不参与自动推断：${version}。`,
  ],
  [
    /^Cannot obtain metadata for explicitly requested ([^:]+): ([\s\S]*)$/,
    (version, detail) => `无法获取显式指定版本 ${version} 的元数据：${errorText(classifyError(detail))}`,
  ],
  [
    /^([^@]+)@([^ ]+) is compatible with this lock format; known installation bug (.*?) can fail the frozen-install check\. (.*)$/,
    (manager, version, id, url) =>
      `${manager}@${version} 在语义上兼容该锁格式；已登记的安装 bug ${id} 可能导致冻结安装测试失败，不据此排除兼容性。${url}`,
  ],
  [
    /^Yarn (.*?): official tag manifest has no engines.node; runtime requirement remains unknown\.$/,
    (version) => `Yarn ${version} 的官方 tag 清单未声明 engines.node，Node 运行要求保留为未知。`,
  ],
  [/^Invalid semver declaration: ([\s\S]*)$/, (value) => `无效的 semver 声明：${value}`],
  [
    /^Expected a package manager name or name@version: ([\s\S]*)$/,
    (value) => `请输入包管理器名称或名称@版本：${value}`,
  ],
  [/^No official release resolves alias ([\s\S]*)\.$/, (value) => `官方发行数据无法解析别名：${value}`],
  [/^Invalid compatibility rule ([\s\S]*)\.$/, (value) => `无效的兼容规则：${value}`],
  [/^Applies only when (.*?) is selected\.$/, (manager) => `仅在选定 ${manager} 时适用。`],
  [/^Bundled compatibility rules: ([\s\S]*)\.$/, (ids) => `随包兼容规则：${ids}。`],
  [
    /^No bundled compatibility rule covers (.*?) lock format ([\s\S]*?)\. The version constraint is \*; the manager identity is retained\.$/,
    (manager, format) => `随包规则未覆盖 ${manager} 锁格式 ${format}。版本约束使用 *，保留包管理器类型。`,
  ],
  [
    /^([^@]+)@([^ ]+) does not satisfy retained constraints with Node (.*?); selected (.*?)\.$/,
    (manager, version, node, selected) =>
      `${manager}@${version} 不满足保留条件及 Node ${node} 的要求；已选择 ${selected}。`,
  ],
  [
    /^([^@]+)@([^ ]+) has no declared engines.node in the available metadata\.$/,
    (manager, version) => `可用元数据中 ${manager}@${version} 未声明 engines.node。`,
  ],
]
export function coreText(message: string, code?: string, locale = getLocale()): string {
  if (code === 'stale-metadata') {
    const timestamp = /; using cached data fetched at (.*?)\.$/.exec(message)?.[1]
    const date = timestamp ? new Date(timestamp).toLocaleString(locale, { hour12: false }) : ''
    return choose(
      [
        `官方数据刷新失败，继续使用已有缓存。获取时间：${date}。最大版本仅指这份数据。`,
        `Official data refresh failed; using cached metadata fetched ${date}. The maximum refers only to this data.`,
      ],
      locale,
    )
  }
  if (locale === 'en') return message
  if (Object.hasOwn(exact, message)) return exact[message]
  for (const [pattern, format] of dynamic) {
    const match = pattern.exec(message)
    if (match) return format(...match.slice(1))
  }
  return '此条件无法完成处理，请核对输入与官方数据。'
}
export function warningText(warning: UiResult['warnings'][number]): string {
  return coreText(warning.message, warning.code)
}
