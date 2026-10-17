import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { Flow, FlowContext, FlowOutput } from './index';

type CacheRecord = Record<string, any>;
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
function context(input?: FlowContext): FlowContext {
  return (
    input ?? {
      projectRoot: process.cwd(),
      cachePath: resolve('.bao_cache'),
      dependencies: {},
    }
  );
}
async function json(path: string): Promise<CacheRecord | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error: any) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
}
async function atomicWrite(
  path: string,
  data: string | Uint8Array,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, data);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
async function exists(path: string): Promise<boolean> {
  return Bun.file(path).exists();
}
async function checkedFetch(
  url: string,
  headers?: Record<string, string>,
): Promise<Response> {
  const response = await fetch(url, { headers });
  if (!response.ok && response.status !== 304)
    throw new Error(`Fetch failed (${response.status}): ${url}`);
  return response;
}
function safeName(path: string): string {
  if (
    !path ||
    path.includes('\\') ||
    path.startsWith('/') ||
    /^[A-Za-z]:/.test(path) ||
    path.split('/').some((p) => p === '..' || p === '.')
  ) {
    throw new Error(`Unsafe asset path: ${path}`);
  }
  return path;
}
async function stageFile(source: string, target: string): Promise<string> {
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target);
  return target;
}

export type FetchFlowConfig = (
  { url: string; urls?: never } | { urls: string[]; url?: never }
) & { dest: string };
/** Download HTTP assets with conditional requests and a persistent content cache. */
export class FetchFlow implements Flow {
  readonly id: string;
  constructor(private config: FetchFlowConfig) {
    const urls = config.urls ?? [config.url];
    if (!urls.length) throw new Error('FetchFlow requires at least one URL');
    for (const url of urls)
      if (!['http:', 'https:'].includes(new URL(url).protocol))
        throw new Error('FetchFlow requires HTTP(S) URLs');
    this.id = `FetchFlow:${hash(JSON.stringify(config))}`;
  }
  async execute(input?: FlowContext): Promise<FlowOutput> {
    const ctx = context(input);
    const urls = this.config.urls ?? [this.config.url];
    const names = urls.map((url) => {
      const name = safeName(
        decodeURIComponent(basename(new URL(url).pathname)) || 'download',
      );
      if (name.includes('/')) throw new Error(`Unsafe asset filename: ${name}`);
      return name;
    });
    if (new Set(names).size !== names.length)
      throw new Error('FetchFlow URLs must have distinct filenames');
    const paths: string[] = [];
    const records: CacheRecord[] = [];
    for (const [index, url] of urls.entries()) {
      const cache = join(ctx.cachePath, 'fetch', hash(url));
      const content = join(cache, 'content');
      const metadata = await json(join(cache, 'metadata.json'));
      const cached = await exists(content);
      const headers: Record<string, string> = {};
      if (cached && metadata?.etag) headers['If-None-Match'] = metadata.etag;
      if (cached && metadata?.lastModified)
        headers['If-Modified-Since'] = metadata.lastModified;
      const response = await checkedFetch(url, headers);
      let record = metadata;
      if (response.status === 304) {
        if (!cached) throw new Error(`HTTP 304 without cached content: ${url}`);
      } else {
        await atomicWrite(
          content,
          new Uint8Array(await response.arrayBuffer()),
        );
        record = {
          url,
          etag: response.headers.get('etag'),
          lastModified: response.headers.get('last-modified'),
        };
        await atomicWrite(join(cache, 'metadata.json'), JSON.stringify(record));
      }
      paths.push(
        await stageFile(
          content,
          join('.bao_sources', 'fetch', hash(this.id), names[index]!),
        ),
      );
      records.push(record!);
    }
    ctx.dependencies[this.id] = JSON.stringify(records);
    return {
      source: { path: this.config.urls ? paths : paths[0]! },
      dest: { path: this.config.dest },
    };
  }
}

