import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CliError } from './errors.js';
import { routesDir, expectedTreePath } from './config.js';
import { UNITY_EDITOR_VERSION_RE } from './projectVersion.js';
import type { ProjectInfo } from './projectVersion.js';

export interface CliRoute {
  version: string;
  url: string;
  sha256: string;
  expectedSize?: number;
  signerSubjectContains: string;
  signerThumbprint: string;
}

export interface PipelineRoute {
  packageName: string;
  version: string;
  upstreamRevision: string;
  url: string;
  sha1: string;
  sha256: string;
  expectedSize?: number;
  expectedTree: string;
  templates: string;
  targetUnityVersion: string;
  patchVersion: number;
}

export interface VersionRoute {
  schemaVersion: number;
  editorVersion: string;
  editorRevision: string;
  cli: CliRoute;
  pipeline: PipelineRoute;
  status?: string;
}

export interface ExpectedTree {
  algorithm: string;
  entries: number;
  files: Record<string, string>;
}

export function loadRoute(editorVersion: string, dir = routesDir()): VersionRoute {
  if (!UNITY_EDITOR_VERSION_RE.test(editorVersion)) {
    throw new CliError(`Unity Editor 版本格式非法，拒绝路由查询：${editorVersion}`);
  }
  const file = join(dir, `${editorVersion}.json`);
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    const supported = listEditorVersions(dir);
    throw new CliError(
      `不支持 Unity Editor ${editorVersion}。当前精确路由：${supported.join(', ') || '(无)'}`,
    );
  }
  const route = JSON.parse(raw) as VersionRoute;
  if (route.schemaVersion !== 1) {
    throw new CliError(`路由 ${editorVersion} 的 schemaVersion 不支持：${route.schemaVersion}`);
  }
  if (route.editorVersion !== editorVersion) {
    throw new CliError(`路由文件名与内容不一致：${editorVersion} != ${route.editorVersion}`);
  }
  for (const [field, value] of [
    ['cli.version', route.cli?.version],
    ['cli.url', route.cli?.url],
    ['cli.sha256', route.cli?.sha256],
    ['cli.signerSubjectContains', route.cli?.signerSubjectContains],
    ['cli.signerThumbprint', route.cli?.signerThumbprint],
    ['pipeline.packageName', route.pipeline?.packageName],
    ['pipeline.version', route.pipeline?.version],
    ['pipeline.url', route.pipeline?.url],
    ['pipeline.sha1', route.pipeline?.sha1],
    ['pipeline.sha256', route.pipeline?.sha256],
    ['pipeline.expectedTree', route.pipeline?.expectedTree],
    ['pipeline.templates', route.pipeline?.templates],
    ['pipeline.targetUnityVersion', route.pipeline?.targetUnityVersion],
  ] as const) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new CliError(`路由 ${editorVersion} 缺少字段 ${field}`);
    }
  }
  return route;
}

export function listEditorVersions(dir = routesDir()): string[] {
  const files = readdirSync(dir);
  return files
    .filter((f) => f.endsWith('.json') && UNITY_EDITOR_VERSION_RE.test(f.slice(0, -'.json'.length)))
    .map((f) => f.slice(0, -'.json'.length))
    .sort();
}

/** Exact version + revision gate. Fail-closed: no fallback, no wildcard, no nearest-version. */
export function resolveRouteForProject(project: ProjectInfo, dir = routesDir()): VersionRoute {
  const route = loadRoute(project.editorVersion, dir);
  if (!route.editorRevision) {
    throw new CliError(`路由缺少 editorRevision 配置，拒绝使用：${route.editorVersion}`);
  }
  if (project.revision === null) {
    throw new CliError('工程缺少 m_EditorVersionWithRevision，无法验证精确 Editor revision。');
  }
  if (route.editorRevision !== project.revision) {
    throw new CliError(
      `Unity 版本号相同但 revision 不匹配。工程：${project.revision}，路由：${route.editorRevision}`,
    );
  }
  return route;
}

export function loadExpectedTree(editorVersion: string, treeFile = expectedTreePath(editorVersion)): ExpectedTree {
  if (!UNITY_EDITOR_VERSION_RE.test(editorVersion)) {
    throw new CliError(`Unity Editor 版本格式非法，拒绝 expected-tree 查询：${editorVersion}`);
  }
  const tree = JSON.parse(readFileSync(treeFile, 'utf8')) as ExpectedTree;
  if (tree.algorithm !== 'SHA256') {
    throw new CliError(`expected-tree 算法不支持：${tree.algorithm}`);
  }
  const fileCount = Object.keys(tree.files ?? {}).length;
  if (typeof tree.entries !== 'number' || tree.entries !== fileCount) {
    throw new CliError(
      `expected-tree entries 与 files 数量不一致：entries=${tree.entries}，files=${fileCount}`,
    );
  }
  return tree;
}