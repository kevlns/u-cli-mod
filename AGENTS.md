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
- Pipeline 命令全集见文末「Pipeline 工具清单」（适配版 `com.unity.pipeline` 共 153 个命令，按领域分组）
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

## Pipeline 工具清单

> 安装的 `com.unity.pipeline`（适配版 0.5.0-exp.1）共 **153** 个命令，经 `u-cli-mod exec <project> -- command <名> [参数]` 透传执行；参数全集以 `exec <project> -- command <名> --help` 为准。

### GameObject / 组件
- `add_component` — Add a component (by type name) to a GameObject.
- `create_gameobject` — Create an empty GameObject or a built-in primitive (cube/sphere/capsule/cylinder/plane/quad) in the active scene.
- `create_gameobjects` — Batch-create N empty GameObjects or primitives in one call. Optional positions/rotations/scales are arrays of [x,y,z] (length must equal count). Returns the created identities.
- `delete_gameobject` — Delete a GameObject from the scene (reversible via Undo).
- `find_gameobjects` — Find GameObjects in loaded scenes by name, tag, component type, and/or hierarchy path (filters are combined). Returns structured identities.
- `get_component_properties` — Get a component's serialized properties as a JSON map. Address the component by handle, or by GameObject handle + type.
- `remove_component` — Remove a component from a GameObject. Provide either a component handle (target) or a GameObject handle (target) plus a type name.
- `rename_gameobject` — Rename a GameObject.
- `set_active` — Set a GameObject's active self-state (activeSelf).
- `set_component_properties` — Set serialized properties on a component (one Undo step). 'properties' maps property name -> value; object references accept an ObjectRef handle.
- `set_layer` — Set a GameObject's layer by name or numeric index (0-31).
- `set_parent` — Reparent a GameObject under a new parent, or detach it to scene root when no parent is given.
- `set_tag` — Set a GameObject's tag (the tag must already exist in the project).
- `set_transform` — Set a GameObject's local position/rotation(euler)/scale. Omitted channels are left unchanged.

### 场景
- `add_scene_to_build` — Add a scene to the Build Settings scene list (idempotent). Optionally enable it.
- `create_scene` — Create a new scene and save it to the given path under the authoring root.
- `get_scene_hierarchy` — Return the GameObject tree of an open scene (or the active scene). Each node carries instanceId + hierarchyPath usable by GameObject commands.
- `list_open_scenes` — List all currently open scenes with their load/active/dirty state.
- `open_scene` — Open an existing scene from the given path.
- `remove_scene_from_build` — Remove a scene from the Build Settings scene list (idempotent).
- `save_all` — Save all open scenes that have unsaved changes.
- `save_scene` — Save an open scene. Saves the active scene when no path is given.
- `set_active_scene` — Set which open scene is the active scene (new objects are created in the active scene).

### 资源 / 文件
- `copy_asset` — Copy an asset to a new path under the authoring root. The copy gets a fresh GUID.
- `create_asset` — Create a new ScriptableObject (or other UnityEngine.Object) asset of the given type at a path under the authoring root.
- `create_folder` — Create a folder under the authoring root (creates intermediate folders).
- `delete_asset` — Delete an asset from the project. Destructive: requires confirm=true.
- `find_assets` — Find assets by type and/or name and/or label, returning their path, GUID and type. At least one filter is required.
- `get_import_settings` — Read an asset's import settings, structured by importer type (texture/model/audio), including the default-platform fields and (for textures/audio) one platform override block.
- `import_asset` — Import an external file (e.g. a texture, model, audio clip) into the project by copying it to a path under the authoring root, then importing it.
- `move_asset` — Move (or rename via a new path) an asset to a new location under the authoring root. Preserves the asset's GUID.
- `read_text_file` — Read a UTF-8 text file under the authoring root and return its contents.
- `rename_asset` — Rename an asset in place (keeps it in the same folder, keeps its GUID).
- `set_import_settings` — Set import settings on an asset's AssetImporter (default platform top-level properties, or a texture/audio per-platform override) and re-import it.
- `write_text_file` — Write UTF-8 text to a file under the authoring root, then import it. Overwriting an existing file requires confirm=true.

### 预制体
- `apply_prefab_overrides` — Apply a prefab instance's overrides back to its source prefab asset.
- `create_prefab` — Save a GameObject as a prefab asset at a project path; the source becomes a connected instance.
- `create_prefab_variant` — Create a prefab variant asset that inherits from a base prefab.
- `instantiate_prefab` — Instantiate a prefab asset into a loaded scene and return the created instance.
- `revert_prefab_overrides` — Revert a prefab instance's overrides so it matches its source prefab asset.
- `save_prefab_contents` — Open a prefab asset in an isolated prefab stage, apply a declarative edit, and save it back (nested-prefab safe).
- `unpack_prefab` — Unpack a prefab instance into plain GameObjects (outermost level or completely).

