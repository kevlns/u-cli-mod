# Vant Unity 工程工具 Agent 规范

## 定位

按 Unity Editor 精确版本定位工具链，校验和安装 com.unity.pipeline，并执行工程命令。

## 调用流程

```sh
u-cli-mod routes
u-cli-mod doctor <工程目录>
u-cli-mod setup <工程目录>
```

首次调用前读取本规范，使用命令帮助或插件清单核对参数和执行范围。

## 调用规范

> 本文件是 AI Agent 调用本工具的规范正本。参数全集以 `u-cli-mod <命令> --help` 与 `v-cli.plugin.json`（经 v-cli 路由时用 `v-cli agent describe unity`）为准；本文件只锁定使用场景、调用规范与典型流程。

### 何时使用

- Windows 主机上，需要按**精确 Unity Editor 版本**（版本号 + revision 双重匹配）对 Unity 工程执行：体检诊断、下载固定版本 Unity CLI、事务式安装适配版 `com.unity.pipeline`、执行 Unity Pipeline 命令。
- 命令名 `unity`（经 v-cli 路由：`v-cli unity …`；直接安装时为 `u-cli-mod …`）。

### 核心命令速览

- `u-cli-mod doctor <project>` - 只读体检：路由匹配 / CLI 状态 / 适配包状态
- `u-cli-mod setup <project>` - CLI + 适配包一键就绪（推荐首次入口）
- `u-cli-mod pipeline install <project> --dry-run` - 安装预览（不写入工程）
- `u-cli-mod pipeline install <project>` - 事务式安装适配包（自动备份/回滚/receipt）
- `u-cli-mod exec <project> [--wait <秒>] -- <pipeline-args>` - 执行 Pipeline 命令（工具统一绑定 `--project-path`）；长任务（`run_tests`）默认 5s 后让出控制权，结果用对应的 `command <name>_status` 轮询
- `u-cli-mod routes` / `u-cli-mod cache clean` - 路由表 / 缓存清理

Pipeline 命令全集见文末「Pipeline 工具清单」（适配版 `com.unity.pipeline`，按领域分组）。

### 使用规范（Agent 必须遵守）

1. **首次对某工程执行 `exec` 前**，必须检查 `doctor` 的 `cli.state="valid"`、`pipeline.state="current"` 且 `pipeline.installed=true`。`doctor` 退出成功仅表示诊断完成，不代表工程已就绪；`pipeline.present=true` 也只表示包存在。`missing` 时先跑 `setup`；`outdated`/`invalid` 时先关闭目标 Editor，再通过 `pipeline install <project> --force` 备份并更新。升级 npm 包不会自动更新工程内适配包，不要直接 `exec`。
2. **禁止在 `exec` 参数中传入任何 `--project-path` 变体**（`-projectPath`、`--project_path`、大小写混合、`=` 形式等）——目标工程由工具统一绑定，传入即报错是预期保护，不要尝试绕过。
3. **运行中的 Unity Editor 是 校验失败时拒绝执行**：安装被阻止时引导用户先关闭目标工程的 Editor；除非用户显式要求，不得使用 `--allow-running-editor` 绕过。
4. **安装是事务式的**（staging → 校验 → 备份 → 替换 → 再校验 → receipt，失败自动回滚）：不要手动清理工程内 `Packages/com.unity.pipeline` 或 `Library/editor-pipeline-cli`。
5. **版本路由是精确匹配**（`m_EditorVersion` + revision 同时一致），没有"就近版本"回退；工程版本不在路由表内时如实报告支持列表，不得猜测、不得改写 `ProjectVersion.txt`。
6. `exec` 每次调用前都会重新校验 CLI 哈希（防篡改），属正常行为；校验失败按提示跑 `u-cli-mod cli install --force` 修复即可。
7. **读取 Editor 当前 Console 首选 `command read_console`**，`command console` 读取回调捕获流，适合 `since`/cursor 跟随，但不能代替原生 Console 快照。工具必须经 `command <名>` 调用。若实际 schema 中缺少 `read_console`，先检查 `doctor` 的 `patchVersion`/`installedPatchVersion` 和 `state`，不要将其误认成 `console` 的别名。
8. **全量测试必须走 `--async_tests`**：Unity CLI 对同步命令有 30 秒硬性等待上限（`--timeout` 无法延长），同步 `run_tests` 全量必然超时且不入 `test_status` 跟踪。用法：`run_tests --mode EditMode --async_tests`（立即返回）→ 轮询 `test_status` 至 `completed` 拿完整 Summary；小范围用 `--filter` 缩到单命名空间/类，可直接同步等待拿 Summary。
9. **任务身份**：`run_tests --async_tests` 的响应含 `RunId`；`test_status --run_id <id>` 只返回该次运行的记录（不存在/被顶替时返回 `unknown_run`，**绝不回退最近一次**）；`cancel_tests --run_id <id>` 定向取消（不匹配或无活动运行返回 `unknown_run`/`no_active_run` 且零副作用）。`recompile` 响应含 `runId`，`recompile_status --run_id <id>` 同语义（引擎自发编译的终态 `runId` 为 null，按 id 查询即 `unknown_run`）。连续启动会替换当前追踪槽位；无法关联的 run_id 返回 unknown_run，不能当作其他运行的结果。已知限制：`recompile` 连发时后发 runId 会覆盖 pending id，前一编译批次的引擎事件终态记在后发 id 名下（旧 id 查询 `unknown_run` 正确拒绝）。

