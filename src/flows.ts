/**
 * @module Flows
 */
import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Flow, FlowOutput } from './index';

export type { Flow, FlowOutput };

async function findFiles(source: string, extension?: string): Promise<string[]> {
  if (typeof Bun !== 'undefined') {
    const findLines = extension
      ? Bun.$`find ${source} -type f -name ${`*.${extension}`}`.lines()
      : Bun.$`find ${source} -type f`.lines();

    const files = [];
    for await (const line of findLines) {
      if (!line) continue;
      files.push(line);
    }
    return files;
  }

  const files: string[] = [];
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const path = join(source, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await findFiles(path, extension)));
      continue;
    }

    if (entry.isFile() && (!extension || entry.name.endsWith(`.${extension}`))) {
      files.push(path);
    }
  }
  return files;
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

  async execute(): Promise<FlowOutput> {
    await mkdir(this.config.dest, { recursive: true });

    if (!this.config.expand) {
      return {
        source: { path: this.config.source },
        dest: { path: this.config.dest },
      };
    }

    const files = await findFiles(this.config.source, this.config.extension);
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
