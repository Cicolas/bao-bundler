/**
 * @module Types
 */
import { BuildTransaction } from './build-transaction';
import { Logger } from './_logger';

export { BaoLogger } from './_logger';

export type FlowData = {
  path: string | string[];
};

export type FlowOutput = {
  source?: FlowData;
  dest?: FlowData;
};

export type FlowContext = {
  projectRoot: string;
  cachePath: string;
  dependencies: Record<string, string>;
};

export interface Flow {
  id: string;
  execute(context?: FlowContext): Promise<FlowOutput>;
}

export interface Runner {
  run: (input: FlowOutput) => Promise<void>;
}

const TMP_PATH = './.bao_tmp';

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
    const transaction = await BuildTransaction.create(this.config);
    try {
      Logger.info(`Building project: ${this.name}`);
      await transaction.recover();
      try {
        await this.loadFromManifest();
      } catch (err) {
        if (err instanceof Error && err.message === 'manifestFileNotfound') {
          Logger.warn('no manifest file were found');
        } else {
          throw err;
        }
      }
      const context: FlowContext = {
        projectRoot: transaction.root,
        cachePath: transaction.cache,
        dependencies: this.dependencies,
      };
      await transaction.run(
        async () => {
          for (const { runner, flow } of this.steps) {
            await this.executeStep(runner, flow, context);
          }
        },
        (path) => this.saveToManifest(path),
      );
    } finally {
      transaction.release();
    }
  }

  async executeStep(
    runner: Runner,
    flow: Flow,
    context?: FlowContext,
  ): Promise<void> {
    const id = flow.id;
    Logger.info(`Executing flow: ${id}`);
    const flowOutput = await flow.execute(context);

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
    this.dependencies = manifest.dependencies ?? {};
    this.flows = Object.fromEntries(
      Object.entries(manifest.flows ?? {}).map(([id, paths]) => [
        id,
        new Set(paths as string[]),
      ]),
    );
  }

  async saveToManifest(path = './bao.manifest.json'): Promise<void> {
    const manifestFile = Bun.file(path);
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
        tmpPath: this.config?.tmpPath ?? TMP_PATH,
        status: 'success',
      },
      null,
      2,
    );
  }
}

export { Project };
