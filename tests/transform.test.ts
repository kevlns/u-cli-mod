import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transformPackage, rewritePackageJson } from '../src/transform.js';
import { sha256Buffer } from '../src/integrity.js';
import type { PipelineRoute } from '../src/routes.js';

const MONO_BODY = `MonoImporter:\n  externalObjects: {}\n  serializedVersion: 2\n  defaultReferences: []\n  executionOrder: 0\n  icon: {instanceID: 0}\n  userData: \n  assetBundleName: \n  assetBundleVariant: \n\n`;
const DLL_BODY = `PluginImporter:\n  externalObjects: {}\n  serializedVersion: 2\n  iconMap: {}\n  executionOrder: {}\n  defineConstraints: []\n  isPreloaded: 0\n  isOverridable: 0\n  isExplicitlyReferenced: 0\n  validateReferences: 1\n  platformData:\n  - first:\n      Any: \n    second:\n      enabled: 1\n      settings: {}\n  userData: \n  assetBundleName: \n  assetBundleVariant: \n\n`;

const GUID_A = '11111111111111111111111111111111';
const GUID_B = '22222222222222222222222222222222';
const GUID_DLL = '33333333333333333333333333333333';

const STUB_A = Buffer.from(`fileFormatVersion: 2\nguid: ${GUID_A}`);
const STUB_B = Buffer.from(`fileFormatVersion: 2\nguid: ${GUID_B}\n`);
const STUB_SAMPLE = Buffer.from(`fileFormatVersion: 2\nguid: ${GUID_DLL}`);

const ASSET_ORIG = Buffer.from(
  'using System;\nusing UnityEditor;\nusing UnityEngine;\nusing Object = UnityEngine.Object;\n\nnamespace X {\n public static class AssetCommands { }\n}\n',
);
const MATERIAL_ORIG = Buffer.from(
  'using System;\nusing UnityEditor;\nusing UnityEngine;\n\nnamespace Y {\n    public static class MaterialCommands\n    {\n        public static void Run() { var x = RenderQueue = mat.rawRenderQueue, y = 1; }\n    }\n}\n',
);
const ASSET_EXPECTED = Buffer.from(
  'using System;\nusing UnityEditor;\nusing UnityEngine;\nusing Object = UnityEngine.Object;\n#if !UNITY_6000_0_OR_NEWER\nusing PhysicsMaterial = UnityEngine.PhysicMaterial;\n#endif\n\nnamespace X {\n public static class AssetCommands { }\n}\n',
).toString('utf8').replace(/\n/g, '\r\n');

const MATERIAL_EXPECTED =
  'using System;\nusing UnityEditor;\nusing UnityEngine;\n\nnamespace Y {\n    public static class MaterialCommands\n    {\n        private static int GetRawRenderQueue(Material material)\n        {\n            var serialized = new SerializedObject(material);\n            var property = serialized.FindProperty("m_CustomRenderQueue");\n            return property != null ? property.intValue : material.renderQueue;\n        }\n\n        public static void Run() { var x = RenderQueue = GetRawRenderQueue(mat), y = 1; }\n    }\n}\n'.replace(
      /\n/g,
      '\r\n',
    );

const PKG_ORIG = Buffer.from(
  '{"name":"com.unity.pipeline","version":"0.5.0-exp.1","unity":"6000.0","desc":"caf\u00e9 \u2014 ok"}',
);

const route: PipelineRoute = {
  packageName: 'com.unity.pipeline',
  version: '0.5.0-exp.1',
  upstreamRevision: 'rev',
  url: 'https://x.test/t.tgz',
  sha1: 'c'.repeat(40),
  sha256: 'd'.repeat(64),
  expectedTree: 'x.json',
  templates: 't',
  targetUnityVersion: '2022.3',
  patchVersion: 1,
};

interface Ctx {
  dir: string;
  src: string;
  out: string;
}
let ctx: Ctx;