### 材质 / 着色器
- `get_material_properties` — Read a material's shader, render queue, enabled keywords, and all shader properties with their current values (Color as [r,g,b,a], Vector as [x,y,z,w], Texture as an object reference).
- `get_shader_properties` — Introspect a shader's declared property list (name, description, type Color|Vector|Float|Range|TexEnv|Int, range, textureDimension, flags). Provide 'shader' (by name) OR 'material' (read the shader off that material).
- `list_shaders` — Discover available shaders so an agent can pick a valid name for set_material_properties / create_asset. Returns [{ name, assetPath|null, isBuiltin, isSupported }].
- `set_material_properties` — Set shader properties on a material (Float/Range/Int=number; Color=[r,g,b,a] or "#RRGGBBAA" hex; Vector=[x,y,z,w]; Texture=an object reference or null to clear), optionally reassign the shader, set the render queue, and toggle keywords. Unknown names / type mismatches are reported in unknown[].

### 脚本 / 编译 / 求值
- `attach_script` — Add a MonoBehaviour to a GameObject by its (compiled) type name OR by its script asset path. Provide exactly one of 'type' or 'script'. If the type isn't compiled yet, returns a recoverable error: recompile, poll recompile_status, then retry.
- `cleanup_hotreload` — Remove old hot reload DLL versions and clear registry
- `create_script` — Create a new C# script (default base class MonoBehaviour) from a template under the authoring root. NOTE: the type does not exist until a recompile completes — to attach it, call recompile, poll recompile_status, then attach_script.
- `eval` — Evaluate C# code dynamically using Roslyn compiler
- `eval_file` — Evaluate C# code read from a .cs file on disk
- `get_serialized_fields` — Read serialized fields of a component/asset. Returns each top-level field's name, type and value (object references are returned as re-usable handles). Pass 'field' to read a single SerializedProperty path.
- `hotreload_status` — Show current hot reload registry status and statistics
- `recompile` — Force a script recompile (works while unfocused/minimized). Poll recompile_status for completion.
- `recompile_status` — Get the status of the last recompile: idle | triggered | compiling | completed | up_to_date.
- `reload_file` — Compile and apply in-place [HotReload] edits from a source file
- `reload_file_override` — Compile and apply hot reload file changes immediately
- `set_serialized_field` — Set a serialized field on a component/asset. Supports primitives, enums, Vector/Color/Rect/Bounds, object references (value = an ObjectRef: asset by guid/fileId/path or scene object by instanceId/hierarchyPath), and array elements via 'name.Array.data[i]' (or 'name.Array.size' to resize).

### 动画 / Timeline
- `add_animator_layer` — Add a layer to an AnimatorController.
- `add_animator_parameter` — Add a parameter (Float | Int | Bool | Trigger) to an AnimatorController. A duplicate name returns code 'duplicate_parameter'.
- `add_animator_state` — Add a state to a layer, optionally with a motion (AnimationClip or BlendTree) and as the layer default. A layer name with no match returns code 'layer_not_found'.
- `add_animator_transition` — Add a transition between two states (or from AnyState/Entry, to Exit) on a layer, with optional conditions. Validates that the states exist and each condition's parameter exists and its mode matches the parameter type.
- `add_timeline_clip` — Add a clip to a named track on a TimelineAsset. For Animation tracks pass an AnimationClip asset; for Audio tracks an AudioClip. Requires the com.unity.timeline package.
- `add_timeline_track` — Add a track (Animation | Audio | Activation | Control | Playable | Signal | Marker) to a TimelineAsset, optionally nested under a parent group/track. Requires the com.unity.timeline package.
- `create_animation_clip` — Create an empty .anim AnimationClip asset under the authoring root, with an optional frame rate and loop flag.
- `create_animator_controller` — Create an .controller AnimatorController asset (with a default Base Layer) under the authoring root.
- `create_timeline` — Create a .playable TimelineAsset under the authoring root (optional frame rate). Requires the com.unity.timeline package.
- `get_animation_clip` — Read an AnimationClip's metadata and all float curve bindings (optionally with keyframes).
- `get_animator_controller` — Read an AnimatorController's full structure: parameters, layers, states (with motion / default), and transitions (with conditions).
- `get_timeline` — Read a TimelineAsset's structure: frame rate, duration, and its tracks with their clips. Requires the com.unity.timeline package.
- `remove_animation_curve` — Remove a float curve binding from an AnimationClip (SetEditorCurve(clip, binding, null)). Destructive: requires confirm=true.
- `set_animation_curve` — Add or replace a single float curve binding on an AnimationClip (via AnimationUtility.SetEditorCurve). Replacing an existing binding overwrites it rather than duplicating.

