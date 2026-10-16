# Vant Unity 工程工具

`@kevlns/u-cli-mod`

## 功能

按 Unity Editor 精确版本定位工具链，校验和安装 com.unity.pipeline，并执行工程命令。

## 环境要求

Node.js 20 及以上、Windows 10 及以上；支持的 Editor 版本与 revision 由 routes 命令提供。

## 安装

```sh
npm install -g @kevlns/u-cli-mod
```

## 快速开始

```sh
u-cli-mod routes
u-cli-mod doctor <工程目录>
u-cli-mod setup <工程目录>
```

## 使用说明

### 功能说明

Unity 工程自动化通常需要把「编辑器版本」与「CLI 工具链」精确锁定。u-cli-mod 让这件事在 Windows 上**可复现、可校验、可回滚**：

- **精确版本路由** - 以 `m_EditorVersion` + revision 双重匹配定位路由，没有“就近版本”回退，版本不在路由表内时如实报告而非猜测
- **可验证下载** - Unity CLI 固定 SHA-256 + 文件大小 + Authenticode 签名主体与证书指纹；`com.unity.pipeline` 固定 SHA-256（主）+ SHA-1（交叉）
- **确定性转换** - 在用户缓存中把 `com.unity.pipeline` 适配到 Unity 2022，输出与 `routes/expected-tree/*.json`（385 个文件）逐字节一致
- **事务式安装** - staging → 校验 → 备份 → 替换 → 再校验 → receipt，任一步失败自动回滚；运行中的 Editor 校验失败时拒绝执行
- **工程绑定** - `exec` 每次重新校验 CLI 哈希，并禁止任何 `--project-path` 变体覆盖目标工程

### 操作流程

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

### 工作原理

读取 `ProjectSettings/ProjectVersion.txt` 中的版本和 revision，按精确路由下载并校验工具。安装按暂存、校验、备份、替换、复核、回执顺序执行，失败时回滚。用户缓存位于 `%LOCALAPPDATA%/editor-pipeline-cli`，工程事务记录位于 `Library/editor-pipeline-cli`。缓存生成要求精确字节；已安装文本允许 LF/CRLF 等价，实际内容与二进制仍严格校验。

### 分发边界

- ✅ 只包含本工具自己的 TypeScript 代码、版本路由元数据与哈希清单。
- ✅ Unity CLI 与 `com.unity.pipeline` 在**运行时**从 Unity 官方地址下载到**用户缓存**。
- ❌ 仓库和 npm 包**不包含**任何 Unity 二进制（`.exe`/`.dll`）、tgz 或 `com.unity.pipeline` 源码。
- ❌ 无 `postinstall`；安装 npm 包不会下载或修改任何工程。

### 支持路由

| Editor | Revision | CLI | Pipeline | 状态 |
|---|---|---|---|---|
| `2022.3.62f3c1` | `1623fc0bbb97` | `1.0.0-beta.2` | `0.5.0-exp.1`（适配版） | 已验证（非官方移植） |
| `2022.3.59f1c1` | `6f0f5d6fe989` | `1.0.0-beta.2` | `0.5.0-exp.1`（适配版） | 已验证（非官方移植；与 62f3 共用同一上游 tgz 与补丁规则，适配载荷逐字节一致；2022.3.59f1c1 真机回归通过） |

新增 Editor 版本要求：添加 `routes/<版本>.json` 与 `routes/expected-tree/<版本>.json`、对应转换模板与补丁规则，并在该版本 Unity 上完成编译与回归测试；相近版本不得复用既有路由。

### 目录结构

```text
routes/          精确版本路由；expected-tree/ 子目录为 385 文件 SHA-256 清单（含 Tests.meta）
templates/       Unity 生成的 .meta 模板（数据，非 Unity 源码）
AGENTS.md        AI Agent 使用规范（场景/规范/速览）
src/             TypeScript 实现
tests/           Vitest 单元测试（自编合成 fixture，不含 Unity 源码）
scripts/         pack-guard / preflight-runner / e2e-windows / test-package-install
.github/workflows/  hosted CI + self-hosted E2E
```

## 开发与验证

```sh
npm ci
npm run check
npm run test:package
```

命令返回、结构校验、模拟测试与外部平台实际运行分别核验。发布版本和依赖以随包 `package.json` 为准。

## 文档

[Agent 调用规范](AGENTS.md) · [文档规范](docs/documentation.md) · [自托管 Unity E2E Runner（本地准备指南）](docs/SELF_HOSTED_RUNNER.md)

## 许可与版权

本工具采用 [MIT 许可](LICENSE)。Copyright © 2026 Vant。Vant 为工具集品牌；Figma、Unity、Steam、微信及其组件归各自权利人所有，第三方组件适用各自许可。
