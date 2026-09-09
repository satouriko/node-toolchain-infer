import semver from 'semver'

import { CATALOG_SOURCES, emptyCatalog, fetchOfficialCatalog } from './catalog.js'
import { getLocale, installLocale, translate } from './i18n.js'
import { type LockfileFact, lockfileFacts, lockfilesForVersion } from './lockfile-facts.js'
import { classifyError, errorText, failureText, inferenceText, traceText, warningText } from './messages.js'
import { installTabs } from './navigation.js'
import { resolveLive } from './resolve-live.js'
import { EMPTY_FIELDS, SOURCES } from './schema.js'

import type { InputState, SourceReceipt, UiCatalog, UiResult } from './ui-types.js'
import type { KnownBug } from '../../src/types.js'

const $ = <T extends HTMLElement = HTMLInputElement>(selector: string): T => {
  const element = document.querySelector<T>(selector)
  if (!element) throw new Error(`Missing UI element: ${selector}`)
  return element
}
const escape = (value: string | number | null | undefined) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  )
const raw = (value: string | number | null | undefined) => `<span data-i18n-ignore>${escape(value)}</span>`
const clone = <T>(value: T): T => structuredClone(value)
const storageKey = 'node-toolchain-infer:calculator:v1'
const initialRuntime: Record<string, string> = { node: '24.10.0', npm: '11.6.1', pnpm: '10.21.0', yarn: '1.22.22' }
const defaultState: InputState = {
  runtime: clone(initialRuntime),
  fields: { ...EMPTY_FIELDS, enginesNode: '18', yarnLockFamily: 'berry' },
  searchDepth: 3,
  additional: [],
}
const directorySources = SOURCES.filter((s) => s.group !== 'remote')
let state: InputState
try {
  const saved = JSON.parse(localStorage.getItem(storageKey) || 'null') as Partial<InputState> | null
  state =
    saved?.runtime && saved.fields
      ? {
          runtime: { ...initialRuntime, ...saved.runtime },
          fields: {
            ...EMPTY_FIELDS,
            ...saved.fields,
            yarnLockFamily: saved.fields.yarnLockFamily === 'zpm' ? 'zpm' : 'berry',
          },
          searchDepth: saved.searchDepth ?? 3,
          additional: (saved.additional || []).filter((r) => directorySources.some((s) => s.key === r.key)),
        }
      : clone(defaultState)
} catch {
  state = clone(defaultState)
}
let catalog: UiCatalog = emptyCatalog()
let catalogPromise: Promise<UiCatalog> | null = null
let catalogFailed = false
let calculationError: unknown = null
let calculationSerial = 0
let calculationAbort: AbortController | null = null
const sourceReceipts = new Map<string, SourceReceipt>(
  CATALOG_SOURCES.map((source: Omit<SourceReceipt, 'status'>) => [source.id, { ...source, status: 'waiting' }]),
)
let savedFacts: { kind?: string; query?: string; page?: number } = {}
try {
  savedFacts = JSON.parse(localStorage.getItem('node-toolchain-infer:facts') || '{}') || {}
} catch {}
let factKind: string = ['node', 'npm', 'pnpm', 'yarn'].includes(savedFacts.kind || '') ? savedFacts.kind! : 'node'
let factPage = Number.isInteger(savedFacts.page) && savedFacts.page! >= 0 ? savedFacts.page! : 0
let factQuery = typeof savedFacts.query === 'string' ? savedFacts.query : ''
function persistFacts() {
  try {
    localStorage.setItem(
      'node-toolchain-infer:facts',
      JSON.stringify({ kind: factKind, page: factPage, query: factQuery }),
    )
  } catch {}
}
let result: UiResult | null = null
let toastTimer: ReturnType<typeof setTimeout>
let debounceTimer: ReturnType<typeof setTimeout>
let currentPreset =
  state.fields.enginesNode === '18' && Object.values(state.fields).filter(Boolean).length === 1 ? 'node18' : null

