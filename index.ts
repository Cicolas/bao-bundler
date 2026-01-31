import { $ } from 'bun';
import { cp } from 'node:fs/promises';
import path from 'node:path';

const TMP_PATH = './.bao_tmp';
const ASSETS_PATH = 'assets';
const BUILD_PATH = 'build';

interface Flow {
  name: string;
  description: string;
  id: string;

  execute(): Promise<
    [string[] | string | undefined, string[] | string | undefined]
  >;
}

class FolderFlow implements Flow {
  name: string = 'FolderFlow';
  description: string = 'A flow that processes files in a folder.';
  id!: string;

  constructor(
    private config: {
      source: string;
      dest: string;
      expand?: boolean;
    },
  ) {
    this.id = `FolderFlow:${this.config.source}`;
  }

  async execute(): Promise<
    [string[] | string | undefined, string[] | string | undefined]
  > {
    if (!this.config.expand) {
      return [this.config.source, this.config.dest];
    }

    const findLines = await $`find ${this.config.source} -type f`.lines();
    const files = [];
    for await (const line of findLines) {
      if (!line) continue;
      console.log(`Found file: ${line}`);
      files.push(line);
    }
    return [files, this.config.dest];
  }
}

class FileFlow implements Flow {
  name: string = 'FileFlow';
  description: string = 'A flow that processes file';
  id!: string;

  constructor(
    private config: {
      source: string;
      dest: string;
    },
  ) {
    this.id = `FileFlow:${this.config.source}`;
  }

  async execute(): Promise<[string, string]> {
    return [this.config.source, this.config.dest];
  }
}

class VoidFileFlow implements Flow {
  name: string = 'VoidFileFlow';
  description: string = 'A flow that does nothing.';
  id: string = 'VoidFileFlow';

  constructor(public filePath: string) {}

  async execute(): Promise<[string, undefined]> {
    return [this.filePath, undefined];
  }
}

interface Runner {
  name: string;
  description: string;
  version: string;

  run: (
    source: string | string[] | undefined,
    dest: string | string[] | undefined,
  ) => Promise<void>;
}

class CopyRunner implements Runner {
  name: string = 'GenericBuilder';
  description: string = 'A generic build runner.';
  version: string = '1.0.0';

  constructor() {}

  async run(
    source: string | string[] | undefined,
    dest: string | string[] | undefined,
  ): Promise<void> {
    if (!source || !dest) {
      console.log('No source or destination provided to CopyRunner.');
      return;
    }

    if (Array.isArray(source) && Array.isArray(dest)) {
      for (let i = 0; i < source.length; i++) {
        console.log(`Copying from ${source[i]} to ${dest[i]}`);
        await cp(source[i]!, dest[i]!, { recursive: true });
      }
      return;
    }

    if (Array.isArray(source) && typeof dest === 'string') {
      for (const src of source) {
        const baseName = path.basename(src);
        const destPath = path.join(dest, baseName);
        console.log(`Copying from ${src} to ${destPath}`);
        await cp(src, destPath, { recursive: true });
      }
      return;
    }

    if (typeof source === 'string' && Array.isArray(dest)) {
      console.log(
        'Warning: Source is a single string but destination is an array. Using the first element of destination.',
      );
      const destPath = dest[0]!;
      console.log(`Copying from ${source} to ${destPath}`);
      await cp(source, destPath, { recursive: true });
      return;
    }

    // both are strings
    console.log(`Copying from ${source} to ${dest}`);
    await cp(source as string, dest as string, { recursive: true });
  }
}

// Source - https://stackoverflow.com/a/77588125
// Posted by hjkatz
// Retrieved 2026-01-31, License - CC BY-SA 4.0

export type Constructor<T = any> = new (...args: any[]) => T;

class Project {
  dependencies: Record<string, string> = {};
  flows: Record<string, Set<string>> = {};
  steps: { runner: Runner; flow: Flow }[] = [];