function buildSource(root: string): void {
  mkdirSync(join(root, 'Runtime', 'Plugins', 'CodeAnalysis'), { recursive: true });
  mkdirSync(join(root, 'Editor', 'Commands', 'Assets'), { recursive: true });
  mkdirSync(join(root, 'Editor', 'Commands', 'Materials'), { recursive: true });
  mkdirSync(join(root, 'Samples~', 'Demo'), { recursive: true });
  mkdirSync(join(root, 'Tests', 'Editor'), { recursive: true });
  mkdirSync(join(root, '.claude', 'skills', 'x'), { recursive: true });
  writeFileSync(join(root, 'package.json'), PKG_ORIG);
  writeFileSync(join(root, 'Editor', 'A.cs'), 'public class A {}\n');
  writeFileSync(join(root, 'Editor', 'A.cs.meta'), STUB_A);
  writeFileSync(join(root, 'Editor', 'B.cs'), 'public class B {}\n');
  writeFileSync(join(root, 'Editor', 'B.cs.meta'), STUB_B);
  writeFileSync(join(root, 'Samples~', 'Demo', 'X.cs'), 'public class X {}\n');
  writeFileSync(join(root, 'Samples~', 'Demo', 'X.cs.meta'), STUB_SAMPLE);
  writeFileSync(join(root, 'README.md'), 'readme\n');
  writeFileSync(join(root, 'Editor', 'Commands', 'Assets', 'AssetCommands.cs'), ASSET_ORIG);
  writeFileSync(join(root, 'Editor', 'Commands', 'Materials', 'MaterialCommands.cs'), MATERIAL_ORIG);
  for (const name of [
    'Microsoft.CodeAnalysis.CSharp.dll.meta',
    'Microsoft.CodeAnalysis.dll.meta',
    'System.Collections.Immutable.dll.meta',
    'System.Reflection.Metadata.dll.meta',
    'System.Runtime.CompilerServices.Unsafe.dll.meta',
  ]) {
    writeFileSync(
      join(root, 'Runtime', 'Plugins', 'CodeAnalysis', name),
      `fileFormatVersion: 2\nguid: ${GUID_DLL}\nPluginImporter:\n  serializedVersion: 3\n` + ' '.repeat(100),
    );
  }
  // to be removed (content); Tests.meta is kept (folder meta, see transform.ts)
  writeFileSync(join(root, 'Tests', 'Editor', 'T.cs'), 'public class T {}\n');
  writeFileSync(join(root, 'Tests', 'Editor', 'T.cs.meta'), 'stub-meta');
  writeFileSync(join(root, 'Tests.meta'), 'stub');
  writeFileSync(join(root, '.attestation.p7m'), 'attest');
  writeFileSync(join(root, '.signature'), 'sig');
  writeFileSync(join(root, 'CLAUDE.md'), 'claude');
  writeFileSync(join(root, 'CLAUDE.md.meta'), 'claude-meta');
  writeFileSync(join(root, 'CODEOWNERS'), 'owners');
  writeFileSync(join(root, 'CODEOWNERS.meta'), 'owners-meta');
  writeFileSync(join(root, '.claude', 'skills', 'x', 'SKILL.md'), 'skill');
}

function expectedTree(): Record<string, string> {
  const files: Record<string, string> = {};
  const add = (rel: string, bytes: Buffer) => {
    files[rel] = sha256Buffer(bytes);
  };
  add('package.json', rewritePackageJson(PKG_ORIG, '2022.3'));
  add('Editor/A.cs', Buffer.from('public class A {}\n'));
  add('Editor/A.cs.meta', Buffer.from(`fileFormatVersion: 2\nguid: ${GUID_A}\n${MONO_BODY}`));
  add('Editor/B.cs', Buffer.from('public class B {}\n'));
  add('Editor/B.cs.meta', STUB_B);
  add('Samples~/Demo/X.cs', Buffer.from('public class X {}\n'));
  add('Samples~/Demo/X.cs.meta', STUB_SAMPLE);
  add('README.md', Buffer.from('readme\n'));
  add('Tests.meta', Buffer.from('stub'));
  add('Editor/Commands/Assets/AssetCommands.cs', Buffer.from(ASSET_EXPECTED, 'utf8'));
  add('Editor/Commands/Materials/MaterialCommands.cs', Buffer.from(MATERIAL_EXPECTED, 'utf8'));
  for (const name of [
    'Microsoft.CodeAnalysis.CSharp.dll.meta',
    'Microsoft.CodeAnalysis.dll.meta',
    'System.Collections.Immutable.dll.meta',
    'System.Reflection.Metadata.dll.meta',
    'System.Runtime.CompilerServices.Unsafe.dll.meta',
  ]) {
    add(
      `Runtime/Plugins/CodeAnalysis/${name}`,
      Buffer.from(`fileFormatVersion: 2\nguid: ${GUID_DLL}\n${DLL_BODY}`),
    );
  }
  return files;
}

async function runTransform(): Promise<void> {
  await transformPackage({
    sourceRoot: ctx.src,
    targetRoot: ctx.out,
    route,
    expectedTree: expectedTree(),
    monoImporterBody: MONO_BODY,
    dllImporterBody: DLL_BODY,
  });
}

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'epc-tf-'));
  const src = join(dir, 'src');
  const out = join(dir, 'out');
  buildSource(src);
  ctx = { dir, src, out };
});

afterEach(() => {
  rmSync(ctx.dir, { recursive: true, force: true });
});

function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string, prefix: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      const abs = join(d, e.name);
      if (e.isDirectory()) walk(abs, rel);
      else out.push(rel);
    }
  };
  walk(root, '');
  return out.sort();
}