async function git(args: string[], cwd: string): Promise<string> {
  const child = Bun.spawn(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exit !== 0) throw new Error(`git ${args[0]} failed: ${stderr.trim()}`);
  return stdout.trim();
}
export type GitFlowConfig = {
  repo: string;
  ref?: string;
  sparse?: string[];
  dest: string;
  refresh?: boolean;
};
/** Clone an external source; cached refs stay pinned until refresh is requested. */
export class GitFlow implements Flow {
  readonly id: string;
  constructor(private config: GitFlowConfig) {
    if (
      !config.repo ||
      config.repo.startsWith('-') ||
      config.ref?.startsWith('-')
    )
      throw new Error('Invalid Git repository or ref');
    for (const path of config.sparse ?? []) safeName(path.replace(/\/$/, ''));
    this.id = `GitFlow:${hash(JSON.stringify({ repo: config.repo, ref: config.ref ?? 'HEAD', sparse: config.sparse }))}`;
  }
  async execute(input?: FlowContext): Promise<FlowOutput> {
    const ctx = context(input);
    const cache = join(ctx.cachePath, 'git', hash(this.id));
    const repository = join(cache, 'repo');
    let metadata = await json(join(cache, 'metadata.json'));
    if (
      !metadata ||
      this.config.refresh ||
      !(await exists(join(repository, '.git', 'HEAD')))
    ) {
      await mkdir(cache, { recursive: true });
      if (!(await exists(join(repository, '.git', 'HEAD')))) {
        await rm(repository, { recursive: true, force: true });
        const repo = !this.config.repo.includes(':')
          ? resolve(ctx.projectRoot, this.config.repo)
          : this.config.repo;
        await git(
          [
            'clone',
            '--no-checkout',
            '--filter=blob:none',
            '--',
            repo,
            repository,
          ],
          ctx.projectRoot,
        );
      }
      const ref = this.config.ref ?? 'HEAD';
      await git(['fetch', '--depth=1', 'origin', ref], repository);
      if (this.config.sparse?.length) {
        await git(
          ['sparse-checkout', 'set', '--no-cone', '--', ...this.config.sparse],
          repository,
        );
      }
      await git(['checkout', '--force', '--detach', 'FETCH_HEAD'], repository);
      metadata = {
        repo: this.config.repo,
        ref,
        commit: await git(['rev-parse', 'HEAD'], repository),
      };
      await atomicWrite(join(cache, 'metadata.json'), JSON.stringify(metadata));
    }
    const target = join('.bao_sources', 'git', hash(this.id));
    await rm(target, { recursive: true, force: true });
    await cp(repository, target, {
      recursive: true,
      filter: (path) => basename(path) !== '.git',
    });
    ctx.dependencies[this.id] = JSON.stringify(metadata);
    return { source: { path: target }, dest: { path: this.config.dest } };
  }
}

