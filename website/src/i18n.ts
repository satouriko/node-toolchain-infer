import en from './locales/en.json'
import { englishPatterns } from './locales/patterns.js'
import zh from './locales/zh-CN.json'

const preferenceKey = 'node-toolchain-infer:locale'
let locale = 'zh-CN'
try {
  if (localStorage.getItem(preferenceKey) === 'en') locale = 'en'
} catch {}
const english: Record<string, string> = en
const chinese: Record<string, string> = zh
const replacements = Object.entries(english).sort((a, b) => b[0].length - a[0].length)
const originals = new WeakMap<Node, Record<string, { original: string; rendered: string }>>()
const attributes = ['aria-label', 'aria-description', 'placeholder', 'title', 'alt']
export const getLocale = () => locale

export function translate(value: string, target = locale) {
  const text = value
  const trimmed = text.trim().replace(/\s+/g, ' ')
  const dictionary = target === 'en' ? english : chinese
  if (Object.hasOwn(dictionary, trimmed)) {
    const leading = /^\s+/.exec(text)?.[0] ?? ''
    const trailing = /\s+$/.exec(text)?.[0] ?? ''
    return leading + dictionary[trimmed] + trailing
  }
  if (target !== 'en') return text
  let output = text.replace(/\s+/g, ' ')
  for (const [pattern, replacement] of englishPatterns)
    output =
      typeof replacement === 'string' ? output.replace(pattern, replacement) : output.replace(pattern, replacement)
  // Longest explicit phrases first preserves prose and interpolated version values.
  if (/\p{Script=Han}/u.test(output)) {
    for (const [source, translated] of replacements)
      if (output.includes(source)) output = output.split(source).join(translated)
  }
  return output
}
function renderValue(node: Node, key: string, current: string, set: (value: string) => void) {
  const saved = originals.get(node) || {}
  const entry = Object.hasOwn(saved, key) ? saved[key] : undefined
  const original = entry?.rendered === current ? entry.original : current
  const rendered = translate(original)
  saved[key] = { original, rendered }
  originals.set(node, saved)
  if (rendered !== current) set(rendered)
}
function localize(root: Node) {
  if (root instanceof Text) {
    if (!root.parentElement?.closest('script,style,[data-i18n-ignore]'))
      renderValue(root, 'text', root.nodeValue || '', (v) => {
        root.replaceData(0, root.length, v)
      })
    return
  }
  if (!(root instanceof Element) || root.closest('[data-i18n-ignore]') || /^(?:SCRIPT|STYLE)$/.test(root.tagName))
    return
  for (const attr of attributes)
    if (root.hasAttribute(attr))
      renderValue(root, attr, root.getAttribute(attr) || '', (v) => root.setAttribute(attr, v))
  for (const child of root.childNodes) localize(child)
}
export function installLocale() {
  const observerOptions: MutationObserverInit = {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: attributes,
  }
  const observer = new MutationObserver((records) => {
    observer.disconnect()
    for (const record of records) {
      if (record.type === 'childList') for (const node of record.addedNodes) localize(node)
      else localize(record.target)
    }
    observer.observe(document.body, observerOptions)
  })
  const apply = () => {
    observer.disconnect()
    document.documentElement.lang = locale
    localize(document.body)
    for (const button of document.querySelectorAll<HTMLElement>('[data-locale]'))
      button.setAttribute('aria-pressed', String(button.dataset.locale === locale))
    observer.observe(document.body, observerOptions)
  }
  document.addEventListener('click', (event) => {
    const button = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-locale]') : null
    if (!button || button.dataset.locale === locale) return
    locale = button.dataset.locale === 'en' ? 'en' : 'zh-CN'
    try {
      localStorage.setItem(preferenceKey, locale)
    } catch {}
    apply()
    document.dispatchEvent(new CustomEvent('localechange', { detail: { locale } }))
  })
  apply()
}
