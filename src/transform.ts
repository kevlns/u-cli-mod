import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { CliError } from './errors.js';
import { sha256Buffer, compareTree } from './integrity.js';
import type { PipelineRoute } from './routes.js';

/** Files/dirs present upstream that must NOT ship in the adapted package. */
const REMOVE_EXACT = new Set([
  '.attestation.p7m',
  '.signature',
  'CLAUDE.md',
  'CLAUDE.md.meta',
  'CODEOWNERS',
  'CODEOWNERS.meta',
  '.claude',
]);
const REMOVE_PREFIX = ['.claude/', 'Tests/'];

// NOTE: upstream `Tests.meta` (the folder meta for the empty Tests/ dir) is
// intentionally KEPT. Unity 2022.3 recreates an empty Tests/ folder inside
// embedded packages when Tests.meta is absent, generating a fresh meta with a
// different GUID that breaks exact-tree verification and idempotence. When the
// meta is already present, Unity leaves it untouched (observed on the
// reference project), so shipping it keeps the installed tree byte-stable.

const DLL_META_NAMES = [
  'Microsoft.CodeAnalysis.CSharp.dll.meta',
  'Microsoft.CodeAnalysis.dll.meta',
  'System.Collections.Immutable.dll.meta',
  'System.Reflection.Metadata.dll.meta',
  'System.Runtime.CompilerServices.Unsafe.dll.meta',
];

const ALIAS_EXTRA_LF =
  '#if !UNITY_6000_0_OR_NEWER\n' +
  'using PhysicsMaterial = UnityEngine.PhysicMaterial;\n' +
  '#endif\n';

const HELPER_LF =
  '    public static class MaterialCommands\n    {\n' +
  '        private static int GetRawRenderQueue(Material material)\n' +
  '        {\n' +
  '            var serialized = new SerializedObject(material);\n' +
  '            var property = serialized.FindProperty("m_CustomRenderQueue");\n' +
  '            return property != null ? property.intValue : material.renderQueue;\n' +
  '        }\n' +
  '\n';

export interface TransformInput {
  sourceRoot: string;
  targetRoot: string;
  route: PipelineRoute;
  expectedTree: Record<string, string>;
  monoImporterBody: string;
  dllImporterBody: string;
}

export function shouldRemove(relPath: string): boolean {
  if (REMOVE_EXACT.has(relPath)) return true;
  return REMOVE_PREFIX.some((p) => relPath.startsWith(p));
}

function normalizeCrlf(buf: Buffer): Buffer {
  return Buffer.from(buf.toString('utf8').replace(/\r?\n/g, '\r\n'), 'utf8');
}

/** JSON rewrite matching the verified reference: compact separators, non-ASCII escaped, key order kept. */
export function rewritePackageJson(bytes: Buffer, targetUnity: string): Buffer {
  const text = bytes.toString('utf8');
  if (!text.startsWith('{')) {
    throw new CliError('package.json 不是 JSON 对象');
  }
  const obj = JSON.parse(text) as Record<string, unknown>;
  if (obj.unity !== targetUnity) {
    obj.unity = targetUnity;
  }
  const json = JSON.stringify(obj);
  // Match Python json.dumps(ensure_ascii=True): escape every code unit > 0x7F as
  // \uXXXX, iterating UTF-16 code units so astral (surrogate-pair) characters are
  // emitted as their proper \ud83d\ude00 escapes (not orphaned high surrogates).
  let out = '';
  for (let i = 0; i < json.length; i++) {
    const code = json.charCodeAt(i);
    out += code > 0x7f ? `\\u${code.toString(16).padStart(4, '0')}` : json[i];
  }
  if (out.endsWith('\n')) out = out.slice(0, -1);
  return Buffer.from(out, 'utf8');
}

function patchAssetCommands(bytes: Buffer): Buffer {
  let s = bytes.toString('utf8');
  const hasAlias = s.includes('using PhysicsMaterial = UnityEngine.PhysicMaterial;');
  if (!hasAlias) {
    const eol = s.includes('\r\n') ? '\r\n' : '\n';
    const marker = `using Object = UnityEngine.Object;${eol}`;
    if (!s.includes(marker)) {
      throw new CliError('AssetCommands.cs 缺少锚点 "using Object = UnityEngine.Object;"');
    }
    const extra = ALIAS_EXTRA_LF.split('\n').join(eol);
    s = s.replace(marker, marker + extra);
  }
  return normalizeCrlf(Buffer.from(s, 'utf8'));
}