const PRESETS: Array<{ id: string; label: string; fields: Record<string, string>; runtime: Record<string, string> }> = [
  { id: 'node18', label: '切换到 Node 18', fields: { enginesNode: '18' }, runtime: initialRuntime },
  {
    id: 'current',
    label: '范围内保留当前版本',
    fields: { enginesNode: '18' },
    runtime: { ...initialRuntime, node: '18.17.0', npm: '9.6.7' },
  },
  {
    id: 'remote',
    label: '调用方输入覆盖项目声明',
    fields: { remoteNode: '20', remotePackageManager: 'pnpm@10', packageManager: 'npm@11.6.1', voltaNode: '18.20.8' },
    runtime: initialRuntime,
  },
  {
    id: 'derived',
    label: '包管理器推导 Node 冲突',
    fields: { packageManager: 'npm@11.6.1', voltaNode: '18.20.8' },
    runtime: initialRuntime,
  },
  {
    id: 'lock',
    label: 'pnpm 锁文件推断',
    fields: { pnpmLock: '9.0', npmLock: '2', enginesNode: '>=18 <23' },
    runtime: initialRuntime,
  },
  { id: 'empty', label: '无声明兜底', fields: {}, runtime: initialRuntime },
]
const groups = [
  {
    name: 'remote',
    title: '调用方输入 input',
    priority: '01–02',
    description: '最高优先级 · 接受任意合法 semver 范围',
    note: '18、18.20 是合法范围；也接受 ^、~、>=、*、|| 和连字符范围。18.20.8 是单一版本。包管理器填写名称@范围，单独 pnpm 仅指定类型。',
    open: true,
  },
  {
    name: 'project',
    title: 'packageManager',
    priority: '03',
    description: '项目对包管理器的显式声明',
    note: '完整版本及 Corepack 的 +sha… 摘要可直接填写；范围输入也可用于模拟。',
    open: true,
  },
  {
    name: 'lock',
    title: '锁文件',
    priority: '04–08',
    description: '同目录存在多个文件时，按编号解决冲突',
    note: '填写 lockfileVersion；旧版 pnpm 的 shrinkwrap.yaml 填 shrinkwrapVersion；Yarn Classic 填 v1，Berry YAML 填 __metadata.version，Yarn 6+ JSON 填 metadata.version 并选择对应文件族。不读取 node_modules 内的隐藏锁文件。',
    open: true,
  },
  {
    name: 'other',
    title: '其他项目声明',
    priority: '09–16',
    description: '同目录内 Volta 在先；跨目录先比较距离',
    note: 'devEngines 按 name=node 的 runtime、按 name@version 的 packageManager 填写。engines 中仅选定包管理器的字段参与计算。',
    open: true,
  },
]
const stateLabel: Record<string, string> = {
  accepted: '已保留',
  ignored: '已忽略',
  invalid: '格式无效',
  skipped: '不适用',
}
const kindLabel: Record<string, string> = { exact: '具体值', range: '范围', inferred: '锁文件推断', type: '仅类型' }
const reasonLabel: Record<string, string> = {
  exact: '采用具体声明',
  current: '保留当前版本',
  maximum: '范围内最大版本',
  bundled: '绑定的 npm',
  local: '采用本地版本',
}

