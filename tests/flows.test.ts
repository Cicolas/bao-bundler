import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FetchFlow, GitFlow, GlobFlow, NpmFlow } from '../src/flows';
import type { FlowContext } from '../src/index';

const originalCwd = process.cwd();
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  process.chdir(originalCwd);
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function fixture(): Promise<FlowContext> {
  const root = await mkdtemp(join(tmpdir(), 'bao-flows-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  process.chdir(root);
  return {
    projectRoot: root,
    cachePath: join(root, '.bao_cache'),
    dependencies: {},
  };
}
function server(fetch: (request: Request) => Response | Promise<Response>) {
  const result = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch });
  cleanup.push(() => {
    result.stop(true);
  });
  return result.url.href.replace(/\/$/, '');
}
async function command(args: string[], cwd: string) {
  const child = Bun.spawn(args, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code) throw new Error(err);
  return out.trim();
}

test('GlobFlow expands braces, excludes paths, deduplicates and ignores directories', async () => {
  await fixture();
  await mkdir('assets/nested', { recursive: true });
  await writeFile('assets/a.ts', 'a');
  await writeFile('assets/b.tsx', 'b');
  await writeFile('assets/nested/skip.ts', 'c');
  await writeFile('assets/c.css', 'd');
  const output = await new GlobFlow({
    pattern: ['assets/**/*.{ts,tsx}', 'assets/*.ts', '!**/skip.ts'],
    dest: 'build',
  }).execute();
  expect(output.source?.path).toEqual(['assets/a.ts', 'assets/b.tsx']);
});

test('FetchFlow revalidates ETag and survives staging cleanup', async () => {
  const ctx = await fixture();
  let requests = 0;
  let conditional = '';
  const base = server((request) => {
    requests++;
    conditional = request.headers.get('if-none-match') ?? '';
    return conditional === 'v1'
      ? new Response(null, { status: 304 })
      : new Response('asset', { headers: { etag: 'v1' } });
  });
  const flow = new FetchFlow({
    url: `${base}/asset.js`,
    dest: 'build/asset.js',
  });
  const first = await flow.execute(ctx);
  expect(await readFile(first.source!.path as string, 'utf8')).toBe('asset');
  await rm('.bao_sources', { recursive: true });
  const second = await flow.execute(ctx);
  expect(await readFile(second.source!.path as string, 'utf8')).toBe('asset');
  expect(requests).toBe(2);
  expect(conditional).toBe('v1');
  expect(JSON.parse(ctx.dependencies[flow.id]!)[0].etag).toBe('v1');
});

test('FetchFlow updates validators and propagates status failures', async () => {
  const ctx = await fixture();
  let version = 1;
  const base = server(() =>
    version === 3
      ? new Response('failure', { status: 503 })
      : new Response(`v${version}`, {
          headers: { 'last-modified': `version-${version}` },
        }),
  );
  const flow = new FetchFlow({
    urls: [`${base}/a.css`, `${base}/b.css`],
    dest: 'build',
  });
  await flow.execute(ctx);
  version = 2;
  const output = await flow.execute(ctx);
  expect(Array.isArray(output.source!.path)).toBe(true);
  expect(await readFile((output.source!.path as string[])[0]!, 'utf8')).toBe(
    'v2',
  );
  version = 3;
  await expect(flow.execute(ctx)).rejects.toThrow('503');
});

test('FetchFlow rejects filename collisions and unsafe encoded filenames', async () => {
  await fixture();
  await expect(
    new FetchFlow({
      urls: ['https://example.org/a.js', 'https://other.org/a.js'],
      dest: 'build',
    }).execute(),
  ).rejects.toThrow('distinct');
  await expect(
    new FetchFlow({
      url: 'https://example.org/a%2F..%2Fx',
      dest: 'build/x',
    }).execute(),
  ).rejects.toThrow('Unsafe');
});