### 构建
- `build` — Trigger an async Player build and report the full BuildReport. Returns immediately (queued); poll build_status until status is 'completed'. DetailedBuildReport is included by default unless 'options' is supplied. Use dry_run to validate without building.
- `build_status` — Status of the current/most recent build: idle | queued | building | completed, with the full BuildReport (files, packedAssets, buildSteps, errors, warnings) once completed. Retained until the next build.
- `get_build_settings` — Read the current build configuration from EditorUserBuildSettings / EditorBuildSettings.
- `list_build_profiles` — List Build Profile assets in the project (Unity 6 only). Returns feature_unavailable on earlier versions.
- `list_build_targets` — List the known BuildTarget values with their group and whether build support is installed.
- `set_build_settings` — Set mutable EditorUserBuildSettings fields. Does NOT manage scenes (use add_scene_to_build / remove_scene_from_build) or switch target (use switch_build_target). Use dry_run to preview.
- `switch_build_target` — Switch the active build target (destructive, long-running: triggers a full reimport + domain reload). Requires confirm=true. Returns immediately; poll switch_build_target_status.
- `switch_build_target_status` — Status of the last target switch: idle | switching | completed (with success + activeBuildTarget).

### 包管理
- `package_add` — Add a UPM package by name@version, git URL, or 'file:' local path. Async by default (returns in_progress; poll package_status); pass wait=true to block until added. A recompile/domain reload follows — poll recompile_status. Requires confirm=true; use dry_run to preview.
- `package_list` — List packages by scope: installed (default) | available (registry) | all (both). Returns the full result synchronously — available/all block until the registry query completes.
- `package_remove` — Remove a UPM package by name. Async by default (returns in_progress; poll package_status); pass wait=true to block until removed. A recompile/domain reload follows — poll recompile_status. Requires confirm=true; use dry_run to preview.
- `package_resolve` — Resolve/refresh packages from the manifest (re-fetch and re-link). May trigger a recompile/domain reload — poll recompile_status. Its outcome is recorded for package_status.
- `package_search` — Search packages available in the registry. Provide a name (e.g. com.unity.foo) or omit to list all. Returns the full result synchronously (blocks until the registry query completes).
- `package_status` — Status of the last async package operation (add/remove/resolve): idle | in_progress | completed | failed, with the added package, manifest, and any error.

### 测试
- `cancel_tests` — Cancel running test execution
- `list_tests` — List all available tests (EditMode and/or PlayMode) without running them
- `run_tests` — Execute Unity tests with filtering options
- `test_status` — Get status of running async test execution

### 烘焙（光照 / NavMesh / 遮挡）
- `bake_lighting` — Trigger an async lightmap bake of the open scene(s) via Lightmapping.BakeAsync(). Returns immediately; poll lighting_bake_status until completed.
- `bake_navmesh` — Trigger an async legacy NavMesh bake of the open scene(s) via UnityEditor.AI.NavMeshBuilder. Returns immediately; poll navmesh_bake_status until completed.
- `bake_navmesh_surfaces` — Bake NavMeshSurface components (AI Navigation package). v1 stub: returns package_not_found when the package is absent.
- `bake_occlusion_culling` — Trigger an async occlusion-culling bake of the open scene(s) via StaticOcclusionCulling.GenerateInBackground(). Returns immediately; poll occlusion_bake_status until completed.
- `cancel_lighting_bake` — Cancel an in-progress lighting bake (Lightmapping.Cancel()).
- `cancel_navmesh_bake` — Cancel an in-progress NavMesh bake (NavMeshBuilder.Cancel()).
- `cancel_occlusion_bake` — Cancel an in-progress occlusion bake (StaticOcclusionCulling.Cancel()).
- `clear_baked_lighting` — Clear baked lightmap data for the open scene(s). Destructive: requires confirm=true.
- `clear_navmesh` — Clear the baked NavMesh for the open scene(s). Destructive: requires confirm=true.
- `clear_occlusion_culling` — Clear baked occlusion-culling data for the open scene(s). Destructive: requires confirm=true.
- `get_lighting_settings` — Read the active LightingSettings (lightmapper, bounces, resolution, directional mode, AO, etc.).
- `get_navmesh_settings` — Read the default agent's legacy NavMesh bake settings (agentRadius/Height/Slope/Climb, minRegionArea, voxelSize).
- `lighting_bake_status` — Get the status of the last lighting bake: idle | baking | completed.
- `navmesh_bake_status` — Get the status of the last NavMesh bake: idle | baking | completed.
- `occlusion_bake_status` — Get the status of the last occlusion bake: idle | baking | completed.
- `set_lighting_settings` — Apply a subset of lighting settings to the active LightingSettings. Returns { applied[], unknown[] }.
- `set_navmesh_settings` — Apply a subset of legacy NavMesh bake settings to the default agent. Returns { applied[], unknown[] }.

