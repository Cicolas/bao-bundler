# Bao Bundler

Bao Bundler is a simple, code-driven asset bundler for web projects, built with Bun. It provides a flexible way to define and manage asset processing pipelines by combining `Flows` (which define *what* to bundle) and `Runners` (which define *how* to process them).

## Core Concepts

*   **Project**: The main class that orchestrates the entire build process. You configure your asset pipeline here.
*   **Flow**: Defines the source of the assets. It specifies which files or folders should be processed.
    *   `FolderFlow`: Process all files within a specific folder.
    *   `FileFlow`: Process a single file.
*   **Runner**: Defines the action to be performed on the assets provided by a Flow.
    *   `CopyRunner`: Copies files from the source to the destination.

## Installation

```bash
bun add bao-bundler
```

## Usage

Here is a basic example of how to use Bao Bundler to copy image assets and a favicon.

```typescript
// example.ts
import { Project, CopyRunner, FolderFlow, FileFlow } from "bao-bundler";

// 1. Initialize a new project
const project = new Project('my-website', {
  // Specify a temporary directory for build artifacts
  tmpPath: './.bao_tmp',

  // 2. Define the runners and flows for your assets
  runners: [
    // Copy the 'images' folder
    [new CopyRunner(), new FolderFlow('images', 'images')],
    
    // Copy the 'fonts' folder
    [new CopyRunner(), new FolderFlow('fonts', 'fonts')],
    
    // Copy a single file, the favicon
    [
      new CopyRunner({ isFile: true }),
      new FileFlow('favicon.ico', 'favicon.ico'),
    ],
  ],
});

// 3. Run the build process
project.build();

// 4. (Optional) Save the project configuration to a manifest file
project.saveToManifest();

```

### Building the Project

To run the build process defined in your script, simply execute it with Bun:

```bash
bun run example.ts
```

This will perform the configured actions, such as copying your assets into the specified temporary directory (`./.bao_tmp` in this case).

## API

### `new Project(name, config)`

Creates a new project instance.

*   `name`: `string` - The name of your project.
*   `config`: `object` - An optional configuration object.
    *   `tmpPath`: `string` - Path to the temporary build directory.
    *   `runners`: `[Runner, Flow][]` - An array of tuples, where each tuple contains a `Runner` instance and a `Flow` instance.

### Flows

#### `new FolderFlow(folderPath, destPath)`

Defines a flow for processing all files within a folder.

*   `folderPath`: `string` - The source folder path relative to the `assets` directory.
*   `destPath`: `string` - The destination path within the `tmpPath`.

#### `new FileFlow(filePath, destPath)`

Defines a flow for processing a single file.

*   `filePath`: `string` - The source file path relative to the `assets` directory.
*   `destPath`: `string` - The destination path for the file within the `tmpPath`.

### Runners

#### `new CopyRunner(config)`

A runner that copies files.

*   `config`: `object` - An optional configuration object.
    *   `isFile`: `boolean` - Set to `true` when using with `FileFlow` to indicate that the source is a single file.

---
This `README.md` was generated based on the project's source code.