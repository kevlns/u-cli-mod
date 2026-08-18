# u-cli-mod Agent 使用规范

> 本文件是 AI Agent 调用本工具的规范正本。参数全集以 `u-cli-mod <命令> --help` 与 `v-cli.plugin.json`（经 v-cli 路由时用 `v-cli agent describe unity`）为准；本文件只锁定使用场景、调用规范与典型流程。

## 何时使用

- Windows 主机上，需要按**精确 Unity Editor 版本**（版本号 + revision 双重匹配）对 Unity 工程执行：体检诊断、下载固定版本 Unity CLI、事务式安装适配版 `com.unity.pipeline`、执行 Unity Pipeline 命令。
- 命令名 `unity`（经 v-cli 路由：`v-cli unity …`；独立安装时为 `u-cli-mod …`）。

## 核心命令速览

- `u-cli-mod doctor <project>` - 只读体检：路由匹配 / CLI 状态 / 适配包状态
- `u-cli-mod setup <project>` - CLI + 适配包一键就绪（推荐首次入口）
- `u-cli-mod pipeline install <project> --dry-run` - 安装预览（不写入工程）
- `u-cli-mod pipeline install <project>` - 事务式安装适配包（自动备份/回滚/receipt）
- `u-cli-mod exec <project> -- <pipeline-args>` - 执行 Pipeline 命令（工具统一绑定 `--project-path`）
- `u-cli-mod routes` / `u-cli-mod cache clean` - 路由表 / 缓存清理

## 使用规范（Agent 必须遵守）

1. **首次对某工程执行 `exec` 前**，必须确保 `doctor` 通过且适配包已安装（`setup` 或 `pipeline install` 已完成）；未就绪时先跑 `setup`，不要直接 `exec`。
2. **禁止在 `exec` 参数中传入任何 `--project-path` 变体**（`-projectPath`、`--project_path`、大小写混合、`=` 形式等）——目标工程由工具统一绑定，传入即报错是预期保护，不要尝试绕过。
3. **运行中的 Unity Editor 是 fail-closed**：安装被阻止时引导用户先关闭目标工程的 Editor；除非用户显式要求，不得使用 `--allow-running-editor` 绕过。
4. **安装是事务式的**（staging → 校验 → 备份 → 替换 → 再校验 → receipt，失败自动回滚）：不要手动清理工程内 `Packages/com.unity.pipeline` 或 `Library/editor-pipeline-cli`。
5. **版本路由是精确匹配**（`m_EditorVersion` + revision 同时一致），没有"就近版本"回退；工程版本不在路由表内时如实报告支持列表，不得猜测、不得改写 `ProjectVersion.txt`。
6. `exec` 每次调用前都会重新校验 CLI 哈希（防篡改），属正常行为；校验失败按提示跑 `u-cli-mod cli install --force` 修复即可。

## 典型流程

```bash
u-cli-mod doctor <project>        # 1. 体检（只读）
u-cli-mod setup <project>         # 2. 就绪（CLI + 适配包）
u-cli-mod exec <project> -- command editor_status   # 3. 执行
```