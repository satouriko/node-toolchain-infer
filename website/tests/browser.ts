import assert from 'node:assert/strict'
import { type ChildProcessByStdio, spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'

import { chromium } from 'playwright'

import type { Readable } from 'node:stream'

const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
})
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
let server: ChildProcessByStdio<null, Readable, null> | undefined
let url = process.env.WEBSITE_URL
if (!url) {
  server = spawn(process.execPath, ['--import', 'tsx', new URL('../serve.ts', import.meta.url).pathname], {
    env: { ...process.env, PORT: '0' },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const serving = server
  url = await new Promise<string>((resolve, reject) => {
    serving.once('error', reject)
    serving.stdout.on('data', (data) => {
      const match = /http:\/\/127\.0\.0\.1:\d+/.exec(String(data))
      if (match) resolve(match[0])
    })
  })
}
try {
  const browserErrors: string[] = []
  page.on('pageerror', (error) => browserErrors.push(error.message))
  await page.route('https://repo.yarnpkg.com/releases', (route) =>
    route.fulfill({
      json: {
        releaseLines: {
          classic: { stable: '1.22.22', canary: '1.22.22', tags: ['1.22.22'] },
          berry: { stable: '4.18.0', canary: '4.18.0', tags: ['4.18.0'] },
          zpm: { stable: '6.0.0-rc.20', canary: '6.0.0-rc.20', tags: ['6.0.0-rc.20'] },
        },
      },
    }),
  )
  await page.goto(url)
  await page.locator('[data-locale="en"]').click({ timeout: 3000 })
  assert.equal(await page.locator('html').getAttribute('lang'), 'en')
  await page.locator('#tab-calculator').click()
  await page.locator('[data-yarn-lock-family]').selectOption('zpm')
  await page.locator('[data-field="enginesNode"]').fill('>=18 <21')
  await page.locator('#tab-facts').click()
  await page.locator('#fact-search').fill('18.20')
  for (const locale of ['zh-CN', 'en']) {
    await page.locator(`[data-locale="${locale}"]`).click()
    assert.equal(new URL(page.url()).hash, '#facts')
    assert.equal(await page.locator('#fact-search').inputValue(), '18.20')
    assert.equal(await page.locator('[data-field="enginesNode"]').inputValue(), '>=18 <21')
    assert.equal(await page.locator('[data-yarn-lock-family]').inputValue(), 'zpm')
    for (const tab of ['rules', 'calculator', 'data', 'facts']) {
      await page.locator(`#tab-${tab}`).click()
      assert.equal(await page.locator('main > .tab-panel:visible').count(), 1)
      assert.equal(await page.locator('main > .tab-panel:visible').getAttribute('id'), tab)
    }
  }
  await page.reload()
  assert.equal(await page.locator('html').getAttribute('lang'), 'en')
  assert.equal(await page.locator('#fact-search').inputValue(), '18.20')
  assert.equal(await page.locator('[data-field="enginesNode"]').inputValue(), '>=18 <21')
  assert.equal(await page.locator('[data-yarn-lock-family]').inputValue(), 'zpm')
  await page.waitForFunction(() => document.querySelectorAll('.live-source.ready').length >= 8, undefined, {
    timeout: 30000,
  })
  await mkdir(new URL('../.qa/', import.meta.url), { recursive: true })
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport)
    for (const locale of ['zh-CN', 'en']) {
      await page.locator(`[data-locale="${locale}"]`).click()
      for (const tab of ['rules', 'calculator', 'data', 'facts']) {
        await page.locator(`#tab-${tab}`).click()
        if (tab === 'calculator')
          await page.waitForFunction(() => !document.querySelector('#result-summary .query-state'))
        await page.screenshot({
          path: new URL(`../.qa/${viewport.width}-${locale}-${tab}.png`, import.meta.url).pathname,
          fullPage: true,
        })
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)
        assert.equal(overflow, false, `${locale} ${tab} horizontal page overflow at ${viewport.width}`)
        if (locale === 'en') {
          const chinese = await page.locator(`#${tab}`).evaluate((el) => {
            const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
            const found = []
            while (walker.nextNode())
              if (/\p{Script=Han}/u.test(walker.currentNode.textContent ?? ''))
                found.push(walker.currentNode.textContent ?? '')
            for (const node of el.querySelectorAll('[aria-label],[aria-description],[placeholder],[title],[alt]'))
              for (const attr of ['aria-label', 'aria-description', 'placeholder', 'title', 'alt'])
                if (/\p{Script=Han}/u.test(node.getAttribute(attr) || '')) found.push(node.getAttribute(attr))
            return found
          })
          assert.deepEqual(chinese, [], `untranslated ${tab}`)
        }
      }
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.locator('[data-locale="en"]').click()
  await page.locator('#tab-facts').click()
  await page.waitForFunction(() => document.querySelectorAll('.live-source.ready').length >= 8, undefined, {
    timeout: 30000,
  })
  await page.locator('#fact-search').fill('18.20')
  const factRows = await page.locator('#fact-rows tr').allTextContents()
  assert.ok(
    factRows.length > 0 && factRows.every((row) => row.includes('18.20')),
    'real official facts obey the filter',
  )
  await page.locator('[data-fact-kind="yarn"]').click()
  await page.locator('#fact-search').fill('2.4.3')
  assert.equal(await page.locator('#fact-rows a').first().getAttribute('href'), 'https://registry.npmjs.org/yarn/2.4.3')
  await page.locator('[data-fact-kind="node"]').click()
  await page.locator('#fact-search').fill('0.1.14')
  assert.match((await page.locator('#fact-rows').textContent()) ?? '', /Not recorded in release index/)
  await page.locator('#fact-search').fill('18.20')
  await page.locator('#tab-calculator').click()
  assert.match((await page.locator('.decision-reasons').textContent()) ?? '', /Node \d+\.\d+\.\d+ bundled npm/)
  for (const preset of ['node18', 'current', 'remote', 'derived', 'lock', 'empty']) {
    await page.locator(`[data-preset="${preset}"]`).click()
    await page.waitForFunction(() => !document.querySelector('#result-summary .query-state'))
    const text = (await page.locator('#calculator').textContent()) ?? ''
    assert.equal(
      /\p{Script=Han}/u.test(text),
      false,
      `English preset ${preset} has untranslated dynamic text: ${JSON.stringify(text.match(/[^\n]*\p{Script=Han}[^\n]*/gu))}`,
    )
  }
  for (const locale of ['zh-CN', 'en']) {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.locator(`[data-locale="${locale}"]`).click()
    await page.locator('#tab-data').click()
    await page.locator('#maintenance-checks').scrollIntoViewIfNeeded()
    await page.screenshot({ path: new URL(`../.qa/390-${locale}-maintenance-detail.png`, import.meta.url).pathname })
  }
  await page.locator('[data-locale="en"]').click()
  await page.locator('#tab-calculator').click()
  await page.locator('#add-source').click()
  await page.locator('[data-extra="0"][data-prop="value"]').fill('nonsense')
  await page.waitForFunction(() => document.querySelector('[data-extra-state="0"]')?.textContent.includes('Invalid'))
  assert.equal(
    /\p{Script=Han}/u.test((await page.locator('#calculator').textContent()) ?? ''),
    false,
    'invalid declaration warning is translated',
  )
  assert.equal(await page.locator('#additional-fields button').getAttribute('aria-label'), 'Remove declaration 1')
  await page.locator('[data-extra="0"][data-prop="key"]').selectOption('pnpmShrinkwrap')
  await page.locator('[data-extra="0"][data-prop="value"]').fill('4')
  await page.locator('[data-extra="0"][data-prop="sharedWorkspace"]').check()
  for (const locale of ['zh-CN', 'en']) {
    await page.locator(`[data-locale="${locale}"]`).click()
    assert.equal(await page.locator('[data-extra="0"][data-prop="sharedWorkspace"]').isChecked(), true)
  }
  assert.equal(/\p{Script=Han}/u.test((await page.locator('#additional-fields').textContent()) ?? ''), false)
  await page.locator('[data-extra="0"][data-prop="key"]').selectOption('yarnLock')
  await page.locator('[data-extra="0"][data-prop="value"]').fill('9')
  await page.locator('[data-extra="0"][data-prop="yarnFamily"]').selectOption('zpm')
  for (const locale of ['zh-CN', 'en']) {
    await page.locator(`[data-locale="${locale}"]`).click()
    assert.equal(await page.locator('[data-extra="0"][data-prop="yarnFamily"]').inputValue(), 'zpm')
  }
  await page.locator('#clear-fields').click()
  assert.match((await page.locator('#toast').textContent()) ?? '', /Declarations cleared/)
  for (const literal of ['来源', '前缀 来源 / Invalid semver declaration: 来源 <value> 后缀']) {
    await page.locator('[data-field="remoteNode"]').fill(literal)
    await page.waitForFunction(
      (expected) => document.querySelector('.trace-value > [data-i18n-ignore]')?.textContent === expected,
      literal,
    )
    for (const locale of ['en', 'zh-CN', 'en']) {
      await page.locator(`[data-locale="${locale}"]`).click()
      assert.equal(await page.locator('[data-field="remoteNode"]').inputValue(), literal)
      assert.equal(await page.locator('.trace-value > [data-i18n-ignore]').first().textContent(), literal)
      assert.ok((await page.locator('.warning-item p').allTextContents()).some((text) => text.includes(literal)))
      assert.equal(await page.locator('[data-field="remoteNode"]').getAttribute('aria-invalid'), 'true')
      assert.equal(
        await page.locator('[data-state="remoteNode"]').textContent(),
        locale === 'en' ? 'Invalid' : '格式无效',
      )
      if (locale === 'zh-CN') {
        assert.ok(
          (await page.locator('.warning-item p').allTextContents()).some(
            (text) => text.startsWith('无效的 semver 声明：') && text.includes(literal),
          ),
        )
        assert.equal(await page.locator('#tab-rules').textContent(), '规则说明')
        assert.equal(await page.locator('[data-runtime="node"]').getAttribute('aria-label'), '当前进程的 Node')
      }
    }
  }
  await page.locator('#clear-fields').click()
  await page.locator('[data-locale="zh-CN"]').click()
  assert.match((await page.locator('#toast').textContent()) ?? '', /已清空声明，保留当前运行环境/)
  await page.locator('[data-field="pnpmLock"]').fill('999')
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.warning-item p')].some((item) => item.textContent.includes('随包规则未覆盖')),
  )
  assert.ok((await page.locator('.warning-item p').allTextContents()).some((text) => /版本约束使用 \*/.test(text)))
  assert.equal(await page.locator('#export-result').isEnabled(), true)
  assert.match((await page.locator('.result-panel-head').textContent()) ?? '', /推断结果/)
  assert.doesNotMatch((await page.locator('.result-panel-head').textContent()) ?? '', /VERIFIED|PREVIEW|已验证/)
  await page.locator('[data-locale="en"]').click()
  assert.ok(
    (await page.locator('.warning-item p').allTextContents()).some((text) => /version constraint is \*/.test(text)),
  )
  assert.match((await page.locator('.result-panel-head').textContent()) ?? '', /Inferred result/)
  for (const row of await page.locator('.derivation-row').all()) {
    assert.ok(Number(await row.getAttribute('data-candidate-count')) > 0)
    assert.doesNotMatch((await row.textContent()) ?? '', /undefined/)
  }
  await page.locator('#tab-rules').focus()
  await page.keyboard.press('ArrowRight')
  assert.equal(await page.locator('#tab-calculator').getAttribute('aria-selected'), 'true')
  assert.equal(await page.locator('#tab-calculator').evaluate((el) => el === document.activeElement), true)
  await page.setViewportSize({ width: 720, height: 500 })
  for (const tab of ['rules', 'calculator', 'data', 'facts']) {
    await page.locator(`#tab-${tab}`).click()
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1),
      false,
      `200% equivalent reflow: ${tab}`,
    )
  }
  const headerHan = await page.locator('header').evaluate((el) => {
    const copy = el.cloneNode(true) as HTMLElement
    for (const ignored of copy.querySelectorAll('[data-i18n-ignore]')) ignored.remove()
    return /\p{Script=Han}/u.test(copy.textContent)
  })
  assert.equal(headerHan, false)

  for (const [failure, zh, en] of [
    ['network', '网络请求失败', 'Network request failed'],
    ['json', '无效的 JSON', 'invalid JSON'],
    ['http', 'HTTP 错误', 'HTTP error'],
    ['timeout', '请求超时', 'request timed out'],
  ]) {
    const failurePage = await browser.newPage()
    if (failure === 'timeout') {
      await failurePage.addInitScript(() => {
        const nativeFetch = window.fetch
        window.fetch = (input, init) => {
          const href = input instanceof Request ? input.url : input.toString()
          if (href === 'https://nodejs.org/dist/index.json')
            return Promise.reject(new DOMException('The operation timed out.', 'TimeoutError'))
          return nativeFetch(input, init)
        }
      })
    } else {
      await failurePage.route('https://nodejs.org/dist/index.json', async (route) => {
        if (failure === 'network') await route.abort('failed')
        else await route.fulfill({ status: failure === 'http' ? 503 : 200, contentType: 'application/json', body: '{' })
      })
    }
    await failurePage.goto(url)
    await failurePage.locator('#tab-calculator').click()
    await failurePage.locator('.query-failed').waitFor()
    for (const [locale, expected] of [
      ['zh-CN', zh],
      ['en', en],
      ['zh-CN', zh],
    ]) {
      await failurePage.locator(`[data-locale="${locale}"]`).click()
      assert.ok(
        (await failurePage.locator('.query-failed').textContent())?.includes(expected),
        `${failure}: ${locale} calculator error`,
      )
      assert.ok(
        (await failurePage.locator('.live-source.error').textContent())?.includes(expected),
        `${failure}: ${locale} receipt error`,
      )
      assert.doesNotMatch(
        (await failurePage.locator('.query-failed').textContent()) ?? '',
        /Failed to fetch|Unexpected token/,
      )
    }
    await failurePage.close()
  }
  // A failed revalidation must retain its actual prior response, with a translated warning.
  await page.locator('#tab-calculator').click()
  await page.locator('#clear-fields').click()
  await page.locator('[data-field="remotePackageManager"]').fill('pnpm@7.28.0')
  await page.locator('[data-field="pnpmLock"]').fill('5.1')
  for (const [locale, expected] of [
    ['zh-CN', '在语义上兼容该锁格式'],
    ['en', 'is compatible with this lock format'],
  ]) {
    await page.locator(`[data-locale="${locale}"]`).click()
    await page.waitForFunction((text) => document.querySelector('#warnings')?.textContent.includes(text), expected)
    assert.match((await page.locator('#result-summary').textContent()) ?? '', /7\.28\.0/)
  }
  await page.locator('#clear-fields').click()
  await page.locator('[data-field="remotePackageManager"]').fill('pnpm@9.4.0')
  await page.locator('[data-field="pnpmLock"]').fill('9.0')
  await page.waitForFunction(() => document.querySelector('.compatibility-constraint') !== null)
  await page.locator('.condition-details > summary').click()
  const constraint = page.locator('.compatibility-constraint').first()
  assert.match((await constraint.textContent()) ?? '', /pnpm@>=9\.0\.0/)
  assert.doesNotMatch((await constraint.textContent()) ?? '', /rc|beta|alpha/)
  assert.equal(await constraint.locator('.range-prereleases').count(), 0)
  await page.locator('#tab-facts').click()
  await page.locator('[data-fact-kind="pnpm"]').click()
  await page.locator('#fact-search').fill('5.17.0')
  await page.waitForFunction(() =>
    document.querySelector('#fact-rows')?.textContent.includes('pnpm-auto-import-5.17.0'),
  )
  assert.match((await page.locator('#fact-rows').textContent()) ?? '', /pnpm-lock\.yaml · 5\.4/)
  await page.locator('#fact-rows .fact-bugs > summary').click()
  for (const [locale, expected] of [
    ['zh-CN', '具体上游问题与根因尚未确认'],
    ['en', 'exact upstream issue and underlying cause remain unconfirmed'],
  ]) {
    await page.locator(`[data-locale="${locale}"]`).click()
    assert.match((await page.locator('#fact-rows .fact-bugs').textContent()) ?? '', new RegExp(expected))
    assert.equal(
      await page.locator('#fact-rows .fact-bugs').evaluate((element) => (element as HTMLDetailsElement).open),
      true,
    )
  }
  await page.locator('[data-fact-kind="yarn"]').click()
  await page.locator('#fact-search').fill('4.1.0')
  assert.equal(await page.locator('#lockfile-fact-rows tr').count(), 8)
  assert.match((await page.locator('#lockfile-fact-rows').textContent()) ?? '', /Classic 1/)
  assert.match((await page.locator('#lockfile-fact-rows').textContent()) ?? '', /fixtures\/recipes\.json/)
  await page.locator('#toast').waitFor({ state: 'hidden' })
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport)
    for (const locale of ['zh-CN', 'en']) {
      await page.locator(`[data-locale="${locale}"]`).click()
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false)
      if (locale === 'en') assert.doesNotMatch((await page.locator('#facts').textContent()) ?? '', /\p{Script=Han}/u)
      await page.locator('.lockfile-mapping-heading').scrollIntoViewIfNeeded()
      await page.screenshot({
        path: new URL(`../.qa/${viewport.width}-${locale}-lockfile-facts.png`, import.meta.url).pathname,
      })
    }
  }
  // Synthetic single-version manifests exercise explicit lookup only; ordinary catalogs stay live.
  const exactVersion = '99.0.0-website-test.1'
  const explicitUrl = `https://registry.npmjs.org/pnpm/${exactVersion}`
  let explicitRequests = 0
  await page.route(explicitUrl, async (route) => {
    explicitRequests++
    await route.fulfill({ json: { name: 'pnpm', version: exactVersion, engines: { node: '^20.0.0' } } })
  })
  await page.locator('#tab-calculator').click()
  await page.locator('#clear-fields').click()
  await page.locator('[data-field="packageManager"]').fill(`pnpm@${exactVersion}`)
  await page.waitForFunction(
    (version) => document.querySelector('#result-summary .version-results')?.textContent.includes(version),
    exactVersion,
  )
  assert.ok(explicitRequests > 0)
  const chosenNode = await page.locator('.version-card').first().locator('.version-number').textContent()
  assert.match(chosenNode ?? '', /^20\.\d+\.\d+$/)
  assert.equal(await page.locator('#data-status').textContent(), 'Official data fetched')
  for (const locale of ['zh-CN', 'en']) {
    await page.locator(`[data-locale="${locale}"]`).click()
    const receipt = page.locator('[data-source-id^="explicit-"]').first()
    assert.match(
      (await receipt.textContent()) ?? '',
      locale === 'en' ? /excluded from regular version counts/ : /不加入常规版本统计/,
    )
  }
  await page.locator('#tab-facts').click()
  await page.locator('[data-fact-kind="pnpm"]').click()
  await page.locator('#fact-search').fill(exactVersion)
  assert.equal(await page.locator('#fact-rows .fact-empty').count(), 1)
  await page.locator('#tab-calculator').click()
  await page.locator('#clear-fields').click()
  await page.locator('[data-yarn-lock-family]').selectOption('zpm')
  await page.locator('[data-field="yarnLock"]').fill('9')
  await page.locator('[data-field="packageManager"]').fill('yarn@6.0.0-rc.20')
  await page.waitForFunction(() =>
    document.querySelector('#result-summary .version-results')?.textContent.includes('6.0.0-rc.20'),
  )
  assert.match((await page.locator('.compat-line').textContent()) ?? '', /Native executable; no host Node requirement/)
  assert.match((await page.locator('.trace-name').allTextContents()).join(' '), /Yarn 6\+ JSON \(ZPM\)/)
  assert.ok((await page.locator('.compatibility-constraint').allTextContents()).some((text) => text.includes('yarn@*')))
  const nativeDownload = page.waitForEvent('download')
  await page.locator('#export-result').click()
  const nativeStream = await (await nativeDownload).createReadStream()
  let nativeExport = ''
  for await (const chunk of nativeStream) nativeExport += String(chunk)
  assert.ok(
    JSON.parse(nativeExport).versionData.sources.some(
      (source: { url: string }) => source.url === 'https://repo.yarnpkg.com/releases',
    ),
  )
  const unavailableVersion = '99.0.0-website-test.2'
  await page.route(`https://registry.npmjs.org/pnpm/${unavailableVersion}`, (route) => route.abort('failed'))
  await page.locator('#clear-fields').click()
  await page.locator('[data-field="packageManager"]').fill(`pnpm@${unavailableVersion}`)
  await page.waitForFunction(() => document.querySelector('.live-source.error[data-source-id^="explicit-"]') !== null)
  await page.locator('#result-summary .version-results').waitFor()
  assert.equal(await page.locator('#data-status').textContent(), 'Official data fetched')
  assert.equal(await page.locator('#result-summary .query-failed').count(), 0)
  await page.locator('#clear-fields').click()
  await page.locator('#result-summary .version-results').waitFor()
  await page.route('https://nodejs.org/dist/index.json', (route) => route.abort('failed'))
  await page.locator('#tab-facts').click()
  await page.locator('#refresh-data').click()
  await page.waitForFunction(() => document.querySelector('.live-source.stale') !== null)
  await page.locator('#tab-calculator').click()
  await page.waitForFunction(() => document.querySelector('#warnings')?.textContent.includes('using cached metadata'))
  await page.locator('[data-locale="zh-CN"]').click()
  assert.match((await page.locator('#warnings').textContent()) ?? '', /继续使用已有缓存。获取时间：/)
  assert.doesNotMatch((await page.locator('#warnings').textContent()) ?? '', /Failed to fetch|using cached/)
  assert.deepEqual(browserErrors, [])
} finally {
  await browser.close()
  server?.kill()
}
console.log(
  'PASS bilingual navigation, calculator/filter persistence, locale persistence, all panels, desktop/mobile overflow, no untranslated English text or ARIA. Screenshots in website/.qa.',
)
