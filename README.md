# u-cli-mod

按 **精确 Unity Editor 版本**路由、下载并安装 Unity CLI 与适配后 `com.unity.pipeline` 的命令行工具（**Windows-first**）。

- 仓库：<https://github.com/kevlns/u-cli-mod>
- 包名：`u-cli-mod`（当前 `private: true`，尚未发布）
- **这不是 Unity 官方项目**，与 Unity Technologies 无隶属关系；`com.unity.pipeline` 的 Unity 2022 适配属于非官方移植。

## 本仓库/包 与 不包含

- ✅ 只包含本工具自己的 TypeScript 代码、版本路由元数据与哈希清单。
- ✅ Unity CLI 与 `com.unity.pipeline` 在**运行时**从 Unity 官方地址下载到**用户缓存**。
- ❌ 仓库和 npm 包**不包含**任何 Unity 二进制（`.exe`/`.dll`）、tgz 或 `com.unity.pipeline` 源码。
- ❌ 无 `postinstall`；安装 npm 包不会下载或修改任何工程。

## 原理

1. 读取目标工程 `ProjectSettings/ProjectVersion.txt`，要求 `m_EditorVersion` 与 `m_EditorVersionWithRevision` **同时存在且与路由完全一致**（fail-closed，无通配、无“最近版本”回退）。
2. 按路由下载固定版本的 Unity CLI：HTTPS 白名单（仅 Unity 官方 CDN），校验固定 SHA-256 + 文件大小 + Authenticode 签名主体与证书指纹，临时文件原子更名为最终文件。
3. 按路由下载固定版本的 `com.unity.pipeline` tgz：固定 SHA-256（主）+ SHA-1（交叉），安全解包（解包前逐项拒绝绝对路径、`..`、符号/硬链接等非常规条目）。
4. 在**用户缓存**中确定性转换：`package.json` 最低 Unity 版本、`PhysicsMaterial` 兼容、`rawRenderQueue` 读取兼容、Roslyn DLL 的 `.meta` 转为 Unity 2022 格式（保留 GUID）、删除 `Tests` 源码与失效签名文件；输出必须与 `routes/expected-tree/*.json`（含 `Tests.meta` 共 385 个文件）逐字节一致。
5. 事务式安装到 `Packages/com.unity.pipeline`：staging → 校验 → 备份 → 替换 → 再校验 → receipt；任一步失败自动回滚。运行中的 Unity Editor 会 fail-closed 阻止安装。
6. `exec` 每次调用前重新校验 CLI 哈希，并**禁止任何 `--project-path` 变体覆盖目标工程**。

> **缓存目录说明**：用户缓存默认为 `%LOCALAPPDATA%\editor-pipeline-cli`；该目录名沿用历史名称，以避免破坏已通过验证的缓存/收据契约。工程内的安装事务目录 `Library/editor-pipeline-cli` 同理保留。这两个目录名与 npm 包名 `u-cli-mod` 无关，属于兼容性保留项。

## 安装与构建

```bash
npm ci
npm run build
npm test
npm run lint
npm run pack:guard        # 真实 npm pack + 内容守卫（禁 exe/dll/tgz/Unity 源码）
npm run check            # build + lint + test + pack:guard 一键
```

要求 Node.js >= 20（Windows 10+）。

## 使用

```bash
# 只读检查工程与路由
u-cli-mod doctor C:\Projects\Debussy\debussy-client

# 列出支持的 Editor 路由
u-cli-mod routes

# 下载固定版本 CLI（SHA-256 + Authenticode）
u-cli-mod cli install

# 预览 Pipeline 安装（不写入）
u-cli-mod pipeline install C:\Projects\Debussy\debussy-client --dry-run

# 正式安装（先关闭目标工程的 Unity Editor）
u-cli-mod pipeline install C:\Projects\Debussy\debussy-client

# CLI + Pipeline 一键准备
u-cli-mod setup C:\Projects\Debussy\debussy-client

# 执行 Unity Pipeline 命令（自动绑定目标工程）
u-cli-mod exec C:\Projects\Debussy\debussy-client -- command editor_status
u-cli-mod exec C:\Projects\Debussy\debussy-client -- command get_scene_hierarchy

# 清理缓存
u-cli-mod cache clean
```

