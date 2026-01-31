import { $ } from 'bun';
import { cp } from 'node:fs/promises';
import path from 'node:path';

const TMP_PATH = './.bao_tmp';
const TMP_ASSETS_PATH = path.join(TMP_PATH, 'assets');
const ASSETS_PATH = path.join('assets');

interface Flow {
  name: string;
  description: string;
  id: string;

  execute(): Promise<[string[], string | undefined]>;
}

class FolderFlow implements Flow {
  name: string = 'FolderFlow';
  description: string = 'A flow that processes files in a folder.';
  id!: string;

  constructor(
    public folderPath: string,
    public destPath: string,
  ) {
    this.id = `FolderFlow:${folderPath}`;
  }

  async execute(): Promise<[string[], string]> {
    const findLines =
      await $`find ${path.join(TMP_ASSETS_PATH, this.folderPath)} -type f`.lines();
    const files = [];
    for await (const line of findLines) {
      console.log(`Found file: ${line}`);
      files.push(line);
    }
    return [files, this.destPath];
  }
}

class FileFlow implements Flow {
  name: string = 'FileFlow';
  description: string = 'A flow that processes file';
  id!: string;

  constructor(
    public filePath: string,
    public destPath: string,
  ) {
    this.id = `FileFlow:${filePath}`;
  }

  async execute(): Promise<[string[], string]> {
    const file = path.join(TMP_ASSETS_PATH, this.filePath);
    return [[file], this.destPath];
  }
}

class VoidFlow implements Flow {
  name: string = 'VoidFlow';
  description: string = 'A flow that does nothing.';
  id: string = 'VoidFlow';

  constructor(public filePath: string) {}

  async execute(): Promise<[string[], undefined]> {
    return [[this.filePath], undefined];
  }
}

interface Runner {
  name: string;
  description: string;
  version: string;

  run: Function;
}

class CopyRunner implements Runner {
  name: string = 'GenericBuilder';
  description: string = 'A generic build runner.';
  version: string = '1.0.0';

  constructor(
    private config?: {
      isFile?: boolean;
    },
  ) {}

  async run(filePaths: string, destPath: string): Promise<void> {
    for (const filePath of filePaths) {
      if (!filePath) continue;
      await $`echo "Bundling file: ${filePath}, to ${destPath}"`;

      const filename = path.basename(filePath);
      const dstPath = this.config?.isFile
        ? path.join(TMP_PATH, destPath)
        : path.join(TMP_PATH, destPath, filename);
      await cp(filePath, dstPath);
      console.log(`Copied ${filePath} to ${dstPath}`);
    }
  }
}

class Project {
  dependencies: Record<string, string> = {};
  flows: Record<string, Set<string>> = {};
  runners: [Runner, Flow][] = [];

  constructor(
    public name: string,
    config?: {
      tmpPath?: string;
      dependencies?: Record<string, string>;
      flows?: Record<string, Set<string>>;
      runners?: [Runner, Flow][];
    },
  ) {
    if (config) {
      if (config.dependencies) {
        this.dependencies = config.dependencies;
      }
      if (config.flows) {
        this.flows = config.flows;
      }
      if (config.runners) {
        this.runners = config.runners;
      }
    }
  }

  static loadFromManifest(): Project {
    // check for bao.manifest.json in the current directory
    const manifestFile = Bun.file('./bao.manifest.json');
    if (!manifestFile.exists()) {
      throw new Error(
        'Manifest file bao.manifest.json not found in the current directory.',
      );
    }
    const manifest = require('./bao.manifest.json');

    return new Project(manifest.name, {
      dependencies: manifest.dependencies,
      flows: manifest.flows,
      runners: manifest.runners,
      tmpPath: manifest.tmpPath,
    });
  }

  async build(): Promise<void> {
    console.log(`Building project: ${this.name}`);

    await $`rm -rf ${TMP_PATH}`;
    await $`mkdir -p ${TMP_PATH}/${ASSETS_PATH}`;
    await $`cp -r ${ASSETS_PATH}/* ${TMP_PATH}/${ASSETS_PATH}/`;

    if (!this.runners) {
      console.log('No runners defined in the project configuration.');
      return;
    }

    this.runners.forEach(async ([runner, flow]) => {
      await this.executeRunner(runner, flow);
    });
  }

  async executeRunner(runner: Runner, flow: Flow): Promise<void> {
    const id = flow.id;
    console.log(`Executing flow: ${id}`);
    const [files, destPath] = await flow.execute();

    this.flows[id] = this.flows[id] || new Set();
    this.flows[id] = new Set(
      [...(this.flows[id] ?? [])].filter((f) => !files.includes(f)),
    );

    for (const file of files) {
      console.log(`Processing file: ${file}`);
      this.flows[id]?.add(file);
    }

    console.log(`Running runner: ${runner.name}`);
    await runner.run(files, destPath);
  }

  saveToManifest(): void {
    const manifestFile = Bun.file('./bao.manifest.json');
    manifestFile.write(this.toJSON());
  }

  toJSON(): string {
    return JSON.stringify(
      {
        name: this.name,
        dependencies: this.dependencies,
        flows: this.flows,
        runners: this.runners,
      },
      null,
      2,
    );
  }
}

export {
  Project,
  type Flow,
  type Runner,
  CopyRunner,
  FolderFlow,
  FileFlow,
  VoidFlow,
};