### 典型流程

```bash
u-cli-mod doctor <project>        # 1. 体检（只读）
u-cli-mod setup <project>         # 2. 就绪（CLI + 适配包）
u-cli-mod exec <project> -- command editor_status   # 3. 执行
u-cli-mod exec <project> -- command run_tests --mode EditMode --filter <命名空间或类名>  # 小范围：同步返回 Summary
u-cli-mod exec <project> -- command run_tests --mode EditMode --async_tests             # 全量：立即返回，轮询 test_status
u-cli-mod exec <project> -- command read_console --types error,warning --count 100
```

### doctor 输出要点

`doctor.pipeline` 的 `patchVersion` 为当前路由要求的补丁版本，`installedPatchVersion` 为 receipt 记录的版本（缺失或未知为 null）；`state` 为 `missing | outdated | invalid | current`。完整 expected-tree 校验通过即返回 `installed=true` / `current`，receipt 缺失或过期不触发重装。`verification` 列出内容不匹配、校验错误及仅行尾差异的文件。已安装 UTF-8 文本允许 LF/CRLF 等价，其他内容及二进制仍严格校验；生成源与 staging 保持字节级校验，新生成文本统一 LF。`sourceReady=false` 仅表示生成缓存需重建，不代表已安装包失效。

### Pipeline 工具清单

> 安装的 `com.unity.pipeline`（适配版 0.5.0-exp.1）共 **154** 个命令，经 `u-cli-mod exec <project> -- command <名> [参数]` 透传执行；参数全集以 `exec <project> -- command <名> --help` 为准。

#### GameObject / 组件
- `add_component` — 添加组件。
- `create_gameobject` — 创建场景对象。
- `create_gameobjects` — 批量创建场景对象。
- `delete_gameobject` — 删除场景对象，支持撤销。
- `find_gameobjects` — 按名称、标签、组件或层级路径查找场景对象。
- `get_component_properties` — 读取组件序列化属性。
- `remove_component` — 移除指定组件。
- `rename_gameobject` — 重命名场景对象。
- `set_active` — 设置对象激活状态。
- `set_component_properties` — 设置组件序列化属性，支持 ObjectRef 引用。
- `set_layer` — 设置对象层，编号范围 0–31。
- `set_parent` — 设置父对象；未指定父对象时移至场景根。
- `set_tag` — 设置工程中已存在的标签。
- `set_transform` — 设置局部坐标、欧拉旋转和缩放，省略项不变。

#### 场景
- `add_scene_to_build` — 将场景加入构建列表。
- `create_scene` — 创建并保存场景。
- `get_scene_hierarchy` — 读取场景层级及 instanceId、hierarchyPath。
- `list_open_scenes` — 列出已打开场景及加载、激活、未保存状态。
- `open_scene` — 打开场景。
- `remove_scene_from_build` — 从构建列表移除场景。
- `save_all` — 保存所有已修改场景和资源。
- `save_scene` — 保存场景。
- `set_active_scene` — 设置活动场景。

#### 资源 / 文件
- `copy_asset` — 复制资源。
- `create_asset` — 创建指定类型的资源。
- `create_folder` — 创建目录。
- `delete_asset` — 删除资源。需要 confirm=true。
- `find_assets` — 查找资源。
- `get_import_settings` — 读取资源导入设置。
- `import_asset` — 导入或重新导入资源。
- `move_asset` — 移动资源。
- `read_text_file` — 读取文本文件。
- `rename_asset` — 重命名资源。
- `set_import_settings` — 设置资源导入参数。
- `write_text_file` — 写入文本文件。需要 confirm=true。

