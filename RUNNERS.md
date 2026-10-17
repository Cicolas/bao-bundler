# Built-in runners

Import runners from `bao-bundler/runners`. All implement `Runner`; the new transformations reject on errors so failed transformations fail the build.

For the new file processors, a string source and string destination denote one input/output file. An array source and string destination denote files copied/transformed into that directory using their basenames. To retain subdirectories or avoid duplicate basenames, supply matching source/destination arrays. Transform runners expect files: use `FolderFlow({ expand: true, ... })` to expand folders. Empty source arrays are a no-op. CopyRunner retains its existing behavior and also supports directories.

| Runner | Configuration | Dependencies |
| --- | --- | --- |
| `BundleRunner` | Bun build options, e.g. `{ target: 'browser', splitting: true, minify: true }` | Bun |
| `MinifyRunner` | `{ format?: 'js' \| 'css' \| 'html', html?: {...} }` | Bun; `html-minifier-terser` for HTML |
| `SassRunner` | `{ style?: 'expanded' \| 'compressed', loadPaths?: string[], sourceMap?: boolean }` | `sass` |
| `ExecRunner` | `{ command: string[] \| ((source, dest?) => string[]), cwd?, env? }` | Executable supplied by caller |
| `ImageRunner` | `{ width?, height?, fit?, withoutEnlargement?, format?, quality? }` | `sharp` |
| `HashRunner` | `{ algorithm?: string, length?: number, manifestPath?: string }` | None |
| `TemplateRunner` | `{ engine?: 'handlebars' \| 'ejs' \| 'mustache', data?: object \| async function }` | Selected template engine |
| `TypeCheckRunner` | `{ project?, command?: string[], cwd?, args?: string[] }` | Locally installed `typescript` |

Install only integrations you use, for example `bun add sass sharp handlebars html-minifier-terser`. They are loaded lazily and missing packages produce installation instructions. EJS and Mustache are also supported with `bun add ejs` or `bun add mustache`.

BundleRunner uses flow source paths as entrypoints and requires one destination **directory**, including for a single FileFlow source. Bun determines bundle filenames through its `naming` option. Build failures include Bun's diagnostics in the thrown AggregateError.

MinifyRunner infers JS/TS/JSX, CSS, or HTML from the source extension. JS and CSS use Bun's parser, HTML uses html-minifier-terser. JS/TS is transformed without bundling; target/output file extensions remain the caller's responsibility. CSS that emits additional assets is rejected; use BundleRunner to preserve those assets. HTML options are passed to the minifier and default to collapsing whitespace and removing comments.

SassRunner changes `.scss`/`.sass` destination suffixes to `.css` (other destination extensions remain unchanged). With `sourceMap: true`, it writes a sibling `.map` file; callers can add sourceMappingURL annotations if desired. Compilation diagnostics propagate unchanged.

ExecRunner runs one command per source, with optional destination, through argv without implicit shell parsing. `{source}` and `{dest}` placeholders are substituted within each argument; a destination placeholder requires a destination. Use a function for more complex argument construction. Invoke a shell explicitly if needed, e.g. `['sh', '-c', 'tool "$1" > "$2"', 'bao', '{source}', '{dest}']`. Commands inherit standard IO and environment; nonzero exits, signals, and spawn errors fail the build.

ImageRunner auto-rotates using image metadata, optionally resizes (without enlargement by default), and writes JPEG/PNG/WebP/AVIF. Format defaults to the destination suffix; an explicit `format` overrides it. Set matching output filename extensions when converting formats. Metadata is stripped by sharp's defaults.

HashRunner copies files to `name.<sha256-prefix>.ext` (12 hex characters by default), and exposes `runner.manifest` mapping requested destination paths to actual hashed paths. Set `manifestPath` to write the same map as JSON for templates or consumers. Each successful invocation replaces the map, including for an empty source list. It leaves source files intact. Old outputs are cleaned by Project's fresh build directory.

TemplateRunner defaults to Handlebars and passes `data` to the selected engine. A data function receives the source path and can return a promise. EJS receives an absolute filename for relative includes and supports asynchronous rendering. Templates are trusted build inputs: EJS executes JavaScript.

TypeCheckRunner runs once per flow invocation and ignores flow paths. It defaults to `bun x --no-install tsc --noEmit`, so install TypeScript locally (`bun add -d typescript`). `project` selects a tsconfig; `command` can supply an explicit compiler argv, e.g. `['/project/node_modules/.bin/tsc']`. `args` are appended before the mandatory `--noEmit`. Relative paths resolve against the build's current temporary directory unless `cwd` is supplied.

```ts
import { FileFlow, FolderFlow, VoidFlow } from 'bao-bundler/flows';
import { BundleRunner, SassRunner, ExecRunner, TypeCheckRunner } from 'bao-bundler/runners';

const steps = [
  { flow: new FileFlow({ source: 'assets/app.ts', dest: 'build/js' }), runner: new BundleRunner({ minify: true }) },
  { flow: new FolderFlow({ source: 'assets/scss', dest: 'build/css', expand: true, extension: 'scss' }), runner: new SassRunner({ style: 'compressed' }) },
  { flow: new FileFlow({ source: 'assets/input.txt', dest: 'build/output.txt' }), runner: new ExecRunner({ command: ['cp', '{source}', '{dest}'] }) },
  { flow: new VoidFlow({ filePath: 'tsconfig.json' }), runner: new TypeCheckRunner({ cwd: '/absolute/project/root' }) },
];
```
