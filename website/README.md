# node-toolchain-infer website / 网站

A pure frontend reference and calculator with four independent panels: rules, calculator, data acquisition/maintenance, and live version facts. 中文 / English switches the same DOM in place, including long maintenance prose, generated results, warnings, traces, source receipts, dates, form captions and ARIA labels. No remote translation service or shipped release snapshot is used.

这是纯前端规则说明和计算器，包含规则、计算器、数据获取与维护、实时版本事实四个独立面板。中英文切换保留当前 hash、表单值、展开状态和筛选条件；语言、输入及筛选保存在浏览器 localStorage。所有翻译均随代码发布，不调用远程翻译，也不内置过期发行版本表。

## Build and serve / 构建与预览

Run from the repository root after installing the root dependencies with pnpm:

在仓库根目录用 pnpm 安装依赖后执行：

```sh
pnpm install
pnpm website:build
pnpm website:serve
```

The server binds only to 127.0.0.1 and prints its randomly assigned port. Set `PORT` when a particular local port is needed. The build script resolves paths relative to itself and works regardless of the calling directory. Root dependencies provide esbuild and semver; the website has no independent dependency installation.

服务仅监听 127.0.0.1，并打印随机分配的端口；需要固定本地端口时设置 `PORT`。构建脚本不依赖调用目录。esbuild 与 semver 使用根项目依赖，网站无需独立安装依赖。

## Deployment / 部署

The live site is [satouriko.github.io/node-toolchain-infer](https://satouriko.github.io/node-toolchain-infer/). Each push to `main` runs the `Deploy website` workflow, checks types, lint and tests, then publishes `website/dist` through GitHub Pages. The build copies only the HTML, styles and JavaScript assets into this directory; relative asset URLs also work under the repository's Pages path. No server is required in production.

线上地址是 [satouriko.github.io/node-toolchain-infer](https://satouriko.github.io/node-toolchain-infer/)。每次推送到 `main`，`Deploy website` 工作流完成类型检查、lint 与测试，再将 `website/dist` 发布到 GitHub Pages。构建目录只包含 HTML、样式和 JavaScript 静态资源；资源使用相对地址，支持 Pages 的仓库子路径。生产环境无需服务端。

## Browser validation / 浏览器验证

```sh
pnpm exec playwright install chromium
pnpm website:test
# Or use an installed Google Chrome:
CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' pnpm website:test
pnpm exec tsc -p website/tsconfig.json
pnpm exec eslint website
```

The root project supplies Playwright and tsx. The test starts its own TypeScript server on an ephemeral port and stops it afterward. `WEBSITE_URL` can target an existing preview; `CHROME_PATH` selects a local Chromium browser.

Playwright 与 tsx 由根项目提供。测试自动启动随机端口的 TypeScript 本地服务并在完成后关闭；也可用 `WEBSITE_URL` 指向已有预览，或用 `CHROME_PATH` 选择本机 Chromium 浏览器。

The live browser test uses eight official sources for version facts, with the Yarn native release feed mocked to retain its current prerelease-only shape. Separate deterministic failure tests intercept requests only to produce network, timeout, HTTP and malformed JSON failures; they never replace the regular stable release catalogs. Explicit-prerelease regressions cover single-version manifests and Yarn 6 native releases without adding them to regular counts. It verifies:

- Both locales and all four hash-routed panels, with only one panel visible.
- Input, filter and locale persistence across language switches and reloads.
- A live `18.20` fact filter against official responses.
- All six scenarios, an invalid additional declaration, warning/trace text, accessible labels and the clear-input toast.
- Desktop 1440 × 1000 and mobile 390 × 844, no page-level horizontal overflow, and no Chinese text/ARIA left in English panels.
- No uncaught browser errors; screenshots are written to `.qa/` for local review.

实时版本测试使用八个官方来源，其中 Yarn 原生发行索引模拟其当前只有预发布版的结构；独立失败测试仅模拟网络、超时、HTTP 和 JSON 错误。显式预发布版本回归覆盖单版本清单与 Yarn 6 原生发行版，不将它们加入常规稳定版统计。覆盖所有面板与语言、hash 和状态持久化、真实数据筛选、六种场景、无效输入与警告、无障碍标签、提示消息及桌面/移动布局。截图输出到 `.qa/`，仅用于本地检查，不属于生产数据。

Validated on 2026-09-09 after shared-core integration: TypeScript and website ESLint checks passed; Chromium desktop/mobile regression passed. Tests cover preserved non-ASCII raw inputs, restored Chinese warnings/trace/ARIA/toasts, localized acquisition failures, and cache fallback. The result badge says “Inferred result / Calculated”; unknown lock formats remain valid `*` inference without claiming a frozen-install test pass.

2026-09-09 接入共享核心后，TypeScript、网站 ESLint 及 Chromium 桌面/手机回归均通过。测试覆盖原样保留非 ASCII 输入、中文警告与无障碍文本恢复、获取数据失败的双语消息及缓存回退。结果仅标记为“推断结果 / 已计算”；未知锁格式仍以 `*` 参与推断，不声称冻结安装实测通过。

## Localization / 翻译维护

`src/locales/en.json` and `src/locales/zh-CN.json` contain explicit prose entries. `src/locales/patterns.ts` contains dynamic message templates. `src/i18n.ts` exports `translate` and `getLocale`, and localizes generated text/attributes without replacing form nodes. English mode deliberately leaves unknown new strings detectable, so browser regressions catch untranslated content instead of hiding it. Core messages are rendered through `src/messages.ts`: translate known prose templates, insert raw parameters once, and mark the resulting node non-translatable. Unknown browser failures receive stable localized error codes at the catalog boundary. Never pass raw input, paths, source identifiers, ranges or URLs through prose translation.

`src/locales/en.json`、`src/locales/zh-CN.json` 保存显式译文，`patterns.ts` 保存动态模板。`i18n.ts` 导出 `translate` 和 `getLocale`，原位翻译文本和属性，不重建表单节点。核心消息使用 `messages.ts` 翻译固定模板，参数只插入一次，原始值与完整结果消息节点不再经过 DOM 翻译。浏览器失败在数据边界转换为稳定错误码。新增消息时应补齐双语模板并运行回归。

Live facts list stable official releases and their Node requirements. Package manager rows also show matching lockfile formats from bundled compatibility rules; the complete mapping includes full stable ranges, known installation bugs, data source and generation time. The 23-format inventory comes from `fixtures/recipes.json`; entries without compiled rules remain unknown (`*`) and never count as confirmed matches. Raw maintenance evidence is not bundled into the website.

实时版本表列出官方稳定版本及其 Node 要求，并用随包兼容规则展示匹配的锁格式。完整映射列出稳定版范围、已知安装 bug、数据来源和生成时间。23 种格式目录来自 `fixtures/recipes.json`；没有编译规则的格式标记未知（`*`），不作为已确认匹配。网站不打包维护原始证据。

Selection defaults to stable versions. An explicit declaration in input, packageManager or other project files can allow matching prereleases for that tool using standard semver matching. A prerelease package manager does not opt Node into prereleases; Node needs its own declaration allowing them. Lockfile inference, release statistics and compatibility maintenance remain stable-only.

默认只选择稳定版；input、packageManager 或其他项目文件中的显式声明允许时，可以按标准 semver 匹配采用该工具的预发布版。预发布包管理器不会让 Node 自动选择预发布版；Node 需要自己的显式声明也允许预发布版。锁文件推断、版本统计和兼容数据维护仍只考虑稳定版。
