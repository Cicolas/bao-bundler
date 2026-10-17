import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FolderFlow } from '../src/flows';
import { CopyRunner } from '../src/runners';
import { Project, type Flow, type Runner } from '../src/index';

const originalCwd = process.cwd();
let root: string;
const flow: Flow = { id: 'assets', async execute() { return { source: { path: 'assets' }, dest: { path: 'build' } }; } };
const copy: Runner = { async run(input) { await cp(input.source!.path as string, input.dest!.path as string, { recursive: true }); } };
const project = (runner = copy) => new Project('test', [{ flow, runner }]);
const content = (path = 'build/file.txt') => readFile(join(root, path), 'utf8');

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'bao-safety-'));
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'assets/file.txt'), 'old');
  process.chdir(root);
});
afterEach(async () => { process.chdir(originalCwd); await rm(root, { recursive: true, force: true }); });

describe('transactional Project builds', () => {
  test('cleans the active staging directory so deleted assets disappear', async () => {
    const builder = project();
    await builder.build();
    await rm(join(root, 'assets/file.txt'));
    await writeFile(join(root, 'assets/new.txt'), 'new');
    await builder.build();
    expect(await Bun.file(join(root, 'build/file.txt')).exists()).toBe(false);
    expect(await content('build/new.txt')).toBe('new');
    expect(process.cwd()).toBe(root);
  });

  test('expanded flows drop deleted manifest entries across separate Project instances', async () => {
    const expanded = () => new Project('expanded', [{
      flow: new FolderFlow({ source: 'assets', dest: 'build', expand: true }), runner: new CopyRunner(),
    }]);
    await expanded().build();
    await rm(join(root, 'assets/file.txt'));
    await writeFile(join(root, 'assets/new.txt'), 'new');
    await expanded().build();
    expect(await Bun.file(join(root, 'build/file.txt')).exists()).toBe(false);
    const manifest = JSON.parse(await content('bao.manifest.json'));
    expect(manifest.flows['FolderFlow:assets']).toEqual(['assets/new.txt']);
  });

  test('does not delete source assets through a symlink alias', async () => {
    await symlink(join(root, 'assets'), join(root, 'alias'));
    await expect(new Project('unsafe', [], { tmpPath: 'alias' }).build()).rejects.toThrow('Unsafe');
    expect(await content('assets/file.txt')).toBe('old');
  });

  test('refuses unowned reserved publication directories', async () => {
    await mkdir(join(root, 'build.bao-backup'));
    await writeFile(join(root, 'build.bao-backup/keep'), 'user file');
    await expect(project().build()).rejects.toThrow('without a journal');
    expect(await content('build.bao-backup/keep')).toBe('user file');
  });

  test('failed runners preserve output and manifest, restore cwd, and stop dependent steps', async () => {
    await project().build();
    const manifest = await content('bao.manifest.json');
    let dependentRan = false;
    const builder = new Project('failing', [
      { flow, runner: { async run() { await mkdir('build', { recursive: true }); await writeFile('build/file.txt', 'partial'); throw new Error('runner failed'); } } },
      { flow, runner: { async run() { dependentRan = true; } } },
    ]);
    await expect(builder.build()).rejects.toThrow('runner failed');
    expect(await content()).toBe('old');
    expect(await content('bao.manifest.json')).toBe(manifest);
    expect(process.cwd()).toBe(root);
    expect(dependentRan).toBe(false);
    await writeFile(join(root, 'assets/file.txt'), 'recovered');
    await project().build();
    expect(await content()).toBe('recovered');
  });

  test('flow failure restores cwd even after the flow changes directory', async () => {
    const badFlow: Flow = { id: 'failed', async execute() { process.chdir('assets'); throw new Error('flow failed'); } };
    await expect(new Project('failing', [{ flow: badFlow, runner: copy }]).build()).rejects.toThrow('flow failed');
    expect(process.cwd()).toBe(root);
  });

  test('missing staged output and manifest write failure preserve previous output', async () => {
    await project().build();
    await expect(project({ async run() {} }).build()).rejects.toThrow();
    expect(await content()).toBe('old');
    class ManifestFailure extends Project {
      override async saveToManifest(): Promise<void> { throw new Error('manifest write failed'); }
    }
    await expect(new ManifestFailure('fail', [{ flow, runner: copy }]).build()).rejects.toThrow('manifest write failed');
    expect(await content()).toBe('old');
    expect(await Bun.file(join(root, '.bao.build-state.json')).exists()).toBe(false);
  });

  test.each(['build.bao-stage', '.bao.manifest.stage.json'])('rolls back output and manifest when publication rename fails: %s', async (failingName) => {
    await project().build();
    const manifest = await content('bao.manifest.json');
    await writeFile(join(root, 'assets/file.txt'), 'new');
    // Isolate the filesystem mock in a child process so other tests use real fs.
    const script = `
      import { mock } from 'bun:test';
      const fs = await import('node:fs/promises');
      const actualRename = fs.rename;
      mock.module('node:fs/promises', () => ({ ...fs, rename: async (from, to) => {
        if (String(from).endsWith(${JSON.stringify('/' + failingName)})) throw new Error('injected publication failure');
        return actualRename(from, to);
      }}));
      const { Project } = await import(${JSON.stringify(join(originalCwd, 'src/index.ts'))});
      const project = new Project('failure', [{ flow: { id: 'copy', async execute() { return {}; } }, runner: {
        async run() { await fs.cp('assets', 'build', { recursive: true }); }
      } }]);
      try { await project.build(); process.exit(2); }
      catch (error) { if (!String(error).includes('injected publication failure')) throw error; }
    `;
    const child = Bun.spawn([process.execPath, '-e', script], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited, stderr).toBe(0);
    expect(await content()).toBe('old');
    expect(await content('bao.manifest.json')).toBe(manifest);
    expect(await Bun.file(join(root, '.bao.build-state.json')).exists()).toBe(false);
  });

  test('recovers an interrupted output publication before starting the next build', async () => {
    await project().build();
    const manifest = await content('bao.manifest.json');
    await cp(join(root, 'build'), join(root, 'build.bao-backup'), { recursive: true });
    await writeFile(join(root, 'build/file.txt'), 'interrupted');
    await cp(join(root, 'bao.manifest.json'), join(root, '.bao.manifest.backup.json'));
    await writeFile(join(root, 'bao.manifest.json'), '{invalid');
    await writeFile(join(root, '.bao.build-state.json'), JSON.stringify({ version: 1, status: 'in_progress', output: join(root, 'build'), hadOutput: true, hadManifest: true }));
    await expect(project({ async run() { throw new Error('next step failed'); } }).build()).rejects.toThrow('next step failed');
    expect(await content()).toBe('old');
    expect(await content('bao.manifest.json')).toBe(manifest);
    expect(await Bun.file(join(root, '.bao.build-state.json')).exists()).toBe(false);
  });

  test('retains committed output when interruption only left backup cleanup', async () => {
    await project().build();
    await cp(join(root, 'build'), join(root, 'build.bao-backup'), { recursive: true });
    await writeFile(join(root, 'build/file.txt'), 'committed');
    await writeFile(join(root, '.bao.build-state.json'), JSON.stringify({ version: 1, status: 'success', output: join(root, 'build'), hadOutput: true, hadManifest: true }));
    await expect(project({ async run() { throw new Error('stop'); } }).build()).rejects.toThrow('stop');
    expect(await content()).toBe('committed');
    expect(await Bun.file(join(root, 'build.bao-backup/file.txt')).exists()).toBe(false);
  });

  test('supports nested temp/output directories and persistent flow context', async () => {
    await mkdir(join(root, '.bao_cache'));
    await writeFile(join(root, '.bao_cache/keep'), 'cached');
    const nested: Flow = { id: 'nested', async execute(context) {
      expect(context!.projectRoot).toBe(root);
      expect(context!.cachePath).toBe(join(root, '.bao_cache'));
      context!.dependencies.example = 'version';
      return { source: { path: 'assets' }, dest: { path: 'dist/site' } };
    } };
    const builder = new Project('nested', [{ flow: nested, runner: copy }], { tmpPath: 'scratch/deep', buildPath: 'dist/site' });
    await builder.build();
    await builder.build();
    expect(await content('dist/site/file.txt')).toBe('old');
    expect(await content('.bao_cache/keep')).toBe('cached');
    expect(process.cwd()).toBe(root);
  });

  test('supports absolute temp, assets and output paths', async () => {
    await new Project('absolute', [{ flow, runner: copy }], {
      tmpPath: join(root, 'scratch/deep'), assetsPath: join(root, 'assets'), buildPath: join(root, 'build'),
    }).build();
    expect(await content()).toBe('old');
    expect(process.cwd()).toBe(root);
  });

  test.each([
    { tmpPath: '.' }, { tmpPath: '..' }, { buildPath: '.' },
    { tmpPath: 'assets' }, { tmpPath: 'bao.manifest.json' }, { buildPath: 'bao.manifest.json' }, { buildPath: 'assets/output' }, { buildPath: '../outside' },
    { assetsPath: '../outside' }, { tmpPath: '.bao_cache/work' },
  ])('rejects unsafe paths before deletion: %j', async (config) => {
    await expect(new Project('unsafe', [], config).build()).rejects.toThrow();
    expect(await content('assets/file.txt')).toBe('old');
    expect(process.cwd()).toBe(root);
  });

  test('rejects simultaneous builds because cwd is process-wide', async () => {
    let unblock!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    const running = project({ async run(input) { started(); await blocked; await copy.run(input); } }).build();
    await ready;
    try { await expect(project().build()).rejects.toThrow('already running'); }
    finally { unblock(); await running; }
    expect(process.cwd()).toBe(root);
  });
});