`exec` 会把 `--project-path <工程>` 追加到 Unity CLI 参数末尾；传入任何形式的 `--project-path`（含 `-projectPath`、`--projectPath`、大小写混合）会直接报错。

发布后也可 `npx u-cli-mod ...` 使用；当前版本尚未发布（`private: true`）。

## 质量与 CI

### 单元测试与打包守卫

```bash
npm run check          # build + lint + 94 个 vitest 测试 + pack guard
```

`pack:guard` 会执行真实 `npm pack`（含文件清单校验），断言发布包：

- 包名为 `u-cli-mod`、tgz 文件名为 `u-cli-mod-*`；
- 不出现：

```text
*.exe  *.dll  *.tgz  *.pdb
*.cs   *.unity  *.asmdef  *.prefab  *.asset
完整 com.unity.pipeline 目录树
```

### 本地 tarball 安装矩阵（三模式验证）

```bash
npm run test:package
```

构建真实 tgz，并在本地验证三种消费方式：工程 devDependency（`node_modules/.bin`）、
带临时 `--prefix` 的全局安装、`npx --package <本地tgz>`；每种都执行 `u-cli-mod --version` 与
`u-cli-mod routes`。**不会**向任何 registry 发布。报告：`C:/tmp/u-cli-mod-package-test-report.json`。

### 自托管 Runner 与 Unity E2E

```bash
npm run preflight:runner   # 注册前环境预检（Node/npm/Git/Unity 版本/revision/许可证探针）
npm run e2e:windows        # 完整 Unity E2E（真实下载/转换/编译/命令/重载/重启/多编辑器）
```

- `preflight:runner` 只读，不下载/注册 Runner；结果 JSON 输出到 stdout。
- `e2e:windows` 使用**隔离缓存**（干净环境）或显式复用已验证缓存，创建 `C:/tmp/u-cli-mod-e2e/` 下独立临时工程，全部结束后杀掉它启动的所有 Unity 进程并清理临时工程；报告写入 `C:/tmp/u-cli-mod-e2e-report.json`。
- 验收指标：200 次只读调用 100% 成功并记录 P50/P95、20 轮资源修改、5 次 Domain Reload 首次恢复、强杀重启恢复、双工程显式路由 60 次无误选、运行中 Editor 防护与 `--project-path` 覆盖拒绝。

详细说明见 `docs/SELF_HOSTED_RUNNER.md`。

### GitHub Actions

- `.github/workflows/ci.yml`：hosted windows runner 上跑 `npm ci` + `npm run check` + `npm audit --omit=dev` + 禁用扩展名扫描；push/PR 触发。
- `.github/workflows/e2e-windows.yml`：**self-hosted** runner（标签 `self-hosted/windows/unity-2022.3.62f3c1`）上跑 Unity E2E；仅 `workflow_dispatch` 与受保护 `v*` tag 触发，不跑 pull_request，不发布；权限最小化（contents: read）；产物 `u-cli-mod-e2e-report`。

## 支持的路由

| Editor | Revision | CLI | Pipeline | 状态 |
|---|---|---|---|---|
| `2022.3.62f3c1` | `1623fc0bbb97` | `1.0.0-beta.2` | `0.5.0-exp.1`（适配版） | 已验证（非官方移植） |

新增 Editor 版本时必须：新增 `routes/<版本>.json` 与 `routes/expected-tree/<版本>.json`、对应转换模板与补丁规则，并在该版本 Unity 上重新完成编译与回归测试。不得让相近版本复用既有路由。

## 目录

```text
routes/          精确版本路由 + expected-tree 哈希清单
routes/expected-tree/   385 文件 SHA-256 清单（含 Tests.meta）
templates/       Unity 生成的 .meta 模板（数据，非 Unity 源码）
src/             TypeScript 实现
tests/           Vitest 单元测试（自编合成 fixture，不含 Unity 源码）
scripts/         pack-guard / preflight-runner / e2e-windows / test-package-install
.github/workflows/  hosted CI + self-hosted E2E
```

## 许可

本工具代码为 MIT（见 LICENSE）。运行时下载的 Unity CLI 与 `com.unity.pipeline` 归其各自的 Unity 许可（如 Unity Package Distribution License）约束，不在本仓库/包内分发。本工具与 Unity 无关，非官方项目。