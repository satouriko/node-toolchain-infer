export function installTabs() {
  const panels = [...document.querySelectorAll<HTMLElement>('main > .tab-panel')]
  const tabs = [...document.querySelectorAll<HTMLAnchorElement>('.nav-link[role="tab"]')]
  const tablist = document.querySelector<HTMLElement>('[role="tablist"]')!

  function route(hash: string) {
    let id = ''
    try {
      id = decodeURIComponent(hash.replace(/^#/, ''))
    } catch {}
    const target = document.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`)
    const panel = target?.closest<HTMLElement>('.tab-panel') || panels[0]
    return { panel, target: panel.contains(target) ? target : panel }
  }

  function activate(hash: string, { focusPanel = false } = {}) {
    const { panel, target } = route(hash)
    for (const item of panels) item.hidden = item !== panel
    for (const tab of tabs) {
      const selected = tab.getAttribute('aria-controls') === panel.id
      tab.classList.toggle('active', selected)
      tab.setAttribute('aria-selected', String(selected))
      tab.tabIndex = selected ? 0 : -1
    }
    if (target === panel) {
      window.scrollTo({ top: 0, left: 0, behavior: 'instant' })
    } else {
      for (let parent = target!.parentElement; parent && parent !== panel; parent = parent.parentElement) {
        if (parent.tagName === 'DETAILS') (parent as HTMLDetailsElement).open = true
      }
      target!.scrollIntoView({ block: 'start', behavior: 'instant' })
    }
    if (focusPanel) panel.focus({ preventScroll: true })
  }

  function navigate(hash: string, options?: { focusPanel?: boolean }) {
    if (window.location.hash !== hash) history.pushState(null, '', hash)
    activate(hash, options)
  }

  document.addEventListener('click', (event) => {
    const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href^="#"]') : null
    if (
      !link
      || event.defaultPrevented
      || event.button !== 0
      || event.metaKey
      || event.ctrlKey
      || event.shiftKey
      || event.altKey
      || link.target === '_blank'
    )
      return
    const hash = link.getAttribute('href')!
    let id
    try {
      id = decodeURIComponent(hash.slice(1))
    } catch {
      return
    }
    if (!document.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`)?.closest('.tab-panel')) return
    event.preventDefault()
    navigate(hash, { focusPanel: link.getAttribute('role') !== 'tab' })
  })

  tablist.addEventListener('keydown', (event) => {
    const index = tabs.indexOf(event.target as HTMLAnchorElement)
    if (index === -1) return
    let next
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length
    else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = tabs.length - 1
    else if (event.key === ' ') next = index
    else return
    event.preventDefault()
    tabs[next].focus({ preventScroll: true })
    navigate(tabs[next].getAttribute('href')!)
  })

  window.addEventListener('hashchange', () => activate(window.location.hash))
  activate(window.location.hash)
}
