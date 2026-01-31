![Bao Bundler Logo](logo.png)

# Bao Bundler

Bao Bundler is a simple, code-driven asset bundler for web projects, built with Bun. It provides a flexible way to define and manage asset processing pipelines by combining `Flows` (which define *what* to bundle) and `Runners` (which define *how* to process them).

You define your build process imperatively in code, which allows for maximum flexibility and control.

## Core Concepts

*   **Project**: The main class that orchestrates the entire build process.
*   **Flow**: Defines the source of the assets (what files or folders to process).
    *   `FolderFlow`: Process files within a folder.
    *   `FileFlow`: Process a single file.
*   **Runner**: Defines the action to be performed on the assets.
    *   `CopyRunner`: Copies files from source to destination.

## Installation

```bash
bun add bao-bundler
```

## Usage

Bao Bundler is used by defining your build steps in a script and executing it with Bun. This code-driven approach gives you full control over the build process.

### Build Script (`build.ts`)

Here’s an example of a build script. It creates a new project and defines a series of steps to copy assets from an `assets` directory to a `build` directory.

```typescript
// build.ts
import { Project, CopyRunner, FolderFlow, FileFlow } from 'bao-bundler';

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

To execute the build script, run:
```bash
bun run build.ts
```

## Extending Bao Bundler

You can create custom `Flows` and `Runners` to extend Bao's functionality.

### Creating a Custom Flow

A `Flow` must have an async `get()` method that returns the source and destination paths. Here is a conceptual example of a `GlobFlow`.

```typescript
// flows/GlobFlow.ts
import { type Flow, type FlowOutput } from 'bao-bundler'; // Types are conceptual
import { glob } from 'glob';

export class GlobFlow implements Flow {
  constructor(private config: { pattern: string; dest: string }) {}

  async get(): Promise<FlowOutput> {
    const files = await glob(this.config.pattern);
    return {
      source: files,
      dest: this.config.dest,
    };
  }
}
```

### Creating a Custom Runner

A `Runner` must have an async `run()` method. Here is a conceptual example of a `SassRunner`.

```typescript
// runners/SassRunner.ts
import { type Runner } from 'bao-bundler'; // Type is conceptual
import sass from 'sass';

export class SassRunner implements Runner {
  async run(source: string, dest: string): Promise<void> {
    const result = sass.compile(source);
    await Bun.write(dest, result.css);
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

Creates a new project instance.

*   `name`: `string` - The name of your project.
*   `steps`: `{ runner: Runner; flow: Flow }[]` - An array of step objects that define the build process.

### `project.build()`

Asynchronously runs the entire build process.

---

### Flows

#### `new FolderFlow(config)`
*   `config`: `{ source: string; dest: string; expand?: boolean }`

#### `new FileFlow(config)`
*   `config`: `{ source: string; dest: string }`

---

### Runners

#### `new CopyRunner()`
Copies files or directories from a source to a destination.