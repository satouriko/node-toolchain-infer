# Publishing / 发布

The `Publish npm package` workflow publishes tags named `v<package.json version>` through the GitHub `npm` Environment. It runs the shared Node 18/24 checks, packs the package, installs and exercises that tarball on both runtimes, then publishes to the public npm registry using OIDC with provenance. Stable versions use `latest`; prereleases use `next`.

`Publish npm package` 工作流通过 GitHub 的 `npm` Environment 发布 `v<package.json version>` 标签。先执行共享的 Node 18/24 检查，再打包并在两个运行时安装、验证同一份产物，最后通过 OIDC 发布到 npm 公共仓库，附带构建来源证明。稳定版使用 `latest`，预发布版使用 `next`。

## Trusted publisher / 可信发布

Configure the npm trusted publisher with these exact values and allow direct publishing:

在 npm 配置以下可信发布信息，并允许 `npm publish`：

| Field / 字段                   | Value / 值                       |
| ------------------------------ | -------------------------------- |
| Repository / 仓库              | `satouriko/node-toolchain-infer` |
| Workflow filename / 工作流文件 | `publish.yml`                    |
| Environment / 环境             | `npm`                            |
| Permission / 权限              | `--allow-publish`                |

With npm CLI >=11.15.0 and an authenticated package owner:

使用 npm CLI >=11.15.0，并以包维护者身份登录后执行：

```sh
npm trust github node-toolchain-infer --repo satouriko/node-toolchain-infer --file publish.yml --environment npm --allow-publish --registry=https://registry.npmjs.org
```

The package must already exist before its first trusted publisher can be configured. Bootstrap the first release by publishing the verified tarball after interactive npm login, then configure trust. The workflow accepts an existing version only when its registry integrity exactly matches the packed bytes; it reports verification rather than publishing again. Different bytes for an existing version fail the workflow.

首次绑定可信发布前，npm 要求包已经存在。首次发布通过交互式 npm 登录，发布已经验证的 tarball，然后配置可信发布。工作流遇到已有版本时，只有注册表 integrity 与本次打包字节完全一致才通过，并明确记录为验证已有发布；字节不一致则失败，不覆盖已有版本。

For subsequent releases, update the package version, commit and push the changes, then push its matching `v` tag. Manual retries use `gh workflow run publish.yml --ref v<version>`. GitHub Actions uses its OIDC identity; no npm token is stored in GitHub secrets.

后续发布先更新包版本、提交并推送，再推送匹配的 `v` 标签。手动重试使用 `gh workflow run publish.yml --ref v<version>`。GitHub Actions 使用 OIDC 身份，不在 GitHub Secrets 保存 npm token。

References / 参考：[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/), [npm trust](https://docs.npmjs.com/cli/v11/commands/npm-trust/).
