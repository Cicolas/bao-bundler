/**
 * @module Types
 */
import { cp, mkdir, rm } from 'node:fs/promises';
import { Logger } from './_logger';

export { BaoLogger } from './_logger';

export type FlowData = {
  path: string | string[];
};

export type FlowOutput = {
  source?: FlowData;
  dest?: FlowData;
};

export interface Flow {
  id: string;
  execute(): Promise<FlowOutput>;
}

export interface Runner {
  run: (input: FlowOutput) => Promise<void>;
}

const TMP_PATH = './.bao_tmp';
const ASSETS_PATH = 'assets';
const BUILD_PATH = 'build';

class Project {
  dependencies: Record<string, string> = {};
  flows: Record<string, Set<string>> = {};

  constructor(
    public name: string,
    private steps: { runner: Runner; flow: Flow }[] = [],
    private config?: {
      tmpPath?: string;
      assetsPath?: string;
      buildPath?: string;
    },
  ) {}

  async build(): Promise<void> {
    Logger.info(`Building project: ${this.name}`);
    try {
      await this.loadFromManifest();
    } catch (err) {
      if (err instanceof Error && err.message === 'manifestFileNotfound') {
        Logger.warn('no manifest file were found');
      } else {
        throw err;
      }
    }
    const buildPath = this.config?.buildPath ?? BUILD_PATH;
    const assetsPath = this.config?.assetsPath ?? ASSETS_PATH;
    const tmpPath = this.config?.tmpPath ?? TMP_PATH;

    await rm(`../${tmpPath}`, { recursive: true, force: true });
    await mkdir(`${tmpPath}/${assetsPath}`, { recursive: true });
    await cp(`${assetsPath}`, `${tmpPath}/${assetsPath}/`, { recursive: true });

    process.chdir(tmpPath);

    for (const { runner, flow } of this.steps) {
      await this.executeStep(runner, flow);
    }

    process.chdir('./..');
    await rm(`${buildPath}`, { recursive: true, force: true });
    await mkdir(`${buildPath}`);
    await cp(`${tmpPath}/${buildPath}`, `${buildPath}/`, { recursive: true });

    await this.saveToManifest();
  }

  async executeStep(runner: Runner, flow: Flow): Promise<void> {
    const id = flow.id;
    Logger.info(`Executing flow: ${id}`);
    const flowOutput = await flow.execute();

    if (Array.isArray(flowOutput.source?.path)) {
      const filesArray = flowOutput.source.path;
      this.flows[id] = new Set(
        [...(this.flows[id] ?? []), ...filesArray].filter((f) =>
          filesArray.includes(f),
        ),
      );
      flowOutput.source.path = Array.from(this.flows[id]);
    }

    await runner.run(flowOutput);
  }

  async loadFromManifest() {
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

export { Project };
