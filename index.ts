import { $ } from 'bun';
import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const TMP_PATH = './.bao_tmp';
const ASSETS_PATH = 'assets';
const BUILD_PATH = 'build';

interface Flow {
  id: string;

  execute(): Promise<
    [string[] | string | undefined, string[] | string | undefined]
  >;
}

class FolderFlow implements Flow {
  id!: string;

  constructor(
    private config: {
      source: string;
      dest: string;
      expand?: boolean;
      extension?: string;
    },
  ) {
    this.id = config.extension
      ? `FolderFlow:${this.config.source}#${this.config.extension}`
      : `FolderFlow:${this.config.source}`;
  }

  async execute(): Promise<
    [string[] | string | undefined, string[] | string | undefined]
  > {
    await mkdir(this.config.dest, { recursive: true });

    if (!this.config.expand) {
      return [this.config.source, this.config.dest];
    }

    let findLines!: AsyncIterable<string>;
    if (!this.config.extension) {
      findLines = await $`find ${this.config.source} -type f`.lines();
    } else {
      findLines =
        await $`find ${this.config.source} -type f -name "*.${this.config.extension}"`.lines();
    }

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
  id!: string;

  constructor(public filePath: string) {
    this.id = `VoidFileFlow:${filePath}`;
  }

  async execute(): Promise<[string, undefined]> {
    return [this.filePath, undefined];
  }
}

interface Runner {
  run: (
    source: string | string[] | undefined,
    dest: string | string[] | undefined,
  ) => Promise<void>;
}

class CopyRunner implements Runner {
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

class Project {
  dependencies: Record<string, string> = {};
  flows: Record<string, Set<string>> = {};

  constructor(
    public name: string,
    private steps: { runner: Runner; flow: Flow }[] = [],
  ) {}

  async build(): Promise<void> {
    console.log(`Building project: ${this.name}`);
    try {
      await this.loadFromManifest();
      console.log(this);
    } catch (err) {
      if (err instanceof Error && err.message === 'manifestFileNotfound') {
        console.warn('no manifest file were found');
      } else {
        throw err;
      }
    }

    await rm(`../${TMP_PATH}`, {
      recursive: true,
      force: true,
    });
    await mkdir(`${TMP_PATH}/${ASSETS_PATH}`, {
      recursive: true,
    });
    await cp(`${ASSETS_PATH}`, `${TMP_PATH}/${ASSETS_PATH}/`, {
      recursive: true,
    });

    process.chdir(TMP_PATH);

    for (const { runner, flow } of this.steps) {
      await this.executeStep(runner, flow);
    }

    process.chdir('./..');
    await rm(`${BUILD_PATH}`, {
      recursive: true,
      force: true,
    });
    await mkdir(`${BUILD_PATH}`);
    await cp(`${TMP_PATH}/${BUILD_PATH}`, `${BUILD_PATH}/`, {
      recursive: true,
    });

    await this.saveToManifest();
  }

  async executeStep(runner: Runner, flow: Flow): Promise<void> {
    const id = flow.id;
    console.log(`Executing flow: ${id}`);
    const [files, destPath] = await flow.execute();

    if (Array.isArray(files)) {
      let filesArray = files;
      this.flows[id] = new Set(
        [...(this.flows[id] ?? []), ...filesArray].filter((f) =>
          filesArray.includes(f),
        ),
      );
      filesArray = Array.from(this.flows[id]);
      console.log(
        `Running runner: ${Object.getPrototypeOf(runner).constructor.name}`,
      );
      await runner.run(filesArray, destPath);
    } else {
      console.log(
        `Running runner: ${Object.getPrototypeOf(runner).constructor.name}`,
      );
      await runner.run(files, destPath);
    }
  }

  async loadFromManifest() {
    // check for bao.manifest.json in the current directory
    const manifestFile = Bun.file('./bao.manifest.json');
    if (!(await manifestFile.exists())) {
      throw new Error('manifestFileNotfound');
    }
    const manifest = await manifestFile.json();

    this.dependencies = manifest.dependencies;
    this.flows = manifest.flows;
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