function toast(message: string) {
  $('#toast').textContent = message
  $('#toast').hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    $('#toast').hidden = true
  }, 3600)
}
function persist() {
  try {
    localStorage.setItem(storageKey, JSON.stringify(state))
  } catch {}
}
function download(name: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
function renderStatic() {
  $('#search-depth').value = String(state.searchDepth)
  $('#directory-priority').innerHTML = directorySources
    .filter((s) => !['enginesPnpm', 'enginesYarn'].includes(s.key))
    .map((s) => {
      const fromPackage = s.label.startsWith('package.json.') || s.key.startsWith('dev')
      let label = s.label.replace(/^package\.json\./, '')
      if (s.key === 'enginesNpm') label = 'engines.npm / pnpm / yarn'
      if (s.key === 'devRuntime') label = 'devEngines.runtime'
      let kind = 'range'
      if (s.target === 'lock') kind = 'inferred'
      let caption = ''
      if (s.key === 'enginesNpm') caption = '<small>仅选定包管理器的字段生效</small>'
      if (s.key === 'devRuntime') caption = '<small>name=node 的 version</small>'
      const type = { inferred: '逐版筛选', exact: '具体值', range: '值 / 范围' }[kind]
      return `<div class="directory-source-row"><b class="rank-token">${String(s.rank).padStart(2, '0')}</b><div>${fromPackage ? '<small>package.json</small>' : ''}<code data-i18n-ignore>${escape(label)}</code>${caption}</div><span class="tag ${kind}">${type}</span></div>`
    })
    .join('')
  $('#presets').innerHTML = PRESETS.map(
    (p) => `<button class="preset ${currentPreset === p.id ? 'active' : ''}" data-preset="${p.id}">${p.label}</button>`,
  ).join('')
  $('#runtime-fields').innerHTML = [
    ['node', '当前进程的 Node', '必填 · 完整版本'],
    ['npm', '该 Node 发行版绑定的 npm', '官方发行记录 · 自动显示'],
    ['pnpm', '本地 pnpm', '可留空 · 表示未安装'],
    ['yarn', '本地 Yarn', '可留空 · 表示未安装'],
  ]
    .map(
      ([key, label, caption]) =>
        `<label class="field"><span class="field-label">${label}<span class="tag fallback">${key === 'npm' ? '只读' : '候选'}</span></span><input data-runtime="${key}" value="${escape(state.runtime[key])}" ${key === 'npm' ? 'readonly placeholder="由 Node 版本自动确定"' : `list="${key}-versions"`} autocomplete="off" spellcheck="false" aria-label="${label}"><span class="field-caption">${caption}</span></label>`,
    )
    .join('')
  $('#source-fields').innerHTML = groups
    .map(
      (group) =>
        `<details class="form-panel" ${group.open ? 'open' : ''}><summary><div class="summary-left"><span class="group-index">${group.priority}</span><div><h3>${group.title}</h3><p class="group-meta">${group.description}</p></div></div><span class="chevron">⌄</span></summary><div class="details-content"><div class="source-fields-grid">${SOURCES.filter(
          (s) => s.group === group.name,
        )
          .map(
            (s) =>
              `<label class="field ${group.name === 'remote' || group.name === 'project' ? 'full' : ''}"><span class="field-label"><code><span style="color:#a6b4c7">${String(s.rank).padStart(2, '0')} </span>${escape(s.label)}</code><span class="field-state" data-state="${s.key}"></span></span><input data-field="${s.key}" value="${escape(state.fields[s.key])}" placeholder="${escape(s.placeholder)}" ${s.target === 'lock' ? `list="${s.manager}-formats"` : ''} autocomplete="off" spellcheck="false" aria-label="${escape(s.label)}"></label>`,
          )
          .join(
            '',
          )}</div>${group.name === 'lock' ? `<div class="lock-options"><label class="lock-family-field"><span>当前目录的 yarn.lock 文件族</span><select data-yarn-lock-family aria-label="当前目录的 yarn.lock 文件族"><option value="berry" ${state.fields.yarnLockFamily !== 'zpm' ? 'selected' : ''}>Yarn Berry YAML（&gt;=2 &lt;6）</option><option value="zpm" ${state.fields.yarnLockFamily === 'zpm' ? 'selected' : ''}>Yarn 6+ JSON（ZPM）</option></select></label><label class="lock-feature"><input type="checkbox" data-lock-importers ${state.fields.pnpmShrinkwrapImporters === 'true' ? 'checked' : ''}><span>当前目录的 shrinkwrap.yaml 包含 importers（共享 workspace）</span></label></div>` : ''}<p class="group-note">${group.note}</p></div></details>`,
    )
    .join('')
  renderAdditional()
  renderCatalog()
  renderSources()
}
function renderAdditional() {
  $('#additional-fields').innerHTML = state.additional
    .map(
      (row, index) =>
        `<div class="additional-row"><label>来源<select data-extra="${index}" data-prop="key" aria-label="第 ${index + 1} 条重复声明的来源">${directorySources.map((s) => `<option value="${s.key}" ${row.key === s.key ? 'selected' : ''}>${String(s.rank).padStart(2, '0')} ${escape(s.label)}</option>`).join('')}</select></label><label>上级层数<input type="number" min="0" step="1" data-extra="${index}" data-prop="depth" value="${row.depth}" aria-label="第 ${index + 1} 条声明的目录层数"></label><label>声明值<input data-extra="${index}" data-prop="value" value="${escape(row.value)}" placeholder="18 / >=20" spellcheck="false" aria-label="第 ${index + 1} 条声明值"></label><button class="remove-row" data-remove-source="${index}" aria-label="删除第 ${index + 1} 条声明">×</button><span class="additional-badge" data-extra-state="${index}"></span>${row.key === 'pnpmShrinkwrap' ? `<label class="additional-feature"><input type="checkbox" data-extra="${index}" data-prop="sharedWorkspace" ${row.sharedWorkspace === true ? 'checked' : ''}><span>此声明的 shrinkwrap.yaml 包含 importers（共享 workspace）</span></label>` : ''}${row.key === 'yarnLock' ? `<label class="additional-family-field"><span>此声明的 yarn.lock 文件族</span><select data-extra="${index}" data-prop="yarnFamily" aria-label="第 ${index + 1} 条声明的 yarn.lock 文件族"><option value="berry" ${row.yarnFamily !== 'zpm' ? 'selected' : ''}>Yarn Berry YAML（&gt;=2 &lt;6）</option><option value="zpm" ${row.yarnFamily === 'zpm' ? 'selected' : ''}>Yarn 6+ JSON（ZPM）</option></select></label>` : ''}</div>`,
    )
    .join('')
}
function sourceStatus(source: SourceReceipt): string {
  if (source.status === 'ready') return `已获取 ${source.count ?? 0} 个版本`
  if (source.status === 'stale') return '刷新失败，使用已有缓存'
  if (source.status === 'error') return '获取失败'
  if (source.status === 'loading') return '正在读取…'
  return '等待读取'
}
function renderSources() {
  $('#source-receipts').innerHTML = [...sourceReceipts.values()]
    .map((source) => {
      let detail = '直接由浏览器请求，不经过数据代理。'
      if (source.fetchedAt)
        detail = `获取时间：${new Date(source.fetchedAt).toLocaleString(getLocale(), { hour12: false })}`
      if (source.errorCode) detail = errorText(source.errorCode)
      return `<div class="live-source ${source.status}" data-source-id="${escape(source.id)}"><div><b>${escape(source.name)}</b><span class="source-fetch-state">${sourceStatus(source)}</span></div><a data-i18n-ignore href="${source.url}" target="_blank" rel="noreferrer">${source.url} ↗</a><p>${escape(source.fields)}</p><small>${escape(detail)}</small></div>`
    })
    .join('')
  const baseSources = CATALOG_SOURCES.map((source) => sourceReceipts.get(source.id)!)
  const ready = baseSources.filter((source) => source.status === 'ready').length
  const failed = baseSources.filter((source) => source.status === 'error').length
  const stale = baseSources.some((source) => source.status === 'stale')
  let status = `读取官方数据 ${ready} / ${CATALOG_SOURCES.length}`
  if (ready === CATALOG_SOURCES.length) status = '官方数据已获取'
  if (stale) status = '刷新失败，使用已有缓存'
  if (failed) status = `${failed} 个来源失败，停止输出最终版本`
  $('#data-status').textContent = status
}
async function ensureCatalog(force = false): Promise<UiCatalog> {
  if (catalogPromise) return catalogPromise
  if (!force && !catalogFailed && catalog.generatedAt && Date.now() - Date.parse(catalog.generatedAt) < 60000)
    return catalog
  $('#refresh-data').disabled = true
  catalogFailed = false
  catalogPromise = fetchOfficialCatalog({
    onSource: (source: SourceReceipt) => {
      sourceReceipts.set(source.id, source)
      renderSources()
    },
  })
    .then((value: UiCatalog) => {
      catalog = value
      renderCatalog()
      return catalog
    })
    .catch((error: unknown) => {
      catalogFailed = true
      throw error
    })
    .finally(() => {
      catalogPromise = null
      $('#refresh-data').disabled = false
    })
  return catalogPromise
}
function renderCatalog() {
  const lists = { node: catalog.nodes, ...catalog.managers }
  const counts = Object.entries(lists)
    .map(
      ([name, items]) =>
        `<div class="catalog-stat"><strong>${items.length.toLocaleString(getLocale())}</strong><span>${name === 'node' ? 'Node' : name} 个稳定版本</span></div>`,
    )
    .join('')
  $('#catalog-stats').innerHTML = counts
  const date = new Date(catalog.generatedAt || 0)
  $('#data-date').textContent = catalog.generatedAt
    ? `最近获取 ${date.toLocaleTimeString(getLocale(), { hour12: false })}`
    : '正在连接官方来源'
  for (const [name, items] of Object.entries(lists)) {
    $(`#${name}-versions`).innerHTML = [...items]
      .sort((a, b) => semver.rcompare(a.version, b.version))
      .map(
        (v) =>
          `<option value="${escape(v.version)}">${name === 'node' && v.npm ? `npm ${escape(v.npm)}` : ''}</option>`,
      )
      .join('')
  }
  renderFacts()
}
const formatName = (fact: LockfileFact) => {
  let family = ''
  if (fact.manager === 'yarn') family = fact.match.classic ? 'Classic ' : 'Berry YAML '
  return `${fact.match.file} · ${family}${fact.match.format}${fact.match.features ? ` · ${JSON.stringify(fact.match.features)}` : ''}`
}
let openFactDetails = new Set<string>()
const factDetails = (id: string) => `data-fact-details="${escape(id)}" ${openFactDetails.has(id) ? 'open' : ''}`
function renderBugs(bugs: KnownBug[], id: string) {
  return bugs.length
    ? `<details class="fact-bugs" ${factDetails(id)}><summary><span>已知安装 bug <b class="fact-bug-count">${raw(bugs.length)}</b></span><span class="chevron">⌄</span></summary><div class="fact-bug-list">${bugs.map((bug) => `<div class="fact-bug-item"><div class="fact-bug-meta"><code data-i18n-ignore>${escape(bug.id)}</code><code data-i18n-ignore>${escape(bug.range)}</code></div><p>${raw(translate(bug.reason))}</p><a href="${escape(bug.url)}" target="_blank" rel="noreferrer">相关记录 ↗</a></div>`).join('')}</div></details>`
    : '<span>无已登记 bug</span>'
}
function renderLockfileMappings() {
  const facts = factKind === 'node' ? lockfileFacts : lockfileFacts.filter((fact) => fact.manager === factKind)
  $('#lockfile-generated-at').textContent = lockfileFacts[0].generatedAt
  $('#lockfile-fact-rows').innerHTML = facts
    .map(
      (fact) =>
        `<tr data-format-id="${escape(fact.id)}"><td>${raw(fact.manager)}<br>${raw(formatName(fact))}</td><td><code data-i18n-ignore>${escape(fact.range ?? '*')}</code><br><span>${fact.compiled ? '随包兼容范围' : '未知 · 不限制版本，不代表支持'}</span></td><td>${renderBugs(fact.knownBugs ?? [], fact.id)}</td><td>${raw(fact.source)}<br><span>${fact.compiled ? '随包编译规则' : '样例格式目录 · 无编译规则'}</span></td></tr>`,
    )
    .join('')
}
function renderFacts() {
  openFactDetails = new Set(
    [...document.querySelectorAll<HTMLElement>('[data-fact-details][open]')].map(
      (element) => element.dataset.factDetails!,
    ),
  )
  renderLockfileMappings()
  $('#fact-lockfile-heading').hidden = factKind === 'node'
  const records = (factKind === 'node' ? catalog.nodes : catalog.managers[factKind])
    .filter(
      (r) => r.version.includes(factQuery) || String(factKind === 'node' ? r.npm || '' : r.node).includes(factQuery),
    )
    .sort((a, b) => semver.rcompare(a.version, b.version))
  const pageSize = 15
  const pages = Math.max(1, Math.ceil(records.length / pageSize))
  if (catalog.generatedAt) factPage = Math.min(factPage, pages - 1)
  persistFacts()
  const current = records.slice(factPage * pageSize, (factPage + 1) * pageSize)
  $('#fact-version-heading').textContent = `${factKind === 'node' ? 'Node' : factKind} 版本`
  $('#fact-requirement-heading').textContent =
    factKind === 'node' ? '绑定的 npm 版本' : '要求的 Node 范围（engines.node）'
  $('#fact-rows').innerHTML = current.length
    ? current
        .map((r) => {
          let requirement =
            r.runtime === 'native'
              ? translate('原生程序，无宿主 Node 要求')
              : (r.node ?? translate('未声明 engines.node'))
          if (factKind === 'node') requirement = r.npm || translate('发行索引未记录')
          const sourceUrl = r.sourceUrl ?? `https://registry.npmjs.org/${factKind}`
          let url = sourceUrl
          if (factKind === 'node') url = 'https://nodejs.org/dist/index.json'
          else if (sourceUrl.startsWith('https://registry.npmjs.org/'))
            url = `${sourceUrl}/${encodeURIComponent(r.version)}`
          const matches =
            factKind === 'node'
              ? null
              : lockfilesForVersion(factKind, r.version, r.runtime === 'native' ? 'zpm' : undefined)
          const lockfiles = matches
            ? `<td class="fact-lockfiles">${matches.compatible.length ? matches.compatible.map((fact) => `<div>${raw(formatName(fact))}</div>`).join('') : '<span>无已确认匹配</span>'}${matches.bugs.length ? renderBugs(matches.bugs, `${factKind}@${r.version}`) : ''}${matches.unrestricted.length ? `<details ${factDetails(`unknown:${factKind}@${r.version}`)}><summary>未知格式 · 不作为支持证据</summary>${matches.unrestricted.map((fact) => `<div>${raw(formatName(fact))} ${raw('*')}</div>`).join('')}</details>` : ''}</td>`
            : ''
          return `<tr><td><code data-i18n-ignore>${escape(r.version)}</code></td><td><code data-i18n-ignore>${escape(requirement)}</code></td>${lockfiles}<td><a href="${url}" target="_blank" rel="noreferrer">官方记录 ↗</a></td></tr>`
        })
        .join('')
    : `<tr><td colspan="${factKind === 'node' ? 3 : 4}" class="fact-empty">没有匹配的版本记录。</td></tr>`
  $('#fact-count').textContent = `共 ${records.length} 条 · 第 ${factPage + 1} / ${pages} 页`
  $('#fact-prev').disabled = factPage === 0
  $('#fact-next').disabled = factPage >= pages - 1
  for (const button of document.querySelectorAll<HTMLElement>('[data-fact-kind]')) {
    button.classList.toggle('active', button.dataset.factKind === factKind)
    button.setAttribute('aria-pressed', button.dataset.factKind === factKind ? 'true' : 'false')
  }
}
function renderManagerConstraint(constraint: UiResult['pmConstraints'][number], manager: string) {
  return `<div class="condition-chip${constraint.inferred ? ' compatibility-constraint' : ''}">${raw(`${manager}@${constraint.range}`)}<small data-i18n-ignore>${escape(constraint.source)}</small></div>`
}
function renderResult() {
  if (!result) return
  if (!result.node || !result.packageManager) {
    $('#result-summary').innerHTML =
      '<div class="result-panel"><div class="result-panel-head">计算结果</div><div class="empty-result">补全下方警告指出的输入后，即可计算。</div></div>'
  } else {
    const { node, packageManager: pm } = result
    let nodeExplanation = `当前 Node <b>${raw(state.runtime.node)}</b> 不符合条件，取满足声明与预发布规则的最大版本。`
    if (node.reason === 'exact') nodeExplanation = `使用 <b>${raw(node.source)}</b> 保留的具体版本。`
    if (node.reason === 'current') nodeExplanation = '当前进程的 Node 落在保留条件内，优先采用。'
    let pmExplanation = '取满足声明与预发布规则、且支持所选 Node 的最大版本。'
    if (pm.reason === 'exact') pmExplanation = `使用 <b>${raw(pm.source)}</b> 保留的具体版本。`
    if (pm.reason === 'bundled')
      pmExplanation = `采用 <b>Node ${raw(node.version)} 绑定的 npm</b>，已检查已知范围与 Node 声明。`
    if (pm.reason === 'local') pmExplanation = `本地 <b>${raw(pm.name)} ${raw(pm.version)}</b> 满足已知条件，优先采用。`
    const conditionOpen = document.querySelector<HTMLDetailsElement>('#result-summary .condition-details')?.open
    const totalCount = result.nodeCandidates.length
    const pmCount = result.pmCandidates.length
    const nativeRuntime = pm.runtime === 'native'
    const compatibilityUnknown = !nativeRuntime && result.nodeCompatibility === 'unknown'
    let compatibilityMessage = `${escape(pm.name)} 要求 Node <code data-i18n-ignore>${escape(pm.nodeRange)}</code>，已满足`
    if (compatibilityUnknown) compatibilityMessage = '官方未声明 Node 要求；兼容性尚未核实'
    if (nativeRuntime) compatibilityMessage = '原生程序，无宿主 Node 要求'
    $('#result-summary').innerHTML =
      `<div class="result-panel pulse"><div class="result-panel-head"><span>推断结果</span><span class="result-live"><span class="status-dot"></span> 已计算</span></div><div class="version-results"><div class="version-card"><div class="version-card-label"><span class="node-symbol">⬡</span> Node.js</div><div class="version-number" data-i18n-ignore>${escape(node.version)}</div><div class="version-reason"><span>↳</span> ${reasonLabel[node.reason]}</div></div><div class="version-card"><div class="version-card-label"><span class="pm-symbol">▣</span> ${escape(pm.name)}</div><div class="version-number" data-i18n-ignore>${escape(pm.version)}</div><div class="version-reason"><span>↳</span> ${reasonLabel[pm.reason]}</div></div></div><div class="compat-line"><span>${compatibilityUnknown ? '△' : '✓'}</span><span>${compatibilityMessage}</span></div><div class="decision-reasons"><p><b>Node</b> · ${nodeExplanation}</p><p><b>${escape(pm.name)}</b> · ${pmExplanation}</p></div><details class="condition-details" ${conditionOpen ? 'open' : ''}><summary><span>查看声明与候选版本 <span style="color:#a0aec1">${totalCount} Node / ${pmCount} ${escape(pm.name)}</span></span><span class="chevron">⌄</span></summary><div class="details-content"><div class="condition-title">直接声明的 NODE 约束 · 全部同时满足</div>${result.nodeConstraints.length ? result.nodeConstraints.map((c) => `<div class="condition-chip">${escape(c.range)}<small data-i18n-ignore>${escape(c.source)}</small></div>`).join('') : '<div class="condition-chip">*<small>没有直接的 Node 版本约束</small></div>'}<div class="condition-title">包管理器约束 · 全部同时满足</div>${result.pmConstraints.length ? result.pmConstraints.map((c) => renderManagerConstraint(c, pm.name)).join('') : '<div class="condition-chip">npm@*<small>无类型声明，默认 npm；版本不写死</small></div>'}<div class="condition-title">包管理器候选推导的 NODE 支持 · 至少匹配一个候选</div>${result.derivedNodeRanges.map((r) => `<div class="condition-chip">${escape(r)}</div>`).join('')}<div class="condition-title">满足声明的 Node 候选 · 从大到小</div><div class="candidate-list">${result.nodeCandidates.join(' · ')}</div><div class="condition-title">支持选定 Node 的 ${escape(pm.name)} 候选 · 从大到小</div><div class="candidate-list">${result.pmCandidates.join(' · ')}</div></div></details></div>`
  }
  $('#warnings').innerHTML = result.warnings.length
    ? `<div class="warning-panel"><div class="warning-title"><span>△ 警告与忽略项</span><span class="warning-count">${result.warnings.length}</span></div>${result.warnings.map((w) => `<div class="warning-item"><b>${raw(w.source)}</b><p>${raw(warningText(w))}</p>${w.blockers.length ? `<small>保留的更高优先级条件：${w.blockers.map(raw).join(' + ')}</small>` : ''}</div>`).join('')}</div>`
    : '<div class="no-warning"><span>✓</span> 没有冲突，保留的条件均已满足。</div>'
  renderTrace()
  for (const s of SOURCES) {
    const item = result.trace.find(
      (t) => t.key === s.key && t.depth === (s.group === 'remote' ? -1 : 0) && t.order < SOURCES.length,
    )
    const badge = $(`[data-state="${s.key}"]`)
    badge.textContent = item ? stateLabel[item.status] : ''
    badge.className = `field-state ${item?.status || ''}`
    const field = $(`[data-field="${s.key}"]`)
    field.className = item?.status || ''
    field.setAttribute('aria-invalid', item?.status === 'invalid' ? 'true' : 'false')
  }
  for (let i = 0; i < state.additional.length; i++) {
    const item = result.trace.find((t) => t.order === SOURCES.length + i)
    $(`[data-extra-state="${i}"]`).innerHTML = item
      ? `${stateLabel[item.status]} · ${item.normalized ? raw(item.normalized) : raw(traceText(item))}`
      : ''
  }
}
function renderTrace() {
  if (!result) return
  const opened = new Set([...document.querySelectorAll<HTMLElement>('.trace-item[open]')].map((e) => e.dataset.traceId))
  const items = result.trace
    .map((t) => {
      let icon = '!'
      if (t.status === 'accepted') icon = '✓'
      if (t.status === 'skipped') icon = '−'
      const normalized = t.normalized && t.value !== t.normalized ? ` → ${raw(t.normalized)}` : ''
      const kind = t.kind ? `<span class="tag ${t.kind === 'type' ? 'range' : t.kind}">${kindLabel[t.kind]}</span>` : ''
      const inference = t.inference ? `<p>推断依据：${raw(inferenceText(t.inference))}</p>` : ''
      const blockers = t.blockers?.length ? `<p>优先保留：<code>${t.blockers.map(raw).join(' + ')}</code></p>` : ''
      const remaining =
        t.status === 'accepted'
          ? `<p>加入后剩余：${t.remainingNodes ?? 0} 个 Node / ${t.remainingPMs ?? 0} 个包管理器版本</p>`
          : ''
      const derivations = (t.derivations ?? [])
        .filter((d) => d.versions.length > 0)
        .map((d) => {
          const versions = [...new Set(d.versions)].sort(semver.rcompare)
          const last = versions.length > 1 ? ` … ${raw(versions.at(-1))}` : ''
          return `<div class="derivation-row" data-candidate-count="${versions.length}"><code>${raw(t.manager)}@${raw(versions[0])}${last}</code><small>${versions.length} 个具体候选分别携带相同的条件</small><span>→ Node <code>${raw(d.node)}</code></span></div>`
        })
        .join('')
      const derived = derivations
        ? `<div class="derivation-group">本条在合并前携带的 Node 条件：${derivations}</div>`
        : ''
      let yarnFamily: string | undefined
      if (t.key === 'yarnLock') {
        if (t.order < SOURCES.length) yarnFamily = state.fields.yarnLockFamily
        else yarnFamily = state.additional[t.order - SOURCES.length].yarnFamily
      }
      let familyName = ''
      if (t.key === 'yarnLock') {
        if (t.value.trim() === 'v1') familyName = ' · Yarn Classic'
        else if (yarnFamily === 'zpm') familyName = ' · Yarn 6+ JSON (ZPM)'
        else familyName = ' · Yarn Berry YAML (>=2 <6)'
      }
      return `<details class="trace-item ${t.status}" data-trace-id="${t.order}" ${opened.has(String(t.order)) ? 'open' : ''}><summary><span class="trace-icon">${icon}</span><div class="trace-text"><div class="trace-name">${String(t.rank).padStart(2, '0')} · ${raw(`${t.name}${familyName}`)}</div><div class="trace-value">${raw(t.value)}${normalized}</div></div><span class="trace-label">${stateLabel[t.status]}</span><span class="chevron">⌄</span></summary><div class="trace-detail">${kind}<p>${raw(traceText(t))}</p>${inference}${blockers}${remaining}${derived}</div></details>`
    })
    .join('')
  $('#trace').innerHTML =
    `<div class="trace-panel"><div class="trace-heading"><h3>逐条采纳过程</h3><span>按严格优先级顺序</span></div><div class="trace-list">${items || '<div class="trace-empty">没有版本声明。直接使用当前 Node 与它绑定的 npm。</div>'}</div></div>`
}
function showCalculationStatus(message: string, failed = false) {
  $('#export-result').disabled = true
  $('#result-summary').innerHTML =
    `<div class="result-panel"><div class="result-panel-head">${failed ? '数据尚未核实' : '正在查询与计算'}</div><div class="query-state ${failed ? 'query-failed' : ''}">${escape(message)}</div></div>`
  $('#warnings').innerHTML = ''
  $('#trace').innerHTML = ''
}
async function calculate({ forceData = false } = {}) {
  const serial = ++calculationSerial
  calculationAbort?.abort()
  const abort = new AbortController()
  calculationAbort = abort
  result = null
  calculationError = null
  showCalculationStatus('正在读取官方版本数据…')
  try {
    await ensureCatalog(forceData)
    if (serial !== calculationSerial) return
    const currentNode = semver.valid(state.runtime.node)
    state.runtime.npm = catalog.nodes.find((n) => n.version === currentNode)?.npm || ''
    $('[data-runtime="npm"]').value = state.runtime.npm
    const resolved: UiResult = await resolveLive(clone(state), catalog, {
      signal: abort.signal,
      onSource: (event) => {
        if (serial !== calculationSerial) return
        sourceReceipts.set(event.id, {
          ...event,
          name: '显式版本的官方元数据',
          fields: '按显式声明查询预发布版本，不加入常规版本统计',
          errorCode: event.error ? classifyError(event.error) : undefined,
        })
        renderSources()
      },
    })
    if (serial !== calculationSerial) return
    result = resolved
    renderResult()
    persist()
    $('#export-result').disabled = !resolved.node || !resolved.packageManager
  } catch (error) {
    if (serial !== calculationSerial || abort.signal.aborted) return
    calculationError = error
    showCalculationStatus(failureText(error), true)
  }
}
function scheduleCalculate() {
  persist()
  currentPreset = null
  for (const p of document.querySelectorAll('.preset.active')) p.classList.remove('active')
  clearTimeout(debounceTimer)
  debounceTimer = setTimeout(calculate, 120)
}
function resetFields(fields: Record<string, string>, runtime?: Record<string, string>) {
  state.fields = { ...EMPTY_FIELDS, yarnLockFamily: 'berry', ...fields }
  state.additional = []
  if (runtime) state.runtime = clone(runtime)
  renderStatic()
  calculate()
}

document.addEventListener('input', (event) => {
  const { target } = event
  if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return
  if (target instanceof HTMLInputElement && Object.hasOwn(target.dataset, 'lockImporters')) {
    state.fields.pnpmShrinkwrapImporters = String(target.checked)
    scheduleCalculate()
  }
  if (Object.hasOwn(target.dataset, 'yarnLockFamily')) {
    state.fields.yarnLockFamily = target.value === 'zpm' ? 'zpm' : 'berry'
    scheduleCalculate()
  }
  if (target.dataset.field) {
    state.fields[target.dataset.field] = target.value
    scheduleCalculate()
  }
  if (target.dataset.runtime && target.dataset.runtime !== 'npm') {
    state.runtime[target.dataset.runtime] = target.value
    scheduleCalculate()
  }
  if (target.dataset.extra !== undefined) {
    const row = state.additional[Number(target.dataset.extra)]
    if (target.dataset.prop === 'depth') row.depth = Math.max(0, Number(target.value) || 0)
    else if (target.dataset.prop === 'key') {
      row.key = target.value
      renderAdditional()
    } else if (target.dataset.prop === 'value') row.value = target.value
    else if (target.dataset.prop === 'sharedWorkspace' && target instanceof HTMLInputElement)
      row.sharedWorkspace = target.checked
    else if (target.dataset.prop === 'yarnFamily') row.yarnFamily = target.value === 'zpm' ? 'zpm' : 'berry'
    scheduleCalculate()
  }
  if (target.id === 'search-depth') {
    state.searchDepth = Math.max(0, Math.floor(Number(target.value) || 0))
    scheduleCalculate()
  }
  if (target.id === 'fact-search') {
    factQuery = target.value.trim()
    factPage = 0
    renderFacts()
  }
})
document.addEventListener('click', (event) => {
  if (!(event.target instanceof Element)) return
  const preset = event.target.closest<HTMLElement>('[data-preset]')
  if (preset) {
    const p = PRESETS.find((x) => x.id === preset.dataset.preset)
    if (!p) return
    currentPreset = p.id
    resetFields(p.fields, p.runtime)
    return
  }
  const removeSource = event.target.closest<HTMLElement>('[data-remove-source]')
  if (removeSource) {
    state.additional.splice(Number(removeSource.dataset.removeSource), 1)
    renderAdditional()
    calculate()
  }
  const factTab = event.target.closest<HTMLElement>('[data-fact-kind]')
  if (factTab) {
    factKind = factTab.dataset.factKind!
    factPage = 0
    renderFacts()
  }
})
$('#clear-fields').addEventListener('click', () => {
  currentPreset = null
  resetFields({})
  toast('已清空声明，保留当前运行环境。')
})
$('#export-result').addEventListener('click', async () => {
  clearTimeout(debounceTimer)
  await calculate()
  if (!result?.node || !result.packageManager) return
  download('toolchain-result.json', {
    input: state,
    result,
    versionData: result.versionData ?? { fetchedAt: catalog.generatedAt, sources: catalog.sources },
  })
})
$('#refresh-data').addEventListener('click', () => calculate({ forceData: true }))
$('#add-source').addEventListener('click', () => {
  state.additional.push({ key: 'nvmrc', depth: 1, value: '' })
  renderAdditional()
  persist()
})
$('#fact-prev').addEventListener('click', () => {
  factPage--
  renderFacts()
})
$('#fact-next').addEventListener('click', () => {
  factPage++
  renderFacts()
})

renderStatic()
$('#fact-search').value = factQuery
installTabs()
installLocale()
document.addEventListener('localechange', () => {
  renderSources()
  renderCatalog()
  renderResult()
  if (calculationError) showCalculationStatus(failureText(calculationError), true)
})
calculate()
