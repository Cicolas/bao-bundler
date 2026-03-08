# Bao Bundler
<p align="center">
   <img src="logo.png" alt="Descrição" width="300">
</p>

Bao Bundler is a simple, code-driven asset bundler for web projects, built with Bun. It provides a flexible way to define and manage asset processing pipelines by combining `Flows` (which define *what* to bundle) and `Runners` (which define *how* to process them).

You define your build process imperatively in code, which allows for maximum flexibility and control.

## Core Concepts

*   **Project**: The main class that orchestrates the entire build process.
*   **Flow**: Defines the source of the assets (what files or folders to process).
    *   `FolderFlow`: Process files within a folder.
    *   `FileFlow`: Process a single file.
    *   `VoidFlow`: Process a file without producing output.
*   **Runner**: Defines the action to be performed on the assets.
    *   `CopyRunner`: Copies files from source to destination.

## Installation

```bash
bun add bao-bundler
```

## Usage

Bao Bundler is used by defining your build steps in a script and executing it with Bun. This code-driven approach gives you full control over the build process.

### Build Script (`build.ts`)

```typescript
import { Project } from 'bao-bundler';
import { FolderFlow, FileFlow } from 'bao-bundler/flows';
import { CopyRunner } from 'bao-bundler/runners';

await new Project('bao', [
  {
    runner: new CopyRunner(),
    flow: new FolderFlow({
      source: 'assets/images',
      dest: 'build/images',
    }),
  },
  {
    runner: new CopyRunner(),
    flow: new FolderFlow({
      source: 'assets/fonts',
      dest: 'build/fonts',
      expand: true,
    }),
  },
  {
    runner: new CopyRunner(),
    flow: new FileFlow({
      source: 'assets/favicon.ico',
      dest: 'build/favicon.ico',
    }),
  },
]).build();

console.log('Build complete!');
```

### Running the Build

```bash
bun run build.ts
```

## Verbosity

Control log output via the `BAO_VERBOSITY` environment variable:

```bash
BAO_VERBOSITY=DEBUG bun run build.ts  # default — all logs
BAO_VERBOSITY=INFO  bun run build.ts  # info, warn, error
BAO_VERBOSITY=WARN  bun run build.ts  # warn and error only
BAO_VERBOSITY=ERROR bun run build.ts  # errors only
```

## Extending Bao Bundler

You can create custom `Flows` and `Runners` by implementing the exported interfaces.

### Creating a Custom Flow

```typescript
import { type Flow } from 'bao-bundler';
import { glob } from 'glob';

export class GlobFlow implements Flow {
  id: string;
  constructor(private config: { pattern: string; dest: string }) {
    this.id = `GlobFlow:${config.pattern}`;
  }

  async execute() {
    const files = await glob(this.config.pattern);
    return {
      source: { path: files },
      dest: { path: this.config.dest },
    };
  }
}
```

### Creating a Custom Runner

```typescript
import { type Runner } from 'bao-bundler';
import sass from 'sass';

export class SassRunner implements Runner {
  async run(input) {
    const result = sass.compile(input.source.path as string);
    await Bun.write(input.dest.path as string, result.css);
  }
}
```

## How It Works

The `project.build()` method:
1.  Prepares a temporary directory for a clean, isolated build.
2.  Executes each `step` in order, letting the `flow` provide paths and the `runner` process the files.
3.  Moves the final artifacts from the temporary directory to your project's output directory.

## API Reference

### `new Project(name, steps)`

*   `name`: `string` - The name of your project.
*   `steps`: `{ runner: Runner; flow: Flow }[]` - An array of step objects that define the build process.

### `project.build()`

Asynchronously runs the entire build process.

---

### Flows — `bao-bundler/flows`

#### `new FolderFlow(config)`
*   `config`: `{ source: string; dest: string; expand?: boolean; extension?: string }`
*   When `expand` is true, resolves individual files instead of the folder path. Use `extension` to filter by file type.

#### `new FileFlow(config)`
*   `config`: `{ source: string; dest: string }`

#### `new VoidFlow(config)`
*   `config`: `{ filePath: string }`
*   Processes a file without writing it to the output.

---

### Runners — `bao-bundler/runners`

#### `new CopyRunner()`
Copies files or directories from source to destination.
