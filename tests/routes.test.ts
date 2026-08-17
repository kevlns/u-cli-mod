import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRoute, resolveRouteForProject, listEditorVersions, loadExpectedTree } from '../src/routes.js';
import { readProjectInfo } from '../src/projectVersion.js';

const ROUTE_JSON = {
  schemaVersion: 1,
  editorVersion: '2022.3.62f3c1',
  editorRevision: '1623fc0bbb97',
  cli: {
    version: '1.0.0-beta.2',
    url: 'https://public-cdn.cloud.unity3d.com/hub/prod/cli/x.exe',
    sha256: 'a'.repeat(64),
    signerSubjectContains: 'CN=Unity Technologies SF',
    signerThumbprint: 'B'.repeat(40),
  },
  pipeline: {
    packageName: 'com.unity.pipeline',
    version: '0.5.0-exp.1',
    upstreamRevision: 'rev',
    url: 'https://download.packages.unity.com/com.unity.pipeline/x.tgz',
    sha1: 'c'.repeat(40),
    sha256: 'd'.repeat(64),
    expectedTree: 'expected-tree/2022.3.62f3c1.json',
    templates: '2022.3.62f3c1',
    targetUnityVersion: '2022.3',
    patchVersion: 1,
  },
};

interface Ctx {
  dir: string;
  routesDir: string;
  projects: string;
}

let ctx: Ctx;

function makeProject(versionLine: string, withRevision: boolean): string {
  const dir = join(ctx.projects, `p${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(dir, 'ProjectSettings'), { recursive: true });
  const lines = [`m_EditorVersion: ${versionLine}`];
  if (withRevision) {
    lines.push(`m_EditorVersionWithRevision: ${versionLine} (1623fc0bbb97)`);
  }
  writeFileSync(join(dir, 'ProjectSettings', 'ProjectVersion.txt'), lines.join('\n') + '\n');
  return dir;
}

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'epc-routes-'));
  const routesDir = join(base, 'routes');
  const projects = join(base, 'projects');
  mkdirSync(routesDir, { recursive: true });
  mkdirSync(projects, { recursive: true });
  writeFileSync(join(routesDir, '2022.3.62f3c1.json'), JSON.stringify(ROUTE_JSON));
  ctx = { dir: base, routesDir, projects };
});

afterEach(() => {
  rmSync(ctx.dir, { recursive: true, force: true });
});

describe('routes', () => {
  it('loads the exact version route', () => {
    const route = loadRoute('2022.3.62f3c1', ctx.routesDir);
    expect(route.editorRevision).toBe('1623fc0bbb97');
    expect(route.cli.version).toBe('1.0.0-beta.2');
  });

  it('rejects unsupported versions without fallback', () => {
    expect(() => loadRoute('2022.3.61f1', ctx.routesDir)).toThrow(/不支持 Unity Editor/);
  });

  it('rejects mismatched file/version content', () => {
    const route = { ...ROUTE_JSON, editorVersion: '2022.3.99f9' };
    writeFileSync(join(ctx.routesDir, '2022.3.62f3c1.json'), JSON.stringify(route));
    expect(() => loadRoute('2022.3.62f3c1', ctx.routesDir)).toThrow(/不一致/);
  });

  it('rejects missing required fields', () => {
    const route = { ...ROUTE_JSON, cli: { version: 'x' } };
    writeFileSync(join(ctx.routesDir, '2022.3.62f3c1.json'), JSON.stringify(route));
    expect(() => loadRoute('2022.3.62f3c1', ctx.routesDir)).toThrow(/缺少字段 cli.url/);
  });

  it('rejects missing newly-required fields (thumbprint, sha1, targetUnityVersion, ...)', () => {
    const cases: Array<{ patch: Record<string, unknown>; field: string }> = [
      { patch: { cli: { ...ROUTE_JSON.cli, signerThumbprint: '' } }, field: 'cli.signerThumbprint' },
      { patch: { cli: { ...ROUTE_JSON.cli, signerThumbprint: undefined } }, field: 'cli.signerThumbprint' },
      { patch: { pipeline: { ...ROUTE_JSON.pipeline, sha1: '' } }, field: 'pipeline.sha1' },
      { patch: { pipeline: { ...ROUTE_JSON.pipeline, version: undefined } }, field: 'pipeline.version' },
      { patch: { pipeline: { ...ROUTE_JSON.pipeline, targetUnityVersion: '' } }, field: 'pipeline.targetUnityVersion' },
      { patch: { pipeline: { ...ROUTE_JSON.pipeline, packageName: undefined } }, field: 'pipeline.packageName' },
    ];
    for (const { patch, field } of cases) {
      const route = { ...ROUTE_JSON, ...patch };
      writeFileSync(join(ctx.routesDir, '2022.3.62f3c1.json'), JSON.stringify(route));
      expect(() => loadRoute('2022.3.62f3c1', ctx.routesDir)).toThrow(`缺少字段 ${field}`);
    }
  });

  it('rejects path-traversal editorVersion inputs (fail-closed)', () => {
    for (const bad of ['../../package', '..\\.\\secret', '/etc/passwd', 'C:\\windows\\x']) {
      expect(() => loadRoute(bad, ctx.routesDir)).toThrow(/格式非法/);
    }
  });

  it('listEditorVersions ignores route files with invalid version names', () => {
    writeFileSync(join(ctx.routesDir, 'not-a-version.json'), JSON.stringify(ROUTE_JSON));
    writeFileSync(join(ctx.routesDir, 'evil.json'), '{}');
    expect(listEditorVersions(ctx.routesDir)).toEqual(['2022.3.62f3c1']);
  });

  it('loadExpectedTree rejects entries/files count mismatch', () => {
    const treeFile = join(ctx.dir, 'expected-tree.json');
    writeFileSync(
      treeFile,
      JSON.stringify({ algorithm: 'SHA256', entries: 2, files: { 'a': '1'.repeat(64) } }),
    );
    expect(() => loadExpectedTree('2022.3.62f3c1', treeFile)).toThrow(/entries 与 files 数量不一致/);
  });

  it('loadExpectedTree accepts the shipped 385-file tree', () => {
    const tree = loadExpectedTree('2022.3.62f3c1');
    expect(tree.entries).toBe(385);
    expect(Object.keys(tree.files).length).toBe(385);
  });

  it('resolves a project with exact version and revision', () => {
    const project = readProjectInfo(makeProject('2022.3.62f3c1', true));
    const route = resolveRouteForProject(project, ctx.routesDir);
    expect(route.editorVersion).toBe('2022.3.62f3c1');
  });

  it('fails closed when revision is missing in the project', () => {
    const project = readProjectInfo(makeProject('2022.3.62f3c1', false));
    expect(() => resolveRouteForProject(project, ctx.routesDir)).toThrow(
      /缺少 m_EditorVersionWithRevision/,
    );
  });

  it('fails closed on revision mismatch', () => {
    const route = { ...ROUTE_JSON, editorRevision: 'deadbeefdeadbeefdeadbeefdeadbeef' };
    writeFileSync(join(ctx.routesDir, '2022.3.62f3c1.json'), JSON.stringify(route));
    const project = readProjectInfo(makeProject('2022.3.62f3c1', true));
    expect(() => resolveRouteForProject(project, ctx.routesDir)).toThrow(/revision 不匹配/);
  });

  it('lists versions sorted', () => {
    expect(listEditorVersions(ctx.routesDir)).toEqual(['2022.3.62f3c1']);
  });
});