### 截图 / 捕获
- `capture_editor_element` — Capture a UI Toolkit VisualElement (by selector) from an EditorWindow to a PNG; returns path + base64.
- `capture_game_view` — Render the game view to a PNG. source=camera (default) renders a camera and misses Screen Space - Overlay UI; source=screen captures the composited backbuffer incl. overlay canvases (Play Mode only). Returns it inline as base64, unless save_path is set (path-only result; pass include_inline_image=true to get both).
- `capture_runtime_element` — Capture a UI Toolkit VisualElement (by selector) from a live runtime panel (UIDocument or PanelRenderer) to a PNG; returns path + base64.
- `capture_scene_view` — Render the active Scene View to a PNG. Returns it inline as base64, unless save_path is set (path-only result; pass include_inline_image=true to get both).
- `screenshot` — Capture the Scene or Game view as a PNG and return its file path

### 编辑器控制
- `editor_focus` — Bring the Unity Editor window to the foreground
- `editor_pause` — Toggle pause state of Unity Editor play mode
- `editor_play` — Enter Unity Editor play mode
- `editor_status` — Get detailed Unity Editor status and state information
- `editor_stop` — Exit Unity Editor play mode
- `menu` — Execute an Editor menu item by path, or list available items when no path is given
- `set_autotick` — Keep the editor ticking while unfocused by forcing EditorApplication.SignalTick at a throttled rate

### 可观测性 / 审计
- `audit` — Run a Project Auditor static-analysis scan. Returns immediately; poll audit_status until status is 'completed', then read the CSV.
- `audit_status` — Get the status of the last audit: idle | scanning | completed | failed | interrupted | unavailable.
- `clear_console` — Clear the captured log buffer and the Unity Editor console.
- `console` — Get captured Unity console output (Editor or Player; supports tail, level filtering, and follow via a cursor)
- `get_console_logs` — Read recently captured Editor console logs (structured).
- `get_performance_stats` — Read render, memory, and frame-timing stats (structured, read-only).
- `log` — Write a message to Unity console

### 项目设置
- `get_audio_settings` — Read project Audio settings (volume, rolloff scale, doppler factor).
- `get_graphics_settings` — Read GraphicsSettings (default render pipeline).
- `get_input_settings` — Read the legacy Input Manager axes (names and count).
- `get_physics_settings` — Read Physics settings (gravity, solver iterations, bounce threshold).
- `get_player_settings` — Read PlayerSettings (company/product/version, scripting backend, API level).
- `get_quality_settings` — Read QualitySettings (current level, level names, vSync, anti-aliasing).
- `get_tags_layers` — Read the project's tags and (named) layers.
- `get_time_settings` — Read Time settings (fixedDeltaTime, maximumDeltaTime, timeScale).
- `set_audio_settings` — Change project Audio settings. Requires confirm=true; use dry_run to preview. Not undoable via Ctrl+Z.
- `set_graphics_settings` — Set the default render pipeline asset. Requires confirm=true; use dry_run to preview. Not undoable via Ctrl+Z.
- `set_input_settings` — Tune a legacy Input Manager axis (sensitivity/gravity/dead) by name. Requires confirm=true; use dry_run to preview. Not undoable via Ctrl+Z.
- `set_physics_settings` — Change Physics settings. Requires confirm=true; use dry_run to preview. Not undoable via Ctrl+Z.
- `set_player_settings` — Change PlayerSettings. Requires confirm=true; use dry_run to preview. Not undoable via Ctrl+Z. Scripting backend / API level changes trigger a domain reload.
- `set_quality_settings` — Change QualitySettings. Requires confirm=true; use dry_run to preview. Not undoable via Ctrl+Z.
- `set_tags_layers` — Add/remove tags and assign user layer names (index 8-31). Requires confirm=true; use dry_run to preview. Not undoable via Ctrl+Z.
- `set_time_settings` — Change Time settings. Requires confirm=true; use dry_run to preview. Not undoable via Ctrl+Z.

### 运行时 / 输入模拟
- `quit` — Gracefully quit the Unity application
- `runtime_status` — Get comprehensive runtime application status
- `set_target_framerate` — Set the target frame rate for the application
- `set_timescale` — Set the time scale for the application
- `simulate_key` — Simulate a keyboard key event (Input System). Drives the running app.
- `simulate_pointer` — Simulate a mouse/pointer event at screen coordinates (Input System).

### 选择 / 搜索
- `get_selection` — Read the current Editor selection as structured object identities.
- `search` — Run a Unity Search query and return structured results.
- `set_selection` — Set the Editor selection to the given assets/scene objects.

### Authoring 根路径
- `get_authoring_root` — Get the base folder (under Assets/) that bare authoring paths resolve against.
- `set_authoring_root` — Set the base folder (under Assets/) that bare authoring paths resolve against and are confined to. Use 'Assets' for full project access.