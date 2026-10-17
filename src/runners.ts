/** Built-in file processors. Optional integrations load only when used. */
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Logger } from './_logger';
import type { Runner, FlowOutput } from './index';

export type { Runner };

type FilePair = { source: string; dest: string };

function sources(input: FlowOutput): string[] {
  if (!input.source) throw new Error('Runner requires a source.');
  const files = Array.isArray(input.source.path) ? input.source.path : [input.source.path];
  if (files.some((file) => !file)) throw new Error('Runner source paths must not be empty.');
  return files;
}

/** A string source maps to a file; an array source maps into a destination directory. */
function pairs(input: FlowOutput): FilePair[] {
  const files = sources(input);
  if (!input.dest) throw new Error('Runner requires a destination.');
  const dest = input.dest.path;
  if (Array.isArray(dest) && dest.length !== files.length) {
    throw new Error('Source and destination counts must match.');
  }
  if (typeof dest === 'string' && !dest) throw new Error('Runner destination must not be empty.');
  const result = files.map((source, i) => ({
    source,
    dest: Array.isArray(dest) ? dest[i]! : Array.isArray(input.source!.path) ? path.join(dest, path.basename(source)) : dest,
  }));
  if (result.some((file) => !file.dest)) throw new Error('Runner destination paths must not be empty.');
  if (new Set(result.map((file) => path.resolve(file.dest))).size !== result.length) {
    throw new Error('Multiple sources map to the same destination. Use explicit destination paths.');
  }
  return result;
}

async function output(file: string, data: string | Uint8Array): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, data);
}

async function optionalModule(name: string): Promise<any> {
  try {
    return await import(name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND' || (error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') {
      throw new Error(`Optional runner dependency "${name}" is unavailable. Install it with: bun add ${name}`, { cause: error });
    }
    throw error;
  }
}

export class CopyRunner implements Runner {
  async run(input: FlowOutput): Promise<void> {
    if (!input.source || !input.dest) {
      Logger.error('No source or destination provided to CopyRunner.');
      return;
    }

    const source = input.source.path;
    const dest = input.dest.path;

    if (Array.isArray(source) && Array.isArray(dest)) {
      for (let i = 0; i < source.length; i++) {
        Logger.debug(`Copying from ${source[i]} to ${dest[i]}`);
        await cp(source[i]!, dest[i]!, { recursive: true });
      }
      return;
    }

    if (Array.isArray(source) && typeof dest === 'string') {
      for (const src of source) {
        const baseName = path.basename(src);
        const destPath = path.join(dest, baseName);
        Logger.debug(`Copying from ${src} to ${destPath}`);
        await cp(src, destPath, { recursive: true });
      }
      return;
    }

    if (typeof source === 'string' && Array.isArray(dest)) {
      Logger.warn(
        'Warning: Source is a single string but destination is an array. Using the first element of destination.',
      );
      const destPath = dest[0]!;
      Logger.debug(`Copying from ${source} to ${destPath}`);
      await cp(source, destPath, { recursive: true });
      return;
    }

    Logger.debug(`Copying from ${source} to ${dest}`);
    await cp(source as string, dest as string, { recursive: true });
  }
}

export type BundleRunnerOptions = Omit<Bun.BuildConfig, 'entrypoints' | 'outdir'>;

/** Bundle flow entrypoints into its destination directory using Bun. */
export class BundleRunner implements Runner {
  constructor(private options: BundleRunnerOptions = {}) {}
  async run(input: FlowOutput): Promise<void> {
    const entrypoints = sources(input);
    if (entrypoints.length === 0) return;
    if (!input.dest || typeof input.dest.path !== 'string' || !input.dest.path) {
      throw new Error('BundleRunner requires one destination directory.');
    }
    const result = await Bun.build({ ...this.options, entrypoints, outdir: input.dest.path });
    if (!result.success) throw new AggregateError(result.logs, 'BundleRunner failed.');
  }
}

