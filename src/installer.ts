import { cp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CliError } from './errors.js';
import { compareTree } from './integrity.js';
import type { ProjectInfo } from './projectVersion.js';
import type { VersionRoute } from './routes.js';
import { guardNoRunningEditor } from './unityGuard.js';
import type { EditorGuardResult } from './unityGuard.js';

export interface InstallOptions {
  force?: boolean;
  allowRunningEditor?: boolean;
  dryRun?: boolean;
  /** injectable for tests */
  guard?: (projectPath: string) => Promise<EditorGuardResult>;
  /** injectable for tests: file-tree copy (e.g. simulate partial copy failure). */
  copy?: (src: string, dest: string) => Promise<void>;
}

export interface InstallResult {
  status: 'Installed' | 'AlreadyInstalled' | 'DryRun';
  projectPath: string;
  editorVersion: string;
  editorRevision: string;
  pipelineVersion: string;
  packagePath: string;
  fileCount: number;
  backupPath?: string;
}

export async function verifyPackageRoot(root: string, expected: Record<string, string>): Promise<number> {
  const { ok, mismatches, fileCount } = await compareTree(root, expected);
  if (!ok) {
    const sample = mismatches
      .slice(0, 10)
      .map((m) => `[${m.kind}] ${m.path}`)
      .join('\n');
    throw new CliError(`com.unity.pipeline 完整性校验失败（${mismatches.length} 项）：\n${sample}`);
  }
  return fileCount;
}

export async function installPipeline(
  project: ProjectInfo,
  route: VersionRoute,
  sourceDir: string,
  expectedTree: Record<string, string>,
  options: InstallOptions = {},
): Promise<InstallResult> {
  const destination = join(project.projectPath, 'Packages', 'com.unity.pipeline');
  const guard = options.guard ?? ((path: string) => guardNoRunningEditor(path));
  const copy =
    options.copy ??
    ((src: string, dest: string) => cp(src, dest, { recursive: true }));

  // 1. Source must already be verified by the caller; double-check once more.
  const sourceFileCount = await verifyPackageRoot(sourceDir, expectedTree);

  // 2. Fail-closed running-editor guard.
  if (!options.allowRunningEditor) {
    const result = await guard(project.projectPath);
    if (!result.ok) {
      const who = result.blockedBy.join(', ');
      throw new CliError(
        `目标工程正在被 Unity Editor 使用（${who}）。请先关闭 Editor；明确继续时使用 --allow-running-editor。${result.reason ?? ''}`,
      );
    }
  }

  // 3. Dry-run takes priority: it only inspects, so it returns before any
  //    idempotence/conflict decision that could report a different status.
  if (options.dryRun) {
    return {
      status: 'DryRun',
      projectPath: project.projectPath,
      editorVersion: project.editorVersion,
      editorRevision: project.revision ?? '',
      pipelineVersion: route.pipeline.version,
      packagePath: destination,
      fileCount: sourceFileCount,
    };
  }

  // 4. Idempotence / conflict check.
  let existingIsValid = false;
  if (existsSync(destination)) {
    try {
      await verifyPackageRoot(destination, expectedTree);
      existingIsValid = true;
    } catch {
      existingIsValid = false;
    }
    if (existingIsValid && !options.force) {
      return {
        status: 'AlreadyInstalled',
        projectPath: project.projectPath,
        editorVersion: project.editorVersion,
        editorRevision: project.revision ?? '',
        pipelineVersion: route.pipeline.version,
        packagePath: destination,
        fileCount: sourceFileCount,
      };
    }
    if (!options.force) {
      throw new CliError(
        '工程中的 com.unity.pipeline 与当前路由不一致或已损坏。确认备份并覆盖时使用 --force。',
      );
    }
  }

  // 5. Transaction: stage -> backup -> move -> verify -> receipt; rollback on any failure.
  const libRoot = join(project.projectPath, 'Library', 'editor-pipeline-cli');
  const stagingRoot = join(libRoot, `staging-${randomUUID()}`);
  const stagedPackage = join(stagingRoot, 'com.unity.pipeline');
  let backupPath: string | undefined;
  let destMoved = false;
  let destTouched = false;

  try {
    await mkdir(stagingRoot, { recursive: true });
    await copy(sourceDir, stagedPackage);
    await verifyPackageRoot(stagedPackage, expectedTree);

    await mkdir(join(project.projectPath, 'Packages'), { recursive: true });
    if (existsSync(destination)) {
      const backups = join(libRoot, 'backups');
      await mkdir(backups, { recursive: true });
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      backupPath = join(backups, `com.unity.pipeline-${timestamp}-${randomUUID()}`);
      await cp(destination, backupPath, { recursive: true });
      await rm(destination, { recursive: true, force: true });
      destMoved = true;
    }

    destTouched = true;
    await copy(stagedPackage, destination);
    await verifyPackageRoot(destination, expectedTree);

    const receipt = {
      installedAt: new Date().toISOString(),
      projectPath: project.projectPath,
      editorVersion: project.editorVersion,
      editorRevision: project.revision,
      pipelineVersion: route.pipeline.version,
      patchVersion: route.pipeline.patchVersion,
      packagePath: destination,
      backupPath: backupPath ?? null,
      source: `${route.pipeline.packageName}@${route.pipeline.version} (patched ${route.pipeline.patchVersion})`,
    };
    await mkdir(libRoot, { recursive: true });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(libRoot, 'receipt.json'), JSON.stringify(receipt, null, 2), 'utf8');

    return {
      status: 'Installed',
      projectPath: project.projectPath,
      editorVersion: project.editorVersion,
      editorRevision: project.revision ?? '',
      pipelineVersion: route.pipeline.version,
      packagePath: destination,
      fileCount: sourceFileCount,
      backupPath,
    };
  } catch (err) {
    // If the old package was moved out, unconditionally remove any partial/new
    // destination and restore the backup (partial copy failure included).
    if (destMoved) {
      await rm(destination, { recursive: true, force: true });
      if (backupPath && existsSync(backupPath)) {
        await copy(backupPath, destination);
      }
    } else if (destTouched) {
      // Fresh install (no old package): the placement copy started, so any
      // partial tree at the destination must be removed.
      await rm(destination, { recursive: true, force: true });
    }
    throw err instanceof CliError
      ? err
      : new CliError(`安装失败（已回滚）：${err instanceof Error ? err.message : String(err)}`);
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}
