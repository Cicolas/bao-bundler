# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun install          # Install dependencies
bun run build        # Compile TypeScript (tsc → dist/)
bun run example/example.ts  # Run the example build script
```

There are no lint or test scripts configured.

## Architecture

Bao Bundler is a code-driven asset bundler built with Bun. All core logic lives in `index.ts` (~260 lines); the compiled output goes to `dist/`.

**Core abstractions (all in `index.ts`):**

- **`Project`** — orchestrator. Takes a name and an array of `{ runner, flow }` steps. `project.build()` runs them sequentially: writes to `.bao_tmp/`, then moves artifacts to the output directory. Tracks state in `bao.manifest.json`.
- **`Flow`** — defines *what* to process. Interface with `execute()` returning `{ source, dest }`. Built-ins: `FolderFlow` (uses Bun shell `find`) and `FileFlow`.
- **`Runner`** — defines *how* to process files. Interface with `run(source, dest)`. Built-in: `CopyRunner` (Node.js `cp` recursive).

**Build flow:** `Project.build()` → for each step, `flow.execute()` yields paths → `runner.run()` processes them → artifacts land in `.bao_tmp/` → final move to output dir → manifest saved.

**Extending:** Implement the `Flow` or `Runner` interfaces to add custom processing (e.g., SASS compilation, minification). Both interfaces are exported.

## Code Style

Prettier config (`.prettierrc`): single quotes, trailing commas, 2-space indentation.
