# Remote and glob sources

Import these flows from `bao-bundler/flows`. They work with the standard runners.
Remote sources require Bun 1.4 or later; GitFlow also requires Git on PATH.

```ts
new FetchFlow({
  url: 'https://cdn.example.com/lib.js',
  dest: 'build/vendor/lib.js',
});
new FetchFlow({
  urls: [
    'https://cdn.example.com/reset.css',
    'https://cdn.example.com/grid.css',
  ],
  dest: 'build/vendor/',
});
new GitFlow({
  repo: 'https://github.com/org/lib.git',
  ref: 'v2.1.0',
  sparse: ['dist/'],
  dest: 'build/vendor/lib',
});
new GlobFlow({
  pattern: ['assets/**/*.{ts,tsx}', '!**/*.test.ts'],
  dest: 'build/',
});
new NpmFlow({
  package: 'htmx.org',
  version: '^1.9.0',
  files: ['dist/htmx.min.js'],
  dest: 'build/vendor/',
});
```

Project builds stage downloaded sources under `.bao_sources` inside the temporary
build directory. Persistent content and metadata live in the project root's
`.bao_cache`, so cleaning the temporary build directory does not discard cached
inputs. Dependency entries in `bao.manifest.json` record HTTP validators, Git
commits and npm versions. Delete `.bao_cache` to force a complete download.
Standalone `execute()` calls use the current directory as the project root;
custom callers may provide the exported `FlowContext` to choose a cache location.

FetchFlow rejects non-success HTTP responses and revalidates cached resources
using ETag and Last-Modified. Multiple URLs must have distinct decoded filenames.
A single URL has a single source path; `urls` produces an array for directory
copying. The cache is revalidated even when the same flow instance is reused.

GitFlow caches each repository/ref/sparse configuration at its resolved commit.
Repeated executions of that configuration use the local checkout without network
access. Set `refresh: true` to fetch a moving branch/tag again. Changing `ref`
selects a new cache entry. Sparse paths use Git's non-cone patterns; `.git` is
excluded from the staged source. Relative repository paths resolve from the
project root. Sparse checkouts use `--filter=blob:none`; servers must support
partial clone for download savings.

GlobFlow uses Bun.Glob, including `**` and brace alternates. Supply an array of
patterns to add exclusions beginning with `!`; exclusions apply to all inclusions.
Matches are sorted and deduplicated. `cwd` selects the scan root and `dot: true`
includes hidden files. Directory entries and followed symlinks are excluded.

NpmFlow resolves semver ranges or dist-tags from the public npm registry. Use
`registry` to override the registry URL. It respects root package versions in
`npm-shrinkwrap.json`, `package-lock.json`, and text `bun.lock`, in that order,
and throws when the locked version conflicts with the requested semver range.
Binary `bun.lockb`, Yarn and pnpm lockfiles are not read. Exact pins and locked
versions work offline once cached. Unlocked ranges/tags recheck registry metadata
on each execution but only download the package tarball when the version changes.
Tarball integrity is verified before extracting files. `files` accepts glob
patterns relative to the package root, and each must match at least one file.
Only selected files are written, retaining their package-relative paths at the
destination (paired source/destination arrays). Package lifecycle scripts and
transitive dependency installation are never run. Private registry credentials
and .npmrc settings are not automatically loaded.
