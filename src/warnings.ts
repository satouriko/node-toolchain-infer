import type { Warning } from './types.js'

export type WarningLocale = 'en' | 'zh-CN'

const declarationReasons = {
  empty: () => ['Empty version declaration.', '版本声明为空。'],
  'unknown-manager': () => ['Unknown package manager.', '未知的包管理器。'],
  'unknown-conditional-manager': () => ['Unknown conditional package manager.', '未知的条件包管理器。'],
  'invalid-semver': (value: string) => [`Invalid semver declaration: ${value}`, `无效的 semver 声明：${value}`],
  'unresolved-alias': (value: string) => [
    `No official release resolves alias ${value}.`,
    `官方发行数据无法解析别名：${value}`,
  ],
  'invalid-compatibility-rule': (value: string) => [`Invalid compatibility rule ${value}.`, `无效的兼容规则：${value}`],
  'invalid-manager-declaration': (value: string) => [
    `Expected a package manager name or name@version: ${value}`,
    `请输入包管理器名称或名称@版本：${value}`,
  ],
  unexpected: (value: string) => [value, `无法解析版本声明：${value}`],
}
export type DeclarationReason = keyof typeof declarationReasons

function declarationMessage(reason: string, value: string, locale: WarningLocale): string {
  const render = Object.hasOwn(declarationReasons, reason)
    ? declarationReasons[reason as DeclarationReason]
    : declarationReasons.unexpected
  return render(value)[locale === 'en' ? 0 : 1]
}

export class DeclarationError extends Error {
  constructor(
    readonly reason: DeclarationReason,
    readonly value = '',
  ) {
    super(declarationMessage(reason, value, 'en'))
    this.name = 'DeclarationError'
  }
}

function define<K extends string>(
  fields: K[],
  en: (params: Record<K, string>) => string,
  zh: (params: Record<K, string>) => string,
) {
  return { fields, en, 'zh-CN': zh }
}