export type MinifyRunnerOptions = {
  /** Defaults to inferring JS/TS, CSS, or HTML from the source extension. */
  format?: 'js' | 'css' | 'html';
  html?: Record<string, unknown>;
};

export class MinifyRunner implements Runner {
  constructor(private options: MinifyRunnerOptions = {}) {}
  async run(input: FlowOutput): Promise<void> {
    for (const file of pairs(input)) {
      const extension = path.extname(file.source).slice(1).toLowerCase();
      const format = this.options.format ?? (extension === 'css' ? 'css' : ['html', 'htm'].includes(extension) ? 'html' : ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs'].includes(extension) ? 'js' : undefined);
      if (!format) throw new Error(`MinifyRunner does not support .${extension}.`);
      if (format === 'css') {
        const result = await Bun.build({ entrypoints: [file.source], minify: true });
        if (!result.success) throw new AggregateError(result.logs, 'CSS minification failed.');
        const css = result.outputs.find((asset) => asset.path.endsWith('.css'));
        if (!css || result.outputs.some((asset) => asset !== css)) {
          throw new Error('CSS minification produced additional assets. Use BundleRunner for CSS with asset imports.');
        }
        await output(file.dest, await css.text());
      } else if (format === 'html') {
        const { minify } = await optionalModule('html-minifier-terser');
        await output(file.dest, await minify(await readFile(file.source, 'utf8'), { collapseWhitespace: true, removeComments: true, ...this.options.html }));
      } else {
        const loader = ['jsx', 'ts', 'tsx'].includes(extension) ? extension as 'jsx' | 'ts' | 'tsx' : 'js';
        const transpiler = new Bun.Transpiler({ loader, minifyWhitespace: true });
        await output(file.dest, await transpiler.transform(await readFile(file.source, 'utf8')));
      }
    }
  }
}

export class SassRunner implements Runner {
  constructor(private options: { style?: 'expanded' | 'compressed'; loadPaths?: string[]; sourceMap?: boolean } = {}) {}
  async run(input: FlowOutput): Promise<void> {
    const files = pairs(input);
    if (!files.length) return;
    const sass = await optionalModule('sass');
    for (const file of files) {
      const result = await sass.compileAsync(file.source, this.options);
      const dest = file.dest.replace(/\.(scss|sass)$/i, '.css');
      await output(dest, result.css);
      if (this.options.sourceMap && result.sourceMap) await output(`${dest}.map`, JSON.stringify(result.sourceMap));
    }
  }
}

export type ExecRunnerOptions = {
  /** Each argv element substitutes {source} and {dest}; no shell is used. */
  command: string[] | ((source: string, dest?: string) => string[]);
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

async function execute(command: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv }): Promise<void> {
  if (!command.length || !command[0]) throw new Error('Command must not be empty.');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command[0]!, command.slice(1), { cwd: options.cwd, env: { ...process.env, ...options.env }, stdio: 'inherit', shell: false });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`Command ${command[0]} failed (${signal ?? code}).`)));
  });
}

export class ExecRunner implements Runner {
  constructor(private options: ExecRunnerOptions) {}
  async run(input: FlowOutput): Promise<void> {
    const files = input.dest ? pairs(input) : sources(input).map((source) => ({ source, dest: undefined }));
    for (const file of files) {
      if (file.dest) await mkdir(path.dirname(file.dest), { recursive: true });
      const command = typeof this.options.command === 'function' ? this.options.command(file.source, file.dest) : this.options.command.map((arg) => arg.replace(/\{source\}|\{dest\}/g, (token) => {
        if (token === '{dest}' && !file.dest) throw new Error('Command uses {dest} but the flow has no destination.');
        return token === '{source}' ? file.source : file.dest!;
      }));
      await execute(command, this.options);
    }
  }
}

export type ImageRunnerOptions = {
  width?: number;
  height?: number;
  fit?: 'cover' | 'contain' | 'fill' | 'inside' | 'outside';
  withoutEnlargement?: boolean;
  format?: 'jpeg' | 'png' | 'webp' | 'avif';
  quality?: number;
};

