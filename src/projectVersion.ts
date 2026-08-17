import { join, resolve } from 'node:path';
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { CliError } from './errors.js';

export interface ProjectInfo {
  /** Absolute normalized project path, no trailing slash. */
  projectPath: string;
  /** m_EditorVersion, e.g. 2022.3.62f3c1. */
  editorVersion: string;
  /** m_EditorVersionWithRevision revision, e.g. 1623fc0bbb97; null when the line is missing. */
  revision: string | null;
  versionFile: string;
}

const VERSION_RE = /^m_EditorVersion:\s*(.+?)\s*$/m;
const REVISION_RE = /^m_EditorVersionWithRevision:\s*\S+\s+\(([^)]+)\)\s*$/m;

/** Strict Unity editor version format: YYYY.MAJOR.MINOR[baf]PATCH[+alnum suffix]. */
export const UNITY_EDITOR_VERSION_RE = /^[0-9]{4}\.[0-9]+\.[0-9]+[abf][0-9a-z]*$/i;

export function parseProjectVersion(content: string): { version: string; revision: string | null } {
  const versionMatch = VERSION_RE.exec(content);
  if (!versionMatch || !versionMatch[1]) {
    throw new CliError('ProjectVersion.txt 缺少 m_EditorVersion 字段。');
  }
  const version = versionMatch[1].trim();
  if (!UNITY_EDITOR_VERSION_RE.test(version)) {
    throw new CliError(`m_EditorVersion 格式非法（拒绝使用）：${version}`);
  }
  const revisionMatch = REVISION_RE.exec(content);
  return {
    version,
    revision: revisionMatch?.[1]?.trim() ?? null,
  };
}

export function readProjectInfo(projectPath: string): ProjectInfo {
  // Normalize to an absolute, canonical path so the editor guard and --project-path
  // binding never compare a relative input against absolute process command lines.
  let resolved = resolve(projectPath);
  let real: string | undefined;
  try {
    real = realpathSync(resolved);
  } catch {
    // Project dir may not exist yet (dry-run on a fresh path); keep the resolved form.
  }
  if (real) resolved = real;
  const full = resolved.replace(/[\\/]+$/, '');
  const versionFile = join(full, 'ProjectSettings', 'ProjectVersion.txt');
  if (!existsSync(versionFile)) {
    throw new CliError(`不是有效的 Unity 工程：缺少 ${versionFile}`);
  }
  const content = readFileSync(versionFile, 'utf8');
  const { version, revision } = parseProjectVersion(content);
  return { projectPath: full, editorVersion: version, revision, versionFile };
}