const definitions = {
  'runtime-unavailable': define(
    [],
    () => 'A concrete running Node version and its bound npm version are required.',
    () => '需要当前 Node 的完整版本及其绑定的 npm 版本。',
  ),
  'no-runnable-pair': define(
    [],
    () => 'Version data contains no runnable Node/package-manager pair.',
    () => '版本数据中没有可运行的 Node 与包管理器组合。',
  ),
  'prerelease-excluded': define(
    ['name', 'version'],
    (p) => `Prerelease versions are excluded: ${p.name}@${p.version}.`,
    (p) => `没有匹配的显式声明，预发布版本不参与自动推断：${p.name}@${p.version}。`,
  ),
  'invalid-declaration': define(
    ['reason', 'value'],
    (p) => declarationMessage(p.reason, p.value, 'en'),
    (p) => declarationMessage(p.reason, p.value, 'zh-CN'),
  ),
  'unknown-lock-compatibility': define(
    ['manager', 'format'],
    (p) =>
      `No bundled compatibility rule covers ${p.manager} lock format ${p.format}. The version constraint is *; the manager identity is retained.`,
    (p) => `随包规则未覆盖 ${p.manager} 锁格式 ${p.format}。版本约束使用 *，保留包管理器类型。`,
  ),
  'constraint-conflict': define(
    [],
    () =>
      'This declaration has no runnable candidate together with retained higher-priority conditions; it and its derived conditions were ignored.',
    () => '本条与更高优先级条件一起没有可运行候选；本条及其推导条件已忽略。',
  ),
  'known-package-manager-bug': define(
    ['manager', 'version', 'bugId', 'url'],
    (p) =>
      `${p.manager}@${p.version} is compatible with this lock format; known installation bug ${p.bugId} can fail the frozen-install check. ${p.url}`,
    (p) =>
      `${p.manager}@${p.version} 在语义上兼容该锁格式；已登记的安装 bug ${p.bugId} 可能导致冻结安装测试失败，不据此排除兼容性。${p.url}`,
  ),
  'preferred-version-rejected': define(
    ['manager', 'preferredVersion', 'node', 'selectedVersion'],
    (p) =>
      `${p.manager}@${p.preferredVersion} does not satisfy retained constraints with Node ${p.node}; selected ${p.selectedVersion}.`,
    (p) => `${p.manager}@${p.preferredVersion} 不满足保留条件及 Node ${p.node} 的要求；已选择 ${p.selectedVersion}。`,
  ),
  'unknown-node-requirement': define(
    ['manager', 'version'],
    (p) => `${p.manager}@${p.version} has no declared engines.node in the available metadata.`,
    (p) => `可用元数据中 ${p.manager}@${p.version} 未声明 engines.node。`,
  ),
  'git-root-read-failed': define(
    ['detail'],
    (p) => `Cannot inspect Git marker: ${p.detail}`,
    (p) => `无法检查 Git 标记：${p.detail}`,
  ),
  'git-root-not-found': define(
    [],
    () => 'No Git root was found; only the starting directory is read.',
    () => '未找到 Git 根目录；只读取起始目录。',
  ),
  'file-read-failed': define(
    ['detail'],
    (p) => `Cannot read declaration file: ${p.detail}`,
    (p) => `无法读取声明文件：${p.detail}`,
  ),
  'file-parse-failed': define(
    ['file', 'detail'],
    (p) => `Cannot parse ${p.file}: ${p.detail}`,
    (p) => `无法解析 ${p.file}：${p.detail}`,
  ),
  'stale-metadata': define(
    ['source', 'detail', 'fetchedAt'],
    (p) => `${p.source}: ${p.detail}; using cached data fetched at ${p.fetchedAt}.`,
    (p) => `${p.source} 官方数据刷新失败：${p.detail}；继续使用 ${p.fetchedAt} 获取的缓存。最大版本仅指这份数据。`,
  ),
  'missing-yarn-tag-engines': define(
    ['version'],
    (p) => `Yarn ${p.version}: official tag manifest has no engines.node; runtime requirement remains unknown.`,
    (p) => `Yarn ${p.version} 的官方 tag 清单未声明 engines.node，Node 运行要求保留为未知。`,
  ),
  'unavailable-yarn-tag-manifest': define(
    ['version', 'detail'],
    (p) => `Yarn ${p.version}: ${p.detail}; runtime requirement remains unknown.`,
    (p) => `无法获取 Yarn ${p.version} 的官方 tag 清单：${p.detail}；Node 运行要求保留为未知。`,
  ),
  'explicit-version-unavailable': define(
    ['id', 'detail'],
    (p) => `Cannot obtain metadata for explicitly requested ${p.id}: ${p.detail}`,
    (p) => `无法获取显式指定版本 ${p.id} 的元数据：${p.detail}`,
  ),
  'metadata-unavailable': define(
    ['detail'],
    (p) => `${p.detail}; inference is restricted to known local runtime candidates.`,
    (p) => `官方版本数据不可用：${p.detail}；仅使用已知的本地运行时候选进行推断。`,
  ),
  'npm-from-release-metadata': define(
    [],
    () => 'No adjacent npm installation was found; using the npm version recorded for this exact Node release.',
    () => '未找到当前 Node 相邻安装的 npm；使用官方发行数据中该 Node 版本绑定的 npm。',
  ),
}

export type WarningCode = keyof typeof definitions
export type WarningParamsByCode = {
  [C in WarningCode]: Record<(typeof definitions)[C]['fields'][number], string>
}
export type WarningContext = Omit<Warning, 'code' | 'message' | 'params'>

/** Render from code and parameters. Unknown codes or legacy payloads keep their original message. */
export function formatWarning(warning: Warning, locale: WarningLocale = 'en'): string {
  if (!Object.hasOwn(definitions, warning.code)) return warning.message
  const definition = definitions[warning.code as WarningCode]
  const params = warning.params ?? {}
  if (definition.fields.some((field) => !Object.hasOwn(params, field) || typeof params[field] !== 'string'))
    return warning.message
  const render = definition[locale] as (params: Record<string, string>) => string
  return render(params)
}

export function createWarning<C extends WarningCode>(
  code: C,
  params: WarningParamsByCode[C],
  context: WarningContext = {},
): Warning & { code: C; params: WarningParamsByCode[C] } {
  const warning = { ...context, code, params, message: '' }
  warning.message = formatWarning(warning)
  return warning
}
