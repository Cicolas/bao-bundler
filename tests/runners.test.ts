import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BundleRunner, CopyRunner, ExecRunner, HashRunner, MinifyRunner, TypeCheckRunner } from '../src/runners';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'bao-runners-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
const flow = (source: string | string[], dest: string | string[]) => ({ source: { path: source }, dest: { path: dest } });
const file = (name: string) => path.join(dir, name);

describe('built-in runners', () => {
  test('copies nested destinations and rejects ambiguous transform file arrays', async () => {
    await writeFile(file('input.txt'), 'hello');
    await new CopyRunner().run(flow(file('input.txt'), file('deep/output.txt')));
    expect(await readFile(file('deep/output.txt'), 'utf8')).toBe('hello');
    await expect(new HashRunner().run(flow([file('input.txt')], []))).rejects.toThrow('counts must match');
    await expect(new HashRunner().run(flow([file('a/input.txt'), file('b/input.txt')], file('out')))).rejects.toThrow('same destination');
  });

  test('bundles imports and fails on unresolved imports', async () => {
    await writeFile(file('value.ts'), 'export const value: number = 42;');
    await writeFile(file('entry.ts'), 'import { value } from "./value"; console.log(value);');
    await new BundleRunner({ minify: true, target: 'bun' }).run(flow(file('entry.ts'), file('bundle')));
    expect(await readFile(file('bundle/entry.js'), 'utf8')).toContain('42');
    await writeFile(file('invalid.ts'), 'import "./missing";');
    await expect(new BundleRunner().run(flow(file('invalid.ts'), file('bundle')))).rejects.toThrow();
  });

  test('minifies JS while preserving strings and CSS syntax', async () => {
    await writeFile(file('input.js'), 'globalThis.answer = "https://example.com/a // not a comment"; // comment\n');
    await new MinifyRunner().run(flow(file('input.js'), file('out.js')));
    const result = await readFile(file('out.js'), 'utf8');
    expect(result).toContain('https://example.com/a // not a comment');
    expect(result).not.toContain('// comment');
    await writeFile(file('input.css'), '/* comment */ .example { color: rgb(255, 0, 0); margin: 0px; }');
    await new MinifyRunner().run(flow(file('input.css'), file('out.css')));
    const css = await readFile(file('out.css'), 'utf8');
    expect(css).toContain('.example');
    expect(css).not.toContain('/* comment */');
    await expect(new MinifyRunner().run(flow(file('input.txt'), file('out.txt')))).rejects.toThrow('does not support');
  });

  test('exec substitutes argv safely and propagates process failures', async () => {
    const source = file('input $(touch hacked);.txt');
    await writeFile(source, 'safe');
    await new ExecRunner({ command: [process.execPath, '-e', 'await Bun.write(process.argv[2], await Bun.file(process.argv[1]).text())', '{source}', '{dest}'] }).run(flow(source, file('nested/out.txt')));
    expect(await readFile(file('nested/out.txt'), 'utf8')).toBe('safe');
    await expect(new ExecRunner({ command: [process.execPath, '-e', 'process.exit(7)'] }).run({ source: { path: source } })).rejects.toThrow('failed (7)');
    await expect(new ExecRunner({ command: ['missing-bao-command-3127'] }).run({ source: { path: source } })).rejects.toThrow();
    await expect(new ExecRunner({ command: ['echo', '{dest}'] }).run({ source: { path: source } })).rejects.toThrow('no destination');
  });

  test('hashes contents deterministically and refreshes the manifest on rerun', async () => {
    await writeFile(file('input.css'), 'hello');
    const runner = new HashRunner({ manifestPath: file('manifest.json'), length: 8 });
    await runner.run(flow(file('input.css'), file('out/app.css')));
    expect(runner.manifest[file('out/app.css')]).toBe(file('out/app.2cf24dba.css'));
    expect(await readFile(file('out/app.2cf24dba.css'), 'utf8')).toBe('hello');
    expect(JSON.parse(await readFile(file('manifest.json'), 'utf8'))).toEqual(runner.manifest);
    await runner.run(flow([], file('out')));
    expect(runner.manifest).toEqual({});
    expect(() => new HashRunner({ length: 0 })).toThrow('positive integer');
    await expect(new HashRunner({ length: 100 }).run(flow(file('input.css'), file('out/app.css')))).rejects.toThrow('digest length');
  });

  test('type checker receives --noEmit and fails on errors', async () => {
    const script = file('check.ts');
    await writeFile(script, 'if (!process.argv.includes("--noEmit")) process.exit(8); if (process.argv.includes("--bad")) process.exit(2);');
    await new TypeCheckRunner({ command: [process.execPath, script] }).run({});
    await expect(new TypeCheckRunner({ command: [process.execPath, script], args: ['--bad'] }).run({})).rejects.toThrow('failed (2)');
  });
});