export class ImageRunner implements Runner {
  constructor(private options: ImageRunnerOptions = {}) {}
  async run(input: FlowOutput): Promise<void> {
    const files = pairs(input);
    if (!files.length) return;
    const module = await optionalModule('sharp');
    const sharp = module.default ?? module;
    for (const file of files) {
      let image = sharp(file.source).rotate();
      if (this.options.width || this.options.height) image = image.resize({ width: this.options.width, height: this.options.height, fit: this.options.fit, withoutEnlargement: this.options.withoutEnlargement ?? true });
      const format = this.options.format ?? path.extname(file.dest).slice(1).toLowerCase().replace('jpg', 'jpeg');
      if (!['jpeg', 'png', 'webp', 'avif'].includes(format)) throw new Error(`Unsupported image output format: ${format}`);
      image = image.toFormat(format, { quality: this.options.quality });
      await output(file.dest, await image.toBuffer());
    }
  }
}

export type HashRunnerOptions = { algorithm?: string; length?: number; manifestPath?: string };

export class HashRunner implements Runner {
  /** Maps requested destination filenames to their hashed output filenames. */
  readonly manifest: Record<string, string> = {};
  constructor(private options: HashRunnerOptions = {}) {
    if (!Number.isInteger(options.length ?? 12) || (options.length ?? 12) < 1) throw new Error('Hash length must be a positive integer.');
  }
  async run(input: FlowOutput): Promise<void> {
    const next: Record<string, string> = {};
    for (const file of pairs(input)) {
      const contents = await readFile(file.source);
      const digest = createHash(this.options.algorithm ?? 'sha256').update(contents).digest('hex');
      if ((this.options.length ?? 12) > digest.length) throw new Error('Hash length exceeds the digest length.');
      const parsed = path.parse(file.dest);
      const dest = path.join(parsed.dir, `${parsed.name}.${digest.slice(0, this.options.length ?? 12)}${parsed.ext}`);
      await output(dest, contents);
      next[file.dest] = dest;
    }
    // Publish the map only when every source was processed successfully.
    if (this.options.manifestPath) await output(this.options.manifestPath, JSON.stringify(next, null, 2));
    for (const key of Object.keys(this.manifest)) delete this.manifest[key];
    Object.assign(this.manifest, next);
  }
}

export type TemplateRunnerOptions = {
  engine?: 'handlebars' | 'ejs' | 'mustache';
  data?: Record<string, unknown> | ((source: string) => Record<string, unknown> | Promise<Record<string, unknown>>);
};

export class TemplateRunner implements Runner {
  constructor(private options: TemplateRunnerOptions = {}) {}
  async run(input: FlowOutput): Promise<void> {
    const files = pairs(input);
    if (!files.length) return;
    const engine = this.options.engine ?? 'handlebars';
    const module = await optionalModule(engine);
    const api = module.default ?? module;
    for (const file of files) {
      const template = await readFile(file.source, 'utf8');
      const data = typeof this.options.data === 'function' ? await this.options.data(file.source) : this.options.data ?? {};
      const rendered = engine === 'handlebars' ? api.compile(template)(data) : engine === 'ejs' ? await api.render(template, data, { filename: path.resolve(file.source), async: true }) : api.render(template, data);
      await output(file.dest, rendered);
    }
  }
}

export type TypeCheckRunnerOptions = { project?: string; command?: string[]; cwd?: string; args?: string[] };

export class TypeCheckRunner implements Runner {
  constructor(private options: TypeCheckRunnerOptions = {}) {}
  async run(_input: FlowOutput): Promise<void> {
    const command = this.options.command ?? [process.execPath, 'x', '--no-install', 'tsc'];
    await execute([...command, ...(this.options.project ? ['--project', this.options.project] : []), ...(this.options.args ?? []), '--noEmit'], this.options);
  }
}
