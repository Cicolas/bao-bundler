/**
 * @module Runners
 */
import { cp } from 'node:fs/promises';
import path from 'node:path';
import { Logger } from './_logger';
import type { Runner, FlowOutput } from './';

export type { Runner };

class CopyRunner implements Runner {
  async run(input: FlowOutput): Promise<void> {
    if (!input.source || !input.dest) {
      Logger.error('No source or destination provided to CopyRunner.');
      return;
    }

    const source = input.source.path;
    const dest = input.dest.path;

    if (Array.isArray(source) && Array.isArray(dest)) {
      for (let i = 0; i < source.length; i++) {
        Logger.debug(`Copying from ${source[i]} to ${dest[i]}`);
        await cp(source[i]!, dest[i]!, { recursive: true });
      }
      return;
    }

    if (Array.isArray(source) && typeof dest === 'string') {
      for (const src of source) {
        const baseName = path.basename(src);
        const destPath = path.join(dest, baseName);
        Logger.debug(`Copying from ${src} to ${destPath}`);
        await cp(src, destPath, { recursive: true });
      }
      return;
    }

    if (typeof source === 'string' && Array.isArray(dest)) {
      Logger.warn(
        'Warning: Source is a single string but destination is an array. Using the first element of destination.',
      );
      const destPath = dest[0]!;
      Logger.debug(`Copying from ${source} to ${destPath}`);
      await cp(source, destPath, { recursive: true });
      return;
    }

    Logger.debug(`Copying from ${source} to ${dest}`);
    await cp(source as string, dest as string, { recursive: true });
  }
}

export { CopyRunner };
