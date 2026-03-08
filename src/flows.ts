import { $ } from 'bun';
import { mkdir } from 'node:fs/promises';
import type { Flow, FlowOutput } from './_types';

export type { Flow, FlowOutput };

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

  async execute(): Promise<FlowOutput> {
    await mkdir(this.config.dest, { recursive: true });

    if (!this.config.expand) {
      return {
        source: { path: this.config.source },
        dest: { path: this.config.dest },
      };
    }

    let findLines!: AsyncIterable<string>;
    if (!this.config.extension) {
      findLines = $`find ${this.config.source} -type f`.lines();
    } else {
      findLines = $`find ${this.config.source} -type f -name "*.${this.config.extension}"`.lines();
    }

    const files = [];
    for await (const line of findLines) {
      if (!line) continue;
      files.push(line);
    }
    return {
      source: { path: files },
      dest: { path: this.config.dest },
    };
  }
}

class FileFlow implements Flow {
  id!: string;

  constructor(private config: { source: string; dest: string }) {
    this.id = `FileFlow:${this.config.source}`;
  }

  async execute(): Promise<FlowOutput> {
    return {
      source: { path: this.config.source },
      dest: { path: this.config.dest },
    };
  }
}

class VoidFileFlow implements Flow {
  id!: string;

  constructor(public config: { filePath: string }) {
    this.id = `VoidFileFlow:${config.filePath}`;
  }

  async execute(): Promise<FlowOutput> {
    return {
      source: { path: this.config.filePath },
    };
  }
}

export { FolderFlow, FileFlow, VoidFileFlow as VoidFlow };
