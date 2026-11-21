---
name: unity
description: "按 Unity Editor 精确版本定位工具链，校验和安装 com.unity.pipeline，并执行工程命令。"
---
<!-- Copyright © 2026 Vant <sl_kevln@163.com> -->


# Unity 工程

在指定 Unity 工程运行编译、测试或 Pipeline 命令时，把工程路径定到本次工区。已有可用实例直接执行；需要准备环境时用 `routes` 查看支持版本、`doctor <工程>` 核对安装、`setup <工程>` 配置适配器。异步编译与测试按原运行身份取最终报告。

在 Vant 会话的 shell 中，示例里的 `v-cli` 代表插件入口：PowerShell 写作 `node "$env:DSH_VANT_CLI"`，sh 写作 `node "$DSH_VANT_CLI"`。 后接 `unity` 和对应参数。完整参数与交付条件见[操作与边界](references/project.md)。
