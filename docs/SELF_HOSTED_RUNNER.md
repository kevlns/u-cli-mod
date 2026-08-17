# 自托管 Unity E2E Runner（本地准备指南）

仓库：github.com/kevlns/u-cli（Windows-first，非 Unity 官方项目）。
本目录代码不含任何发布能力。以下内容是 **注册前检查清单**。实际注册
应在 GitHub 仓库 `Settings -> Actions -> Runners` 中完成（需要仓库管理员权限），
本工具只会做只读预检，**不会下载或注册 Runner**。

## 建议机器

- 专用 Windows 10/11 或 Windows Server 虚拟机（推荐），或专用物理机。
- 至少 8 GB 内存、20 GB 空闲磁盘。
- 不建议长期使用日常开发机，避免执行仓库内不可信任务。

## 必须安装

| 组件 | 要求 | 验证 |
|---|---|---|
| Windows | 10/11 x64 | `winver` |
| Git | >= 2.40 | `git --version` |
| Node.js | >= 20 LTS | `node --version` |
| npm | 随 Node | `npm --version` |
| Unity Hub | 任意近期版本 | - |
| Unity Editor | `2022.3.62f3c1`，含 Windows build support | 见下方预检 |
| Unity 许可证 | 可用的个人/专业许可 | 预检中的 license probe |

## 预检命令（不注册、不下载、只读）

```powershell
cd C:\Projects\u-cli
npm ci
npm run build
npm run preflight:runner
```

输出为 JSON：`pass: true` 且所有 `checks[].ok` 为 true 时，环境即可注册。
预检包含一个 Unity batchmode 许可证探针（在临时目录创建一次性 scratch
工程并 `-quit`，结束后删除），耗时约 1–3 分钟；
可用 `EPC_PREFLIGHT_SKIP_LICENSE=1` 跳过。

常用环境变量：

- `EPC_UNITY_PATH`：Unity.exe 自定义路径。
- `EPC_RUNNER_DIR`：建议的 Runner 目录（默认 `C:\unity-runner`）。
- `EPC_PREFLIGHT_VERSION` / `EPC_PREFLIGHT_REVISION`：期望的 Editor 版本/revision。

## 注册后标签

Runner 必须带以下标签，E2E 工作流才会路由到它：

```text
self-hosted
windows
unity-2022.3.62f3c1
```

建议注册命令（示例，以仓库页面给出的为准）：

```powershell
# 在 C:\unity-runner 下执行 GitHub 给出的注册命令，并追加：
.\config.cmd --labels self-hosted,windows,unity-2022.3.62f3c1
```

## 安全策略

- E2E 工作流**只**从 `workflow_dispatch` 与受保护 tag（`v*`）触发，
  **不运行 pull_request**，避免不可信 Fork 代码在自托管机器上执行。
- Runner 机器不放生产密钥；npm 发布凭证只在发布 job 提供（当前无发布 job）。
- 建议在 VM 上启用快照/恢复点；E2E 会在 finally 中清理其生成的 Unity 进程
  与临时工程，但快照仍是兜底。
- Unity 许可证建议使用专用 CI 授权或浮动许可证环境。
- 定期更新 Runner 与 Unity Patch；升级 Unity 版本必须在
  `routes/<版本>.json` 新增独立路由并完成回归后才能使用。

## 自测（不依赖 GitHub）

注册前可在本机完整跑一遍 E2E：

```powershell
npm run e2e:windows
```

报告默认写入 `C:/tmp/u-cli-e2e-report.json`。E2E 使用隔离缓存
（`EPC_E2E_FRESH_CACHE=1`）并清理所有它启动的 Unity 进程。