describe('transformPackage (synthetic fixture)', () => {
  it('produces exactly the expected tree, byte for byte', async () => {
    await runTransform();
    expect(listFiles(ctx.out)).toEqual(Object.keys(expectedTree()).sort());
    expect(readFileSync(join(ctx.out, 'package.json'))).toEqual(rewritePackageJson(PKG_ORIG, '2022.3'));
    const asset = readFileSync(join(ctx.out, 'Editor', 'Commands', 'Assets', 'AssetCommands.cs'), 'utf8');
    expect(asset.includes('#if !UNITY_6000_0_OR_NEWER\r\nusing PhysicsMaterial = UnityEngine.PhysicMaterial;\r\n#endif'));
    expect(asset).toBe(ASSET_EXPECTED);
    const mat = readFileSync(join(ctx.out, 'Editor', 'Commands', 'Materials', 'MaterialCommands.cs'), 'utf8');
    expect(mat).toBe(MATERIAL_EXPECTED);
    expect(mat.includes('RenderQueue = GetRawRenderQueue(mat),')).toBe(true);
    expect(mat.includes('RenderQueue = mat.rawRenderQueue,')).toBe(false);
    const csMeta = readFileSync(join(ctx.out, 'Editor', 'A.cs.meta'), 'utf8');
    expect(csMeta).toBe(`fileFormatVersion: 2\nguid: ${GUID_A}\n${MONO_BODY}`);
  });

  it('removes Tests sources, signatures and internal docs (keeps Tests.meta)', async () => {
    await runTransform();
    const files = listFiles(ctx.out);
    for (const banned of [
      'Tests/Editor/T.cs',
      'Tests/Editor/T.cs.meta',
      '.attestation.p7m',
      '.signature',
      'CLAUDE.md',
      'CLAUDE.md.meta',
      'CODEOWNERS',
      'CODEOWNERS.meta',
      '.claude/skills/x/SKILL.md',
    ]) {
      expect(files).not.toContain(banned);
    }
    // Unity 2022 regenerates a fresh Tests/ folder meta when this file is
    // missing, breaking exact-tree checks after the first Editor run.
    expect(files).toContain('Tests.meta');
  });

  it('rejects tampered package.json', async () => {
    writeFileSync(join(ctx.src, 'package.json'), 'not-json{');
    await expect(runTransform()).rejects.toThrow();
  });

  it('rejects a missing anchor in AssetCommands.cs', async () => {
    writeFileSync(
      join(ctx.src, 'Editor', 'Commands', 'Assets', 'AssetCommands.cs'),
      'public class Z {}\n',
    );
    await expect(runTransform()).rejects.toThrow(/锚点/);
  });

  it('is deterministic (same input -> identical output)', async () => {
    await runTransform();
    const first = new Map<string, string>();
    for (const rel of listFiles(ctx.out)) {
      first.set(rel, sha256Buffer(readFileSync(join(ctx.out, rel))));
    }
    rmSync(ctx.out, { recursive: true, force: true });
    await runTransform();
    const second = new Map<string, string>();
    for (const rel of listFiles(ctx.out)) {
      second.set(rel, sha256Buffer(readFileSync(join(ctx.out, rel))));
    }
    expect(second).toEqual(first);
  });

  it('is idempotent when run again over its own output', async () => {
    await runTransform();
    const first = new Map<string, string>();
    for (const rel of listFiles(ctx.out)) {
      first.set(rel, sha256Buffer(readFileSync(join(ctx.out, rel))));
    }
    const out2 = join(ctx.dir, 'out2');
    await transformPackage({
      sourceRoot: ctx.out,
      targetRoot: out2,
      route,
      expectedTree: expectedTree(),
      monoImporterBody: MONO_BODY,
      dllImporterBody: DLL_BODY,
    });
    const second = new Map<string, string>();
    for (const rel of listFiles(out2)) {
      second.set(rel, sha256Buffer(readFileSync(join(out2, rel))));
    }
    expect(second).toEqual(first);
  });
});

describe('rewritePackageJson', () => {
  it('escapes non-ASCII like Python ensure_ascii and keeps compact formatting', () => {
    const out = rewritePackageJson(PKG_ORIG, '2022.3').toString('utf8');
    expect(out).toBe('{"name":"com.unity.pipeline","version":"0.5.0-exp.1","unity":"2022.3","desc":"caf\\u00e9 \\u2014 ok"}');
  });

  it('preserves already-escaped sequences (no double escaping)', () => {
    const input = Buffer.from('{"a":"x \\u2014 y","unity":"6000.0"}');
    const out = rewritePackageJson(input, '2022.3').toString('utf8');
    expect(out).toBe('{"a":"x \\u2014 y","unity":"2022.3"}');
  });

  it('escapes astral (non-BMP) characters as real surrogate pairs', () => {
    const input = Buffer.from('{"desc":"emoji \\uD83D\\uDE00 ok","unity":"6000.0"}');
    const out = rewritePackageJson(input, '2022.3').toString('utf8');
    // Valid JSON escapes, round-trippable, and no orphaned surrogate.
    expect(out).toBe('{"desc":"emoji \\ud83d\\ude00 ok","unity":"2022.3"}');
    const parsed = JSON.parse(out) as { desc: string };
    expect(parsed.desc).toBe('emoji 😀 ok');
    // No U+FFFD replacement character may appear.
    expect(out).not.toContain('\\ufffd');
  });

  it('is idempotent on an already-patched file', () => {
    const once = rewritePackageJson(PKG_ORIG, '2022.3');
    const twice = rewritePackageJson(once, '2022.3');
    expect(twice).toEqual(once);
  });
});