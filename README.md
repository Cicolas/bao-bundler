# Bao Bundler

Bao Bundler is a simple, code-driven, and manifest-aware asset bundler for web projects, built with Bun. It provides a flexible way to define and manage asset processing pipelines by combining `Flows` (which define *what* to bundle) and `Runners` (which define *how* to process them).

You can define your build process imperatively in code or declaratively in a `bao.manifest.json` file, which allows for a clean separation between your build configuration and the execution script.

## Core Concepts

*   **Project**: The main class that orchestrates the entire build process. You configure your asset pipeline here.
*   **Flow**: Defines the source of the assets. It specifies which files or folders should be processed.
    *   `FolderFlow`: Process files within a specific folder. Can recursively expand to list all files.
    *   `FileFlow`: Process a single file.
    *   `VoidFlow`: A flow for runners that operate on a file but don't produce an output that needs copying.
*   **Runner**: Defines the action to be performed on the assets provided by a Flow.
    *   `CopyRunner`: Copies files from the source to the destination.
*   **Manifest (`bao.manifest.json`)**: A JSON file that declaratively defines your project's name, dependencies, and build steps. This allows you to load and run a build with minimal code.

## Installation

```bash
bun add bao-bundler
```

## Usage

Bao Bundler can be used in two ways: declaratively via a `bao.manifest.json` file, or imperatively through code. The recommended approach is a hybrid model that attempts to load a manifest and falls back to a programmatic definition if the manifest is not found. This provides both flexibility and clear configuration.

### `bao.manifest.json`

Here’s an example of a `bao.manifest.json` file. It defines the project name, build steps, and temporary directory.

```json
// bao.manifest.json
{
  "name": "bao",
  "dependencies": {},
  "flows": {},
  "steps": [
    {
      "runner": {
        "className": "CopyRunner"
      },
      "flow": {
        "className": "FolderFlow",
        "config": {
          "source": "assets/images",
          "dest": "build/images"
        }
      }
    },
    {
      "runner": {
        "className": "CopyRunner"
      },
      "flow": {
        "className": "FolderFlow",
        "config": {
          "source": "assets/fonts",
          "dest": "build/fonts",
          "expand": true
        }
      }
    },
    {
      "runner": {
        "className": "CopyRunner"
      },
      "flow": {
        "className": "FileFlow",
        "config": {
          "source": "assets/favicon.ico",
          "dest": "build/favicon.ico"
        }
      }
    }
  ],
  "tmpPath": "./.bao_tmp"
}
```

*Note: The `expand: true` option in the `fonts` flow will process each file inside the folder individually.*

### Build Script (`example.ts`)

The build script orchestrates the process. It first tries to load the project from `bao.manifest.json`. If the file doesn't exist, it creates a new project programmatically with default settings. After the build, it saves the configuration back to the manifest file, making subsequent builds manifest-driven.

```typescript
// example.ts
import { Project, CopyRunner, FolderFlow, FileFlow } from 'bao-bundler';

let project!: Project;

try {
  // Attempt to load the project from the manifest
  project = await Project.loadFromManifest({
    runners: [CopyRunner],
    flows: [FolderFlow, FileFlow],
  });
} catch (err) {
  // If the manifest is not found, create a new project programmatically
  if (err instanceof Error && err.message === 'manifestFileNotfound') {
    console.log('No existing manifest, creating new project.');
    project = new Project('bao', {
      tmpPath: './.bao_tmp',
      steps: [
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
      ],
    });
  } else {
    // Re-throw other errors
    throw err;
  }
}

// Run the build process
await project.build();

// Save the final configuration to bao.manifest.json
project.saveToManifest();

console.log('Build complete!');
```

### Running the Build

To execute the build script, run:

```bash
bun run example.ts
```

## How It Works

The `project.build()` method follows a specific lifecycle:
1.  Deletes the temporary directory (`.bao_tmp` by default) to ensure a clean build.
2.  Recreates the temp directory and copies the entire `assets` folder into it.
3.  Changes the current working directory to the temp directory.
4.  Executes each `step` in order:
    a. The `flow` is executed to determine the source file(s) and destination path.
    b. The `runner` is executed with the source and destination from the flow.
5.  Copies the contents of the `build` folder from the temp directory to your project's main `build` folder.
6.  Changes the working directory back to the project root.

## API Reference

### `new Project(name, config)`

Creates a new project instance.

*   `name`: `string` - The name of your project.
*   `config`: `object` - An optional configuration object.
    *   `tmpPath`: `string` - Path to the temporary build directory.
    *   `steps`: `{ runner: Runner; flow: Flow }[]` - An array of step objects.

### `Project.loadFromManifest(config)`

A static method to load a project from a `bao.manifest.json` file in the current directory.

*   `config`: `object`
    *   `runners`: `Constructor[]` - An array of Runner classes (e.g., `[CopyRunner]`) used in the manifest.
    *   `flows`: `Constructor[]` - An array of Flow classes (e.g., `[FolderFlow, FileFlow]`) used in the manifest.

### `project.build()`

Asynchronously runs the entire build process.

### `project.saveToManifest()`

Asynchronously saves the current project configuration to `bao.manifest.json`.

---

### Flows

#### `new FolderFlow(config)`

Defines a flow for a folder.

*   `config`: `object`
    *   `source`: `string` - The source folder path (e.g., `assets/images`).
    *   `dest`: `string` - The destination path (e.g., `build/images`).
    *   `expand`: `boolean` (optional) - If `true`, the flow will output a list of all individual files within the `source` folder.

#### `new FileFlow(config)`

Defines a flow for a single file.

*   `config`: `object`
    *   `source`: `string` - The source file path (e.g., `assets/favicon.ico`).
    *   `dest`: `string` - The destination file path (e.g., `build/favicon.ico`).

#### `new VoidFlow(filePath)`

A flow that provides a file path but no destination.

*   `filePath`: `string` - The path to the file.

---

### Runners

#### `new CopyRunner()`

A runner that copies files or directories from a source to a destination. It intelligently handles single files, arrays of files, and entire directories.