test('GitFlow pins commits, excludes .git and supports sparse refresh', async () => {
  const ctx = await fixture();
  const repo = join(ctx.projectRoot, 'origin');
  await mkdir(repo);
  await command(['git', 'init', '-b', 'main'], repo);
  await mkdir(join(repo, 'dist'));
  await writeFile(join(repo, 'dist/a.js'), 'first');
  await writeFile(join(repo, 'secret.txt'), 'excluded');
  const commit = async () => {
    await command(['git', 'add', '.'], repo);
    await command(
      [
        'git',
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.org',
        'commit',
        '-m',
        'fixture',
      ],
      repo,
    );
  };
  await commit();
  const config = { repo, ref: 'main', sparse: ['dist/'], dest: 'build/vendor' };
  const flow = new GitFlow(config);
  const output = await flow.execute(ctx);
  const path = output.source!.path as string;
  expect(await readFile(join(path, 'dist/a.js'), 'utf8')).toBe('first');
  expect(await Bun.file(join(path, '.git/HEAD')).exists()).toBe(false);
  expect(await Bun.file(join(path, 'secret.txt')).exists()).toBe(false);
  const sha = JSON.parse(ctx.dependencies[flow.id]!).commit;
  expect(sha).toMatch(/^[a-f0-9]{40}$/);
  await writeFile(join(repo, 'dist/a.js'), 'second');
  await commit();
  await flow.execute(ctx);
  expect(await readFile(join(path, 'dist/a.js'), 'utf8')).toBe('first');
  await new GitFlow({ ...config, refresh: true }).execute(ctx);
  expect(await readFile(join(path, 'dist/a.js'), 'utf8')).toBe('second');
});

async function npmFixture() {
  const ctx = await fixture();
  let metadataRequests = 0;
  let tarRequests = 0;
  const archive = new Bun.Archive(
    {
      'package/dist/a.js': 'javascript',
      'package/css/a.css': 'stylesheet',
      'package/unused.txt': 'unused',
    },
    { compress: 'gzip' },
  );
  const bytes = new Uint8Array(await (await archive.blob()).arrayBuffer());
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  let base: string;
  base = server((request) => {
    if (new URL(request.url).pathname === '/package.tgz') {
      tarRequests++;
      return new Response(bytes);
    }
    metadataRequests++;
    return Response.json({
      'dist-tags': { latest: '1.2.0' },
      versions: Object.fromEntries(
        ['1.0.0', '1.2.0', '2.0.0'].map((version) => [
          version,
          { dist: { tarball: `${base}/package.tgz`, integrity } },
        ]),
      ),
    });
  });
  return {
    ctx,
    base,
    integrity,
    requests: () => [metadataRequests, tarRequests],
  };
}

test('NpmFlow resolves ranges, extracts selected files and preserves paths', async () => {
  const { ctx, base, requests } = await npmFixture();
  const flow = new NpmFlow({
    package: '@test/fixture',
    version: '^1.0.0',
    files: ['dist/*.js', 'css/a.css'],
    dest: 'build/vendor',
    registry: base,
  });
  const output = await flow.execute(ctx);
  expect(output.dest!.path).toEqual([
    'build/vendor/css/a.css',
    'build/vendor/dist/a.js',
  ]);
  expect((output.source!.path as string[]).length).toBe(2);
  expect(JSON.parse(ctx.dependencies[flow.id]!).version).toBe('1.2.0');
  await rm('.bao_sources', { recursive: true });
  await flow.execute(ctx);
  expect(requests()).toEqual([2, 1]);
});

test('NpmFlow respects npm lock versions, verifies integrity and avoids network for cached pins', async () => {
  const { ctx, base, integrity, requests } = await npmFixture();
  await writeFile(
    'package-lock.json',
    JSON.stringify({
      packages: { 'node_modules/fixture': { version: '1.0.0', integrity } },
    }),
  );
  const flow = new NpmFlow({
    package: 'fixture',
    version: '^1.0.0',
    files: ['dist/a.js'],
    dest: 'build',
    registry: base,
  });
  await flow.execute(ctx);
  await flow.execute(ctx);
  expect(requests()).toEqual([1, 1]);
  expect(JSON.parse(ctx.dependencies[flow.id]!).version).toBe('1.0.0');
  await writeFile(
    'package-lock.json',
    JSON.stringify({
      packages: {
        'node_modules/fixture': { version: '1.0.0', integrity: 'sha512-wrong' },
      },
    }),
  );
  await expect(flow.execute(ctx)).rejects.toThrow('integrity');
});

test('NpmFlow respects Bun JSONC lockfiles and errors on incompatible pins or missing files', async () => {
  const { ctx, base, integrity } = await npmFixture();
  await writeFile(
    'bun.lock',
    `{ packages: { "fixture": ["fixture@1.0.0", "", {}, "${integrity}"], }, }`,
  );
  const flow = new NpmFlow({
    package: 'fixture',
    version: '^1.0.0',
    files: ['missing.js'],
    dest: 'build',
    registry: base,
  });
  await expect(flow.execute(ctx)).rejects.toThrow('matched no files');
  await expect(
    new NpmFlow({
      package: 'fixture',
      version: '^2.0.0',
      files: ['dist/a.js'],
      dest: 'build',
      registry: base,
    }).execute(ctx),
  ).rejects.toThrow('does not satisfy');
});
