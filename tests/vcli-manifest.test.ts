import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { buildProgram } from '../src/cli.js';
import type { Command } from 'commander';

/**
 * Deterministic manifest validation + CLI-drift tests.
 *
 * The v-cli plugin manifest (v-cli.plugin.json) is a *derived* artifact: its
 * command tree, arguments, options, usages and descriptions must mirror
 * buildProgram() exactly. Any command/option/argument added to the CLI
 * without updating the manifest (or vice versa) fails here.
 */

interface ManifestOption {
  flags: string;
  description: string;
}
interface ManifestArgument {
  name: string;
  required: boolean;
  description: string;
}
interface ManifestCommand {
  path: string[];
  usage: string;
  description: string;
  arguments: ManifestArgument[];
  options: ManifestOption[];
  output: { format: string; description: string };
  exitCodes: Record<string, string>;
  safety: string[];
}
interface PipelineCommandGroup {
  group: string;
  tools: Record<string, string>;
}
interface Manifest {
  schemaVersion: number;
  package: string;
  command: string;
  bin: string;
  description: string;
  platforms: string[];
  runtime: Record<string, string>;
  environment: { name: string; description: string }[];
  agent: {
    whenToUse: string;
    globalOptions: ManifestOption[];
    commands: ManifestCommand[];
    pipelineCommands: PipelineCommandGroup[];
  };
}

const EXPECTED_VERSION = '0.1.1';
const EXPECTED_PACKAGE = '@kevlns/u-cli-mod';
const MANIFEST_PATH = 'v-cli.plugin.json';
const AGENT_DOC_PATH = 'AGENTS.md';

const MANIFEST_KEYS = ['agent', 'bin', 'command', 'description', 'environment', 'package', 'platforms', 'runtime', 'schemaVersion'];
const COMMAND_KEYS = ['arguments', 'description', 'exitCodes', 'options', 'output', 'path', 'safety', 'usage'];
const OPTION_KEYS = ['description', 'flags'];
const ARGUMENT_KEYS = ['description', 'name', 'required'];
const OUTPUT_KEYS = ['description', 'format'];
const ENV_KEYS = ['description', 'name'];

function loadJson<T>(relative: string): T {
  const raw = readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');
  return JSON.parse(raw) as T;
}

function loadManifest(): Manifest {
  return loadJson<Manifest>(MANIFEST_PATH);
}

function findCommand(program: Command, path: string[]): Command {
  let current = program;
  for (const segment of path) {
    const next = current.commands.find((c) => c.name() === segment);
    if (!next) {
      throw new Error(`manifest path '${path.join(' ')}' not found in CLI (segment '${segment}')`);
    }
    current = next;
  }
  return current;
}

/** Leaf commands only (groups like `cli`/`pipeline`/`cache` have subcommands). */
function leafPaths(program: Command, prefix: string[] = []): string[][] {
  const out: string[][] = [];
  for (const child of program.commands) {
    const path = [...prefix, child.name()];
    if (child.commands.length === 0) out.push(path);
    else out.push(...leafPaths(child, path));
  }
  return out;
}

function expectedUsage(path: string[], args: { name: string; required: boolean }[]): string {
  const head =
    `u-cli-mod ${path.join(' ')}` +
    args.map((a) => (a.required ? ` <${a.name}>` : ` [${a.name}]`)).join('') +
    ' [options]';
  return path.join(' ') === 'exec' ? `${head} -- <unity-cli-args...>` : head;
}

function flagTokens(flags: string): string[] {
  return flags.split(/[\s,]+/).filter((t) => /^--?[\w-]+$/.test(t) && t !== '-');
}

function canonicalFlags(options: { flags: string }[]): string[] {
  const set = new Set<string>();
  for (const option of options) {
    for (const token of flagTokens(option.flags)) set.add(token);
  }
  return [...set].sort();
}

function sortedPaths(paths: string[][]): string[][] {
  return [...paths].sort((a, b) => a.join('/').localeCompare(b.join('/')));
}