function patchMaterialCommands(bytes: Buffer): Buffer {
  let s = bytes.toString('utf8');
  if (!s.includes('private static int GetRawRenderQueue(Material material)')) {
    const eol = s.includes('\r\n') ? '\r\n' : '\n';
    const marker = `    public static class MaterialCommands${eol}    {${eol}`;
    if (!s.includes(marker)) {
      throw new CliError('MaterialCommands.cs 缺少锚点 "public static class MaterialCommands"');
    }
    const helper = HELPER_LF.split('\n').join(eol);
    s = s.replace(marker, helper);
  }
  if (s.includes('RenderQueue = mat.rawRenderQueue,')) {
    s = s.replace('RenderQueue = mat.rawRenderQueue,', 'RenderQueue = GetRawRenderQueue(mat),');
  }
  return normalizeCrlf(Buffer.from(s, 'utf8'));
}

function metaBody(bytes: Buffer): { guid: string; rest: string } {
  const text = bytes.toString('utf8');
  const m = /^fileFormatVersion: 2\nguid: ([0-9a-f]{32})\n?(.*)$/s.exec(text);
  if (!m?.[1]) {
    throw new CliError('无法从 .meta 读取 guid（fileFormatVersion: 2 + guid 32hex）');
  }
  return { guid: m[1], rest: m[2] ?? '' };
}

/** Deterministic transform: upstream tgz package -> adapted package (byte-exact vs expected tree). */
export async function transformPackage(input: TransformInput): Promise<{ fileCount: number }> {
  const { sourceRoot, targetRoot, route, expectedTree, monoImporterBody, dllImporterBody } = input;
  rmSync(targetRoot, { recursive: true, force: true });
  mkdirSync(targetRoot, { recursive: true });

  const stack = [sourceRoot];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const rel = relative(sourceRoot, abs).split(sep).join('/');
      if (shouldRemove(rel)) continue;
      const destAbs = join(targetRoot, rel.split('/').join(sep));
      if (entry.isDirectory()) {
        mkdirSync(destAbs, { recursive: true });
        stack.push(abs);
        continue;
      }
      if (!entry.isFile()) {
        throw new CliError(`不支持的条目类型：${rel}`);
      }
      const bytes = readFileSync(abs);
      let out: Buffer;
      if (rel === 'package.json') {
        out = rewritePackageJson(bytes, route.targetUnityVersion);
      } else if (rel === 'Editor/Commands/Assets/AssetCommands.cs') {
        out = patchAssetCommands(bytes);
      } else if (rel === 'Editor/Commands/Materials/MaterialCommands.cs') {
        out = patchMaterialCommands(bytes);
      } else if (DLL_META_NAMES.includes(rel.split('/').pop()!)) {
        const { guid } = metaBody(bytes);
        out = Buffer.from(`fileFormatVersion: 2\nguid: ${guid}\n${dllImporterBody}`, 'utf8');
      } else if (rel.endsWith('.cs.meta')) {
        const expectedHash = expectedTree[rel];
        if (expectedHash !== undefined && sha256Buffer(bytes) === expectedHash) {
          out = bytes; // Unity kept this meta as-is
        } else {
          const { guid } = metaBody(bytes);
          out = Buffer.from(`fileFormatVersion: 2\nguid: ${guid}\n${monoImporterBody}`, 'utf8');
        }
      } else {
        out = bytes;
      }
      mkdirSync(dirname(destAbs), { recursive: true });
      writeFileSync(destAbs, out);
    }
  }

  const { ok, mismatches } = await compareTree(targetRoot, expectedTree);
  if (!ok) {
    const sample = mismatches
      .slice(0, 10)
      .map((m) => `[${m.kind}] ${m.path}`)
      .join('\n');
    throw new CliError(
      `transform 输出与 expected-tree 不一致（${mismatches.length} 项）：\n${sample}`,
    );
  }
  return { fileCount: Object.keys(expectedTree).length };
}

export function readTemplateFile(path: string): string {
  if (!existsSync(path)) {
    throw new CliError(`缺少模板文件：${path}`);
  }
  return readFileSync(path, 'utf8');
}