test('preserves current source ordering for paired destinations after new files appear', async () => {
  await writeFile(join(root, 'assets/a.txt'), 'A');
  await writeFile(join(root, 'assets/b.txt'), 'B');
  let files = ['b.txt'];
  const pairedFlow: Flow = {
    id: 'paired',
    async execute() {
      return {
        source: { path: files.map(file => `assets/${file}`) },
        dest: { path: files.map(file => `build/${file}`) },
      };
    },
  };
  const build = () => new Project('paired', [{ flow: pairedFlow, runner: new CopyRunner() }]).build();
  await build();
  files = ['a.txt', 'b.txt'];
  await build();
  expect(await content('build/a.txt')).toBe('A');
  expect(await content('build/b.txt')).toBe('B');
  const manifest = JSON.parse(await content('bao.manifest.json'));
  expect(manifest.flows.paired).toEqual(['assets/a.txt', 'assets/b.txt']);
});


test('preserves repeated sources when explicitly paired with different destinations', async () => {
  const pairedFlow: Flow = {
    id: 'repeat-paired',
    async execute() {
      return {
        source: { path: ['assets/file.txt', 'assets/file.txt'] },
        dest: { path: ['build/a.txt', 'build/b.txt'] },
      };
    },
  };
  await new Project('paired', [{ flow: pairedFlow, runner: new CopyRunner() }]).build();
  expect(await content('build/a.txt')).toBe('old');
  expect(await content('build/b.txt')).toBe('old');
});