describe('v-cli.plugin.json schema', () => {
  it('exists at the package root and matches the official manifest shape', () => {
    expect(existsSync(new URL(`../${MANIFEST_PATH}`, import.meta.url))).toBe(true);
    const manifest = loadManifest();
    expect(Object.keys(manifest).sort()).toEqual([...MANIFEST_KEYS].sort());
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.package).toBe(EXPECTED_PACKAGE);
    expect(manifest.command).toBe('unity');
    expect(manifest.bin).toBe('u-cli-mod');
    expect(manifest.description.length).toBeGreaterThan(0);
    expect(manifest.platforms).toEqual(['win32']);
    expect(manifest.runtime.node).toBe('>=20');
    expect(manifest.runtime.os).toBe('win32');
  });

  it('environment metadata is deterministic and non-empty', () => {
    const manifest = loadManifest();
    expect(manifest.environment.length).toBeGreaterThan(0);
    for (const entry of manifest.environment) {
      expect(Object.keys(entry).sort()).toEqual([...ENV_KEYS].sort());
      expect(entry.name).toMatch(/^[A-Z][A-Z0-9_]*$/);
      expect(entry.description.length).toBeGreaterThan(0);
    }
    const names = manifest.environment.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('agent metadata is deterministic (whenToUse, globalOptions, commands)', () => {
    const manifest = loadManifest();
    expect(manifest.agent.whenToUse.length).toBeGreaterThan(0);
    expect(manifest.agent.globalOptions.length).toBeGreaterThan(0);
    for (const option of manifest.agent.globalOptions) {
      expect(Object.keys(option).sort()).toEqual([...OPTION_KEYS].sort());
      expect(option.flags.length).toBeGreaterThan(0);
      expect(option.description.length).toBeGreaterThan(0);
    }
    expect(manifest.agent.commands.length).toBeGreaterThan(0);
    const paths = new Set<string>();
    for (const command of manifest.agent.commands) {
      expect(command.path.length).toBeGreaterThan(0);
      expect(paths.has(command.path.join(' '))).toBe(false);
      paths.add(command.path.join(' '));
    }
  });
});

describe('v-cli.plugin.json vs CLI drift (behavioral source of truth)', () => {
  it('global options match the root CLI options', () => {
    const program = buildProgram();
    const manifest = loadManifest();
    // Root program exposes -V/--version; -h/--help is commander's default.
    const rootTokens = canonicalFlags(program.options);
    const manifestTokens = canonicalFlags(manifest.agent.globalOptions);
    expect([...rootTokens, '-h', '--help'].sort()).toEqual(manifestTokens);

    const versionOption = program.options.find((o) => flagTokens(o.flags).includes('--version'));
    const manifestVersion = manifest.agent.globalOptions.find((o) => flagTokens(o.flags).includes('--version'));
    expect(manifestVersion?.flags).toBe('-V, --version');
    expect(versionOption?.description).toBe(manifestVersion?.description);

    const manifestHelp = manifest.agent.globalOptions.find((o) => flagTokens(o.flags).includes('--help'));
    expect(manifestHelp?.flags).toBe('-h, --help');
    expect(manifestHelp?.description).toBe('display help for command');
  });

  it('manifest command paths exactly cover the public CLI command tree', () => {
    const program = buildProgram();
    const manifest = loadManifest();
    expect(sortedPaths(leafPaths(program))).toEqual(
      sortedPaths(manifest.agent.commands.map((c) => c.path)),
    );
  });

  it('each manifest command mirrors its CLI definition', () => {
    const program = buildProgram();
    const manifest = loadManifest();
    for (const mc of manifest.agent.commands) {
      const label = mc.path.join(' ');
      const cmd = findCommand(program, mc.path);

      expect(Object.keys(mc).sort(), `${label} keys`).toEqual([...COMMAND_KEYS].sort());

      // Description, usage, arguments (name + required) must match exactly.
      expect(cmd.description(), `${label} description`).toBe(mc.description);
      const args = cmd.registeredArguments.map((a) => ({ name: a.name(), required: a.required }));
      expect(args, `${label} arguments`).toEqual(
        mc.arguments.map((a) => ({ name: a.name, required: a.required })),
      );
      expect(mc.arguments.every((a) => Object.keys(a).sort().join() === [...ARGUMENT_KEYS].sort().join()), `${label} argument keys`).toBe(true);
      expect(mc.arguments.every((a) => a.description.length > 0), `${label} argument descriptions`).toBe(true);
      expect(mc.usage, `${label} usage`).toBe(expectedUsage(mc.path, args));

      // Options (flags and descriptions, in CLI order) must match exactly.
      expect(Object.keys(mc.options).length === 0 || mc.options.every((o) => Object.keys(o).sort().join() === [...OPTION_KEYS].sort().join()), `${label} option keys`).toBe(true);
      expect(cmd.options.map((o) => o.flags), `${label} option flags`).toEqual(mc.options.map((o) => o.flags));
      expect(cmd.options.map((o) => o.description), `${label} option descriptions`).toEqual(
        mc.options.map((o) => o.description),
      );

      // Output / exit codes / safety must be present and non-empty.
      expect(Object.keys(mc.output).sort()).toEqual([...OUTPUT_KEYS].sort());
      expect(['json', 'text']).toContain(mc.output.format);
      expect(mc.output.description.length).toBeGreaterThan(0);
      expect(Object.keys(mc.exitCodes).length).toBeGreaterThan(0);
      expect(mc.exitCodes['0']?.length ?? 0).toBeGreaterThan(0);
      expect(mc.safety.length).toBeGreaterThan(0);
      expect(mc.safety.every((s) => typeof s === 'string' && s.length > 0)).toBe(true);
    }
  });
});

describe('release consistency (package pointer, files, versions)', () => {
  it('package.json version/files/vCli pointer and lockfile stay aligned', () => {
    const pkg = loadJson<{
      name: string;
      version: string;
      engines: { node: string };
      files: string[];
      vCli: { manifest: string };
      bin: Record<string, string>;
    }>('package.json');
    const lock = loadJson<{ version: string; packages: Record<string, { version: string }> }>(
      'package-lock.json',
    );
    const manifest = loadManifest();

    expect(pkg.name).toBe(EXPECTED_PACKAGE);
    expect(pkg.version).toBe(EXPECTED_VERSION);
    expect(pkg.vCli.manifest).toBe(MANIFEST_PATH);
    expect(pkg.files).toContain(MANIFEST_PATH);

    expect(lock.version).toBe(pkg.version);
    expect(lock.packages[''].version).toBe(pkg.version);

    expect(manifest.package).toBe(pkg.name);
    expect(manifest.bin).toBe(Object.keys(pkg.bin)[0]);
    expect(manifest.runtime.node).toBe(pkg.engines.node);
  });

  it('ships a non-empty package AGENTS.md', () => {
    const pkg = loadJson<{ files: string[] }>('package.json');
    const doc = new URL(`../${AGENT_DOC_PATH}`, import.meta.url);
    expect(pkg.files).toContain(AGENT_DOC_PATH);
    expect(existsSync(doc)).toBe(true);
    expect(readFileSync(doc, 'utf8').trim().length).toBeGreaterThan(0);
  });
});

describe('pipeline command catalog (agent.pipelineCommands)', () => {
  it('is present, well-formed, and non-empty', () => {
    const manifest = loadManifest();
    const catalog = manifest.agent.pipelineCommands;
    expect(Array.isArray(catalog)).toBe(true);
    expect(catalog.length).toBeGreaterThan(0);

    const seen = new Set<string>();
    let total = 0;
    for (const group of catalog) {
      expect(typeof group.group).toBe('string');
      expect(group.group.length).toBeGreaterThan(0);
      expect(typeof group.tools).toBe('object');
      const names = Object.keys(group.tools);
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) {
        expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
        expect(typeof group.tools[name]).toBe('string');
        expect(group.tools[name].length).toBeGreaterThan(0);
        expect(seen.has(name)).toBe(false);
        seen.add(name);
        total++;
      }
    }
    expect(total).toBeGreaterThan(100);
  });

  it('mirrors the AGENTS.md catalog exactly (no drift)', () => {
    const manifest = loadManifest();
    const doc = readFileSync(new URL(`../${AGENT_DOC_PATH}`, import.meta.url), 'utf8');
    const mdTools = new Map<string, string>();
    for (const line of doc.split('\n')) {
      const m = line.match(/^- `([a-z][a-z0-9_]*)` — (.+)$/);
      if (m) mdTools.set(m[1], m[2]);
    }

    const catalogTools = new Map<string, string>();
    for (const group of manifest.agent.pipelineCommands) {
      for (const [name, desc] of Object.entries(group.tools)) {
        catalogTools.set(name, desc);
      }
    }

    expect(mdTools.size).toBe(catalogTools.size);
    for (const [name, desc] of catalogTools) {
      expect(mdTools.get(name), `AGENTS.md missing or differs for '${name}'`).toBe(desc);
    }
  });
});