export type NpmFlowConfig = {
  package: string;
  version?: string;
  files: string[];
  dest: string;
  registry?: string;
};
async function lockedVersion(
  root: string,
  name: string,
): Promise<{ version: string; integrity?: string } | undefined> {
  for (const file of ['npm-shrinkwrap.json', 'package-lock.json']) {
    const lock = await json(join(root, file));
    if (lock) {
      const entry =
        lock.packages?.[`node_modules/${name}`] ?? lock.dependencies?.[name];
      if (entry?.version)
        return { version: entry.version, integrity: entry.integrity };
    }
  }
  const path = join(root, 'bun.lock');
  if (await exists(path)) {
    const lock = Bun.JSON5.parse(await readFile(path, 'utf8')) as CacheRecord;
    const entry = lock.packages?.[name];
    if (
      Array.isArray(entry) &&
      typeof entry[0] === 'string' &&
      entry[0].startsWith(`${name}@`)
    ) {
      return { version: entry[0].slice(name.length + 1), integrity: entry[3] };
    }
  }
}
function verify(bytes: Uint8Array, integrity: string): void {
  const supported = integrity
    .split(/\s+/)
    .map((value) => /^(sha(?:512|384|256|1))-(.+)$/.exec(value))
    .filter((value) => value !== null);
  if (
    !supported.length ||
    !supported.some(
      (match) =>
        createHash(match![1]!).update(bytes).digest('base64') === match![2],
    )
  )
    throw new Error('NpmFlow package integrity mismatch');
}
/** Resolve npm assets without installing dependencies or running package scripts. Requires Bun 1.4+. */
export class NpmFlow implements Flow {
  readonly id: string;
  constructor(private config: NpmFlowConfig) {
    if (
      !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(config.package) ||
      !config.files.length
    )
      throw new Error('NpmFlow requires a package name and files');
    for (const file of config.files) safeName(file);
    this.id = `NpmFlow:${hash(JSON.stringify(config))}`;
  }
  async execute(input?: FlowContext): Promise<FlowOutput> {
    const ctx = context(input);
    const range = this.config.version ?? 'latest';
    const lock = await lockedVersion(ctx.projectRoot, this.config.package);
    if (
      lock &&
      /^[v\d^~*<>=]/.test(range) &&
      !Bun.semver.satisfies(lock.version, range)
    )
      throw new Error(
        `Locked ${this.config.package}@${lock.version} does not satisfy ${range}`,
      );
    const registry = this.config.registry ?? 'https://registry.npmjs.org';
    const packageCache = join(
      ctx.cachePath,
      'npm',
      hash(`${registry}/${this.config.package}`),
    );
    let version = lock?.version;
    let metadata: CacheRecord | undefined;
    // Exact pins and lockfile versions need no registry request when cached.
    if (!version && /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(range)) version = range;
    let cached = version
      ? await json(join(packageCache, version, 'metadata.json'))
      : undefined;
    if (
      !cached ||
      !(await exists(join(packageCache, version!, 'package.tgz')))
    ) {
      metadata = (await (
        await checkedFetch(
          `${registry.replace(/\/$/, '')}/${encodeURIComponent(this.config.package)}`,
        )
      ).json()) as CacheRecord;
      version ??=
        metadata['dist-tags']?.[range] ??
        Object.keys(metadata.versions ?? {})
          .filter((v) => Bun.semver.satisfies(v, range))
          .sort(Bun.semver.order)
          .at(-1);
      if (!version || !metadata.versions?.[version])
        throw new Error(`Cannot resolve ${this.config.package}@${range}`);
      cached = await json(join(packageCache, version, 'metadata.json'));
      if (
        !cached ||
        !(await exists(join(packageCache, version, 'package.tgz')))
      ) {
        const dist = metadata.versions[version].dist;
        const bytes = new Uint8Array(
          await (await checkedFetch(dist.tarball)).arrayBuffer(),
        );
        const integrity =
          lock?.integrity ??
          dist.integrity ??
          (dist.shasum
            ? `sha1-${Buffer.from(dist.shasum, 'hex').toString('base64')}`
            : undefined);
        if (!integrity)
          throw new Error('NpmFlow registry returned no package integrity');
        verify(bytes, integrity);
        await atomicWrite(join(packageCache, version, 'package.tgz'), bytes);
        cached = { package: this.config.package, version, integrity };
        await atomicWrite(
          join(packageCache, version, 'metadata.json'),
          JSON.stringify(cached),
        );
      }
    }
    const bytes = await Bun.file(
      join(packageCache, version!, 'package.tgz'),
    ).bytes();
    verify(bytes, lock?.integrity ?? cached!.integrity);
    const entries = await new Bun.Archive(bytes).files();
    const target = join('.bao_sources', 'npm', hash(this.id));
    await rm(target, { recursive: true, force: true });
    const matches = new Set<string>();
    for (const [entry, file] of entries) {
      if (!entry.startsWith('package/')) continue;
      const path = safeName(entry.slice('package/'.length));
      if (
        !this.config.files.some((pattern) => new Bun.Glob(pattern).match(path))
      )
        continue;
      await atomicWrite(
        join(target, path),
        new Uint8Array(await file.arrayBuffer()),
      );
      matches.add(path);
    }
    for (const pattern of this.config.files)
      if (![...matches].some((path) => new Bun.Glob(pattern).match(path)))
        throw new Error(`NpmFlow pattern matched no files: ${pattern}`);
    ctx.dependencies[this.id] = JSON.stringify(cached);
    // Paired destinations retain package subdirectories and avoid basename collisions.
    const files = [...matches].sort();
    return {
      source: { path: files.map((file) => join(target, file)) },
      dest: { path: files.map((file) => join(this.config.dest, file)) },
    };
  }
}