#### 预制体
- `apply_prefab_overrides` — 将实例覆盖应用到预制体。
- `create_prefab` — 从场景对象创建预制体。
- `create_prefab_variant` — 创建预制体变体。
- `instantiate_prefab` — 将预制体实例化到场景。
- `revert_prefab_overrides` — 还原预制体实例覆盖。
- `save_prefab_contents` — 保存预制体内容。
- `unpack_prefab` — 解包预制体实例。

#### 材质 / 着色器
- `get_material_properties` — 读取材质属性。
- `get_shader_properties` — 读取着色器属性。
- `list_shaders` — 列出着色器。
- `set_material_properties` — 设置材质属性。

#### 脚本 / 编译 / 求值
- `attach_script` — 将脚本组件添加到对象。
- `cleanup_hotreload` — 清理热重载资源。
- `create_script` — 创建脚本文件。
- `eval` — 执行 C# 表达式或代码。
- `eval_file` — 执行文件中的 C# 代码。
- `get_serialized_fields` — 读取序列化字段。
- `hotreload_status` — 查询热重载状态。
- `recompile` — 触发编译并返回运行身份。
- `recompile_status` — 按 run_id 查询编译；无法关联时返回 unknown_run。
- `reload_file` — 重载脚本文件。
- `reload_file_override` — 重载脚本并明确应用覆盖。
- `set_serialized_field` — 设置序列化字段。

#### 动画 / Timeline
- `add_animator_layer` — 添加动画控制器层。
- `add_animator_parameter` — 添加动画参数。
- `add_animator_state` — 添加动画状态。
- `add_animator_transition` — 添加动画过渡。
- `add_timeline_clip` — 添加 Timeline 片段。
- `add_timeline_track` — 添加 Timeline 轨道。
- `create_animation_clip` — 创建动画片段。
- `create_animator_controller` — 创建动画控制器。
- `create_timeline` — 创建 Timeline。
- `get_animation_clip` — 读取动画片段。
- `get_animator_controller` — 读取动画控制器。
- `get_timeline` — 读取 Timeline。
- `remove_animation_curve` — 移除动画曲线。需要 confirm=true。
- `set_animation_curve` — 设置动画曲线。

#### 构建
- `build` — 执行构建。可用 dry_run 预演。
- `build_status` — 查询构建状态。
- `get_build_settings` — 读取构建设置。
- `list_build_profiles` — 列出构建配置。
- `list_build_targets` — 列出构建目标。
- `set_build_settings` — 设置构建参数。可用 dry_run 预演。
- `switch_build_target` — 切换构建目标。需要 confirm=true。
- `switch_build_target_status` — 查询构建目标切换结果。

#### 包管理
- `package_add` — 添加 UPM 包。需要 confirm=true。可用 dry_run 预演。异步操作查询 package_status；涉及编译时继续查询 recompile_status。
- `package_list` — 列出已安装或注册表中的 UPM 包。
- `package_remove` — 移除 UPM 包。需要 confirm=true。可用 dry_run 预演。异步操作查询 package_status；涉及编译时继续查询 recompile_status。
- `package_resolve` — 解析工程包依赖。异步操作查询 package_status；涉及编译时继续查询 recompile_status。
- `package_search` — 搜索注册表包。
- `package_status` — 查询包操作状态。

#### 测试
- `cancel_tests` — 按 run_id 取消测试；不匹配时不产生副作用。
- `list_tests` — 列出 EditMode 或 PlayMode 测试。
- `run_tests` — 按过滤条件执行测试；全量使用 --async_tests。
- `test_status` — 按 run_id 查询测试；无法关联时返回 unknown_run。

