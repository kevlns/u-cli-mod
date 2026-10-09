<div align="center">

<img src="https://raw.githubusercontent.com/kevlns/u-cli-mod/main/logo.png" alt="u-cli-mod logo" width="320" />

# u-cli-mod

**按精确 Unity Editor 版本路由、下载并安装 Unity CLI 与适配后 `com.unity.pipeline` 的命令行工具（Windows-first）。**

[![npm version](https://img.shields.io/npm/v/%40kevlns%2Fu-cli-mod?style=flat-square&color=cb3837)](https://www.npmjs.com/package/@kevlns/u-cli-mod)
[![npm downloads](https://img.shields.io/npm/dm/%40kevlns%2Fu-cli-mod?style=flat-square&color=4c8bf5)](https://www.npmjs.com/package/@kevlns/u-cli-mod)
[![CI](https://img.shields.io/github/actions/workflow/status/kevlns/u-cli-mod/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/kevlns/u-cli-mod/actions/workflows/ci.yml)
[![license](https://img.shields.io/github/license/kevlns/u-cli-mod?style=flat-square&color=2e8b57)](./LICENSE)

[Getting started](#getting-started) · [Usage](#usage) · [Routes](#routes) · [Package family](#package-family)

</div>

---

> **这不是 Unity 官方项目**，与 Unity Technologies 无隶属关系；`com.unity.pipeline` 的 Unity 2022 适配属于非官方移植。

## Why u-cli-mod?

Unity 工程自动化通常需要把「编辑器版本」与「CLI 工具链」精确锁定。u-cli-mod 让这件事在 Windows 上**可复现、可校验、可回滚**：

- **精确版本路由** - 以 `m_EditorVersion` + revision 双重匹配定位路由，没有“就近版本”回退，版本不在路由表内时如实报告而非猜测
- **可验证下载** - Unity CLI 固定 SHA-256 + 文件大小 + Authenticode 签名主体与证书指纹；`com.unity.pipeline` 固定 SHA-256（主）+ SHA-1（交叉）
- **确定性转换** - 在用户缓存中把 `com.unity.pipeline` 适配到 Unity 2022，输出与 `routes/expected-tree/*.json`（385 个文件）逐字节一致
- **事务式安装** - staging → 校验 → 备份 → 替换 → 再校验 → receipt，任一步失败自动回滚；运行中的 Editor fail-closed
- **工程绑定** - `exec` 每次重新校验 CLI 哈希，并禁止任何 `--project-path` 变体覆盖目标工程

## Getting started

### Install

```bash
npm install -g @kevlns/u-cli-mod

# 或不安装，直接运行：
npx --package @kevlns/u-cli-mod u-cli-mod routes
```

要求 Node.js >= 20（Windows 10+）。

### Quick start

```bash
u-cli-mod doctor <project>    # 只读体检：路由 / CLI / 适配包状态
u-cli-mod setup <project>     # CLI + 适配包一键就绪（推荐首次入口）
u-cli-mod routes              # 列出支持的 Editor 路由
```

升级 npm 包不会自动替换已有工程的 `Packages/com.unity.pipeline`。检查 `doctor` 的 `pipeline.state`：只有 `current` 且 `installed=true` 才表示当前补丁完整；`outdated`/`invalid` 时关闭目标 Unity Editor 后执行 `u-cli-mod pipeline install <project> --force`（自动备份）。`patchVersion` 是路由要求，`installedPatchVersion` 来自安装 receipt；仅看到上游版本 `0.5.0-exp.1` 或诊断退出码 0 不代表适配包已更新。

就绪状态以当前路由的完整文件树为准，旧 receipt、缺失 receipt 或生成缓存未就绪均不会推翻已通过校验的安装。`pipeline.verification` 提供 `mismatches`、`lineEndingDifferences` 和 `error`，可直接定位失效原因。新生成的文本统一 LF；已安装 UTF-8 文本只接受 LF/CRLF 的等价差异，不忽略 BOM、空白、实际内容、缺失或额外文件，二进制保持 SHA-256 严格校验。生成缓存与安装 staging 仍要求精确字节。

## Usage

> 示例中的 `<project>` 指代你的 Unity 工程目录，请替换为实际路径。

```bash
# 只读检查工程与路由
u-cli-mod doctor <project>

# 列出支持的 Editor 路由
u-cli-mod routes

# 下载固定版本 CLI（SHA-256 + Authenticode）
u-cli-mod cli install

# 预览 Pipeline 安装（不写入）
u-cli-mod pipeline install <project> --dry-run

# 正式安装（先关闭目标工程的 Unity Editor）
u-cli-mod pipeline install <project>

# CLI + Pipeline 一键准备
u-cli-mod setup <project>

# 执行 Unity Pipeline 命令（自动绑定目标工程）
u-cli-mod exec <project> -- command editor_status
u-cli-mod exec <project> -- command get_scene_hierarchy
u-cli-mod exec <project> -- command read_console --types error,warning --count 100

# 长任务（run_tests）默认等待 5s 后让出控制权，任务继续在 Editor 内执行
u-cli-mod exec <project> -- command run_tests --mode EditMode
# 随后轮询结果
u-cli-mod exec <project> -- command test_status
# 需要同步拿到完整 Summary 时放宽等待上限（秒）
u-cli-mod exec <project> --wait 120 -- command run_tests --mode EditMode --filter Game.AI.Tests

# 清理缓存
u-cli-mod cache clean
```

`exec` 会把 `--project-path <工程>` 追加到 Unity CLI 参数末尾；传入任何形式的 `--project-path`（含 `-projectPath`、`--projectPath`、大小写混合）会直接报错。

长任务（`run_tests`）默认只等待 5 秒：到点后任务仍在 Unity Editor 内继续执行，工具打印输出日志路径并立即返回（退出码 0）；结果用 `command test_status` 轮询，需要同步等待时用 `--wait <秒>`（`0` = 立即返回）。

## 原理

1. 读取目标工程 `ProjectSettings/ProjectVersion.txt`，要求 `m_EditorVersion` 与 `m_EditorVersionWithRevision` **同时存在且与路由完全一致**（fail-closed，无通配、无“最近版本”回退）。
2. 按路由下载固定版本的 Unity CLI：HTTPS 白名单（仅 Unity 官方 CDN），校验固定 SHA-256 + 文件大小 + Authenticode 签名主体与证书指纹，临时文件原子更名为最终文件。
3. 按路由下载固定版本的 `com.unity.pipeline` tgz：固定 SHA-256（主）+ SHA-1（交叉），安全解包（解包前逐项拒绝绝对路径、`..`、符号/硬链接等非常规条目）。
4. 在**用户缓存**中确定性转换：`package.json` 最低 Unity 版本、`PhysicsMaterial` 兼容、`rawRenderQueue` 读取兼容、基于 `UnityEditor.LogEntries` 的 `read_console`、Roslyn DLL 的 `.meta` 转为 Unity 2022 格式（保留 GUID）、删除 `Tests` 源码与失效签名文件；输出必须与 `routes/expected-tree/*.json`（含 `Tests.meta` 共 385 个文件）逐字节一致。
5. 事务式安装到 `Packages/com.unity.pipeline`：staging → 校验 → 备份 → 替换 → 再校验 → receipt；任一步失败自动回滚。运行中的 Unity Editor 会 fail-closed 阻止安装。
6. `exec` 每次调用前重新校验 CLI 哈希，并**禁止任何 `--project-path` 变体覆盖目标工程**。

> **缓存目录说明**：用户缓存固定为 `%LOCALAPPDATA%\editor-pipeline-cli`，工程内的安装事务目录固定为 `Library/editor-pipeline-cli`。两个目录名是缓存与 receipt 契约的一部分，不随 npm 包名（`@kevlns/u-cli-mod`）变化；改名会使既有缓存与 receipt 失效。

## 包内容与分发边界

- ✅ 只包含本工具自己的 TypeScript 代码、版本路由元数据与哈希清单。
- ✅ Unity CLI 与 `com.unity.pipeline` 在**运行时**从 Unity 官方地址下载到**用户缓存**。
- ❌ 仓库和 npm 包**不包含**任何 Unity 二进制（`.exe`/`.dll`）、tgz 或 `com.unity.pipeline` 源码。
- ❌ 无 `postinstall`；安装 npm 包不会下载或修改任何工程。

## 质量与 CI

### 单元测试与打包守卫

```bash
npm run check          # build + lint + vitest 测试 + pack guard
```

> 发版除 `npm version` 外，还需同步 tests/scripts 中的版本断言（`cli.test.ts`、`vcli-manifest.test.ts`、`pack-guard.mjs`、`test-package-install.mjs`）：grep 旧版本号应为零，再打 tag。

`pack:guard` 会执行真实 `npm pack`（含文件清单校验），断言发布包：

- 包名为 `@kevlns/u-cli-mod`，tgz 文件名精确为 `kevlns-u-cli-mod-0.2.3.tgz`（与 package.json 版本一致）；
- `files` 必须包含 `v-cli.plugin.json`，且清单身份字段（schemaVersion/package/command/bin/platforms）与包一致；
- 不出现：

```text
*.exe  *.dll  *.tgz  *.pdb
*.cs   *.unity  *.asmdef  *.prefab  *.asset
完整 com.unity.pipeline 目录树
```

### v-cli 插件清单

`v-cli.plugin.json` 随包发布（`package.json` 中 `vCli.manifest` 指向），声明 v-cli 命令 `unity`（平台 win32）与全部公共命令路径、参数、选项、输出与副作用元数据。`tests/vcli-manifest.test.ts` 以 `buildProgram()` 为行为源校验清单：命令树、参数、选项（flags 与描述）、usage 逐项一致；同一测试还把 AGENTS.md 的 154 条 Pipeline 命令目录与清单逐条互锁——两处任一未同步都会失败。

### 本地 tarball 安装矩阵（三模式验证）

```bash
npm run test:package
```

构建真实 tgz，并在本地验证三种消费方式：工程 devDependency（`node_modules/.bin`）、带临时 `--prefix` 的全局安装、`npx --package <本地tgz>`；每种都执行 `u-cli-mod --version` 与 `u-cli-mod routes`。**不会**向任何 registry 发布。报告：`C:/tmp/u-cli-mod-package-test-report.json`（可用 `EPC_PKG_REPORT` 覆盖）。

### 自托管 Runner 与 Unity E2E

```bash
npm run preflight:runner   # 注册前环境预检（Node/npm/Git/Unity 版本/revision/许可证探针）
npm run e2e:windows        # 完整 Unity E2E（真实下载/转换/编译/命令/重载/重启/多编辑器）
```

- `preflight:runner` 只读，不下载/注册 Runner；结果 JSON 输出到 stdout。
- `e2e:windows` 默认使用隔离缓存（设 `EPC_E2E_FRESH_CACHE=0` 可复用真实用户缓存），在 `C:/tmp/u-cli-mod-e2e/` 下创建独立临时工程，全部结束后杀掉它启动的所有 Unity 进程并清理临时工程；报告写入 `C:/tmp/u-cli-mod-e2e-report.json`（分别可用 `EPC_E2E_ROOT`、`EPC_E2E_REPORT` 覆盖）。
- 验收指标：200 次只读调用 100% 成功并记录 P50/P95、`read_console` 原生 Console 历史读取与统一清理、20 轮资源修改、5 次 Domain Reload 首次恢复、强杀重启恢复、双工程显式路由 60 次无误选、运行中 Editor 防护与 `--project-path` 覆盖拒绝。

详细说明见 `docs/SELF_HOSTED_RUNNER.md`。

### GitHub Actions

- `.github/workflows/ci.yml`：hosted windows runner 上跑 `npm ci` + `npm run check` + `npm audit --omit=dev` + 违禁产物扩展名扫描；push/PR 触发。
- `.github/workflows/e2e-windows.yml`：**self-hosted** runner（标签 `self-hosted/windows/unity-2022.3.62f3c1`）上跑 Unity E2E；仅 `workflow_dispatch` 与受保护 `v*` tag 触发，不跑 pull_request，不发布；权限最小化（contents: read）；产物 `u-cli-mod-e2e-report`。
- `.github/workflows/publish.yml`：`v*` tag 触发，GitHub 托管 runner 上以 OIDC Trusted Publisher 短期凭证发布到 npm，不保存长期 NPM_TOKEN。

## Routes

| Editor | Revision | CLI | Pipeline | 状态 |
|---|---|---|---|---|
| `2022.3.62f3c1` | `1623fc0bbb97` | `1.0.0-beta.2` | `0.5.0-exp.1`（适配版） | 已验证（非官方移植） |
| `2022.3.59f1c1` | `6f0f5d6fe989` | `1.0.0-beta.2` | `0.5.0-exp.1`（适配版） | 已验证（非官方移植；与 62f3 共用同一上游 tgz 与补丁规则，适配载荷逐字节一致；2022.3.59f1c1 真机回归通过） |

新增 Editor 版本要求：添加 `routes/<版本>.json` 与 `routes/expected-tree/<版本>.json`、对应转换模板与补丁规则，并在该版本 Unity 上完成编译与回归测试；相近版本不得复用既有路由。

## 目录

```text
routes/          精确版本路由；expected-tree/ 子目录为 385 文件 SHA-256 清单（含 Tests.meta）
templates/       Unity 生成的 .meta 模板（数据，非 Unity 源码）
AGENTS.md        AI Agent 使用规范（场景/规范/速览）
src/             TypeScript 实现
tests/           Vitest 单元测试（自编合成 fixture，不含 Unity 源码）
scripts/         pack-guard / preflight-runner / e2e-windows / test-package-install
.github/workflows/  hosted CI + self-hosted E2E
```

## Package family

kevlns 工具家族共享同一套发布约定（tag 驱动、CI 护栏、MIT）。

| Package | Purpose | Version |
| --- | --- | --- |
| [`v-cli`](https://github.com/kevlns/v-cli) | 个人工具箱 CLI | v0.2.14 |
| [`xlmerge`](https://github.com/kevlns/xlmerge) | Git 中 .xlsx/.xlsm 冲突可视化解决工具 | v2.0.0 |
| [`u-cli-mod`](https://github.com/kevlns/u-cli-mod) | Unity 精确版本路由 + CLI + pipeline 包（Windows-first，本仓库） | v0.2.3 |
| [`figma-to-uprefab`](https://github.com/kevlns/figma-to-uprefab) | Figma 导出、契约校验与 Unity UGUI staging Prefab 构建 | v0.1.1 |

## Compatibility

| Runtime | Supported versions |
| --- | --- |
| Node.js | `20` and later |
| Unity Editor | `2022.3.62f3c1` / `2022.3.59f1c1`（精确路由，见 Routes） |

## Contributing

```bash
npm ci
npm run check          # build + lint + vitest 测试 + pack guard
```

For bugs and feature requests, use [GitHub Issues](https://github.com/kevlns/u-cli-mod/issues).

## License

本工具代码为 MIT（见 LICENSE）。运行时下载的 Unity CLI 与 `com.unity.pipeline` 归其各自的 Unity 许可（如 Unity Package Distribution License）约束，不在本仓库/包内分发。

<div align="center">

Part of the **kevlns** tool family.

</div>