  constructor(
    public name: string,
    config?: {
      tmpPath?: string;
      dependencies?: Record<string, string>;
      flows?: Record<string, Set<string>>;
      steps?: { runner: Runner; flow: Flow }[];
    },
  ) {
    if (config) {
      if (config.dependencies) {
        this.dependencies = config.dependencies;
      }
      if (config.flows) {
        this.flows = config.flows;
      }
      if (config.steps) {
        this.steps = config.steps;
      }
    }
  }

  async build(): Promise<void> {
    console.log(`Building project: ${this.name}`);

    await $`rm -rf ${TMP_PATH}`;
    await $`mkdir -p ${TMP_PATH}/${ASSETS_PATH}`;
    await $`cp -r ${ASSETS_PATH}/* ${TMP_PATH}/${ASSETS_PATH}/`;

    process.chdir(TMP_PATH);

    for (const { runner, flow } of this.steps) {
      await this.executeRunner(runner, flow);
    }

    await $`mkdir -p ../${BUILD_PATH}`;
    await $`cp -r ${BUILD_PATH}/* ../${BUILD_PATH}`;
    process.chdir('./..');
  }

  async executeRunner(runner: Runner, flow: Flow): Promise<void> {
    const id = flow.id;
    console.log(`Executing flow: ${id}`);
    const [files, destPath] = await flow.execute();

    const filesArray = Array.isArray(files) ? files : files ? [files] : [];
    this.flows[id] = new Set(
      [...(this.flows[id] ?? []), ...filesArray].filter((f) =>
        filesArray.includes(f),
      ),
    );

    console.log(`Running runner: ${runner.name}`);
    await runner.run(files, destPath);
  }

  static async loadFromManifest(config: {
    runners: Constructor[];
    flows: Constructor[];
  }): Promise<Project> {
    // check for bao.manifest.json in the current directory
    const manifestFile = Bun.file('./bao.manifest.json');
    if (!(await manifestFile.exists())) {
      throw new Error('manifestFileNotfound');
    }
    const manifest = require('./bao.manifest.json');

    manifest.steps = manifest.steps.map((s: any) => {
      return {
        runner: new (
          config.runners.find(
            (func) => func.prototype.constructor.name === s.runner.className,
          ) ??
          (() => {
            throw new Error(
              `could not find '${s.runner.className}' on 'config.runners', perhaps '${s.runner.className}' is not defined on your config?`,
            );
          })()
        )(s.runner.config),
        flow: new (
          config.flows.find(
            (func) => func.prototype.constructor.name === s.flow.className,
          ) ??
          (() => {
            throw new Error(
              `could not find '${s.flow.className}' on 'config.flows', perhaps '${s.flow.className}' is not defined on your config?`,
            );
          })()
        )(s.flow.config),
      };
    });

    return new Project(manifest.name, {
      dependencies: manifest.dependencies,
      flows: manifest.flows,
      steps: manifest.steps,
      tmpPath: manifest.tmpPath,
    });
  }

  async saveToManifest(): Promise<void> {
    const manifestFile = Bun.file('./bao.manifest.json');
    await manifestFile.write(this.toJSON());
  }

  toJSON(): string {
    return JSON.stringify(
      {
        name: this.name,
        dependencies: this.dependencies,
        flows: Object.fromEntries(
          Object.entries(this.flows).map(([key, value]) => [
            key,
            Array.from(value),
          ]),
        ),
        steps: this.steps.map(({ runner, flow }) => ({
          runner: {
            className: Object.getPrototypeOf(runner).constructor.name,
            config: 'config' in runner ? runner.config : undefined,
          },
          flow: {
            className: Object.getPrototypeOf(flow).constructor.name,
            config: 'config' in flow ? flow.config : undefined,
          },
        })),
        tmpPath: TMP_PATH,
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
  VoidFileFlow as VoidFlow,
};