#### 烘焙（光照 / NavMesh / 遮挡）
- `bake_lighting` — 异步烘焙光照。
- `bake_navmesh` — 异步烘焙导航网格。
- `bake_navmesh_surfaces` — 烘焙 NavMeshSurface；缺少 AI Navigation 包时返回 package_not_found。
- `bake_occlusion_culling` — 异步烘焙遮挡剔除。
- `cancel_lighting_bake` — 取消光照烘焙。
- `cancel_navmesh_bake` — 取消导航网格烘焙。
- `cancel_occlusion_bake` — 取消遮挡剔除烘焙。
- `clear_baked_lighting` — 清理烘焙光照数据。需要 confirm=true。
- `clear_navmesh` — 清理导航网格。需要 confirm=true。
- `clear_occlusion_culling` — 清理遮挡剔除数据。需要 confirm=true。
- `get_lighting_settings` — 读取光照烘焙设置。
- `get_navmesh_settings` — 读取导航网格设置。
- `lighting_bake_status` — 查询光照烘焙状态。
- `navmesh_bake_status` — 查询导航网格烘焙状态。
- `occlusion_bake_status` — 查询遮挡剔除烘焙状态。
- `set_lighting_settings` — 设置光照烘焙参数，返回 applied 和 unknown。
- `set_navmesh_settings` — 设置导航网格参数。

#### 截图 / 捕获
- `capture_editor_element` — 截取编辑器 UI Toolkit 元素。
- `capture_game_view` — 截取游戏视图；source=screen 需要运行模式并包含叠加画布，source=camera 按相机渲染。设置 save_path 时默认只返回路径，include_inline_image=true 可同时返回图片。
- `capture_runtime_element` — 截取运行时 UI Toolkit 元素。
- `capture_scene_view` — 截取当前场景视图。设置 save_path 时默认只返回路径，include_inline_image=true 可同时返回图片。
- `screenshot` — 截取场景或游戏视图并返回文件路径。

#### 编辑器控制
- `editor_focus` — 激活 Unity Editor 窗口。
- `editor_pause` — 切换运行模式的暂停状态。
- `editor_play` — 进入运行模式。
- `editor_status` — 读取编辑器状态。
- `editor_stop` — 退出运行模式。
- `menu` — 执行或列出菜单项。
- `set_autotick` — 在窗口失焦时保持编辑器周期更新。

#### 可观测性 / 审计
- `audit` — 记录或查询编辑器审计信息。
- `audit_status` — 查询审计状态。
- `clear_console` — 清空 Console。
- `console` — 读取回调捕获的日志流，支持游标跟随。
- `get_console_logs` — 读取原生 Console 日志。
- `read_console` — 读取原生 Console 日志，按类型和数量过滤。
- `get_performance_stats` — 读取性能统计。
- `log` — 写入 Console 日志。

#### 项目设置
- `get_audio_settings` — 读取音频设置。
- `get_graphics_settings` — 读取图形设置。
- `get_input_settings` — 读取输入设置。
- `get_physics_settings` — 读取物理设置。
- `get_player_settings` — 读取应用设置。
- `get_quality_settings` — 读取质量设置。
- `get_tags_layers` — 读取标签与层。
- `get_time_settings` — 读取时间设置。
- `set_audio_settings` — 修改音频设置。需要 confirm=true。可用 dry_run 预演。
- `set_graphics_settings` — 修改图形设置。需要 confirm=true。可用 dry_run 预演。
- `set_input_settings` — 修改输入设置。需要 confirm=true。可用 dry_run 预演。
- `set_physics_settings` — 修改物理设置。需要 confirm=true。可用 dry_run 预演。
- `set_player_settings` — 修改应用设置。需要 confirm=true。可用 dry_run 预演。
- `set_quality_settings` — 修改质量设置。需要 confirm=true。可用 dry_run 预演。
- `set_tags_layers` — 修改标签与层。需要 confirm=true。可用 dry_run 预演。
- `set_time_settings` — 修改时间设置。需要 confirm=true。可用 dry_run 预演。

#### 运行时 / 输入模拟
- `quit` — 正常退出 Unity 应用。
- `runtime_status` — 读取运行时状态。
- `set_target_framerate` — 设置目标帧率。
- `set_timescale` — 设置时间缩放。
- `simulate_key` — 模拟键盘事件。
- `simulate_pointer` — 模拟指针事件。

#### 选择 / 搜索
- `get_selection` — 读取当前选择的对象身份。
- `search` — 执行 Unity Search 查询。
- `set_selection` — 设置当前选择。

#### Authoring 根路径
- `get_authoring_root` — 读取资源编辑根目录。
- `set_authoring_root` — 设置并约束资源编辑根目录。

## 结果验证

核对原始错误、任务身份、停止状态及实际产物。只报告已经完成的验证，模拟测试与真实执行分别说明。

## 参考资料

[使用说明](README.md) · [文档规范](docs/documentation.md) · v-cli.plugin.json

## 许可与版权

MIT。Copyright © 2026 Vant。