describe('optional runner integrations', () => {
  test('Sass compiles variables/imports and emits a source map', async () => {
    const { SassRunner } = await import('../src/runners');
    await mkdir(file('scss'));
    await writeFile(file('scss/_variables.scss'), '$color: #123456;');
    await writeFile(file('scss/app.scss'), '@use "variables" as *; .item { color: $color; }');
    await new SassRunner({ sourceMap: true, style: 'compressed' }).run(flow(file('scss/app.scss'), file('css/app.scss')));
    expect(await readFile(file('css/app.css'), 'utf8')).toContain('#123456');
    expect(JSON.parse(await readFile(file('css/app.css.map'), 'utf8')).sources.length).toBeGreaterThan(0);
    await writeFile(file('scss/bad.scss'), '.a { color: $undefined; }');
    await expect(new SassRunner().run(flow(file('scss/bad.scss'), file('css/bad.css')))).rejects.toThrow();
  });

  test('HTML minification respects preformatted content', async () => {
    await writeFile(file('input.html'), '<!-- comment --> <div> hello </div> <pre> a   b\n c </pre>');
    await new MinifyRunner().run(flow(file('input.html'), file('out.html')));
    const html = await readFile(file('out.html'), 'utf8');
    expect(html).not.toContain('<!-- comment -->');
    expect(html).toContain('<pre> a   b\n c </pre>');
  });

  test('all template engines render and escape user data', async () => {
    const { TemplateRunner } = await import('../src/runners');
    for (const engine of ['handlebars', 'ejs', 'mustache'] as const) {
      await writeFile(file(`${engine}.txt`), engine === 'ejs' ? '<p><%= title %></p>' : '<p>{{title}}</p>');
      await new TemplateRunner({ engine, data: async () => ({ title: '<hello>' }) }).run(flow(file(`${engine}.txt`), file(`${engine}.html`)));
      expect(await readFile(file(`${engine}.html`), 'utf8')).toBe('<p>&lt;hello&gt;</p>');
    }
  });

  test('ImageRunner resizes and converts actual images', async () => {
    const { ImageRunner } = await import('../src/runners');
    const packageName = 'sharp';
    const sharp = (await import(packageName)).default;
    await sharp({ create: { width: 20, height: 10, channels: 3, background: '#ff0000' } }).png().toFile(file('input.png'));
    await new ImageRunner({ width: 10, format: 'webp' }).run(flow(file('input.png'), file('image.webp')));
    const metadata = await sharp(file('image.webp')).metadata();
    expect(metadata.width).toBe(10);
    expect(metadata.height).toBe(5);
    expect(metadata.format).toBe('webp');
  });

  test('TypeCheckRunner runs the local compiler and detects type errors without emitting', async () => {
    await writeFile(file('tsconfig.json'), JSON.stringify({ compilerOptions: { types: [], strict: true, module: 'esnext', moduleResolution: 'bundler' }, files: ['input.ts'] }));
    await writeFile(file('input.ts'), 'const n: number = 1;');
    const runner = new TypeCheckRunner({ cwd: dir, command: [path.resolve('node_modules/.bin/tsc')], project: file('tsconfig.json') });
    await runner.run({});
    expect(await Bun.file(file('input.js')).exists()).toBe(false);
    await writeFile(file('input.ts'), 'const n: number = "invalid";');
    await expect(runner.run({})).rejects.toThrow('failed');
  });
});
