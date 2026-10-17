import { cp, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

// chdir is process-wide. Parallel Project builds cannot safely share a process.
let active = false;
type Config = { tmpPath?: string; assetsPath?: string; buildPath?: string };
type Journal = {
  version: 1;
  status: 'in_progress' | 'success';
  output: string;
  hadOutput: boolean;
  hadManifest: boolean;
};

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

// Resolve existing parents too, so a symlink cannot disguise overlapping paths.
async function canonical(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return resolve(await canonical(parent), basename(path));
  }
}

export class BuildTransaction {
  readonly cache: string;
  private readonly output: string;
  private readonly tmp: string;
  private readonly assets: string;
  private readonly stagedAssets: string;
  private readonly stagedOutput: string;
  private readonly candidate: string;
  private readonly backup: string;
  private readonly manifest: string;
  private readonly manifestCandidate: string;
  private readonly manifestBackup: string;
  private readonly journalPath: string;

  private constructor(readonly root: string, config: Config) {
    this.tmp = resolve(root, config.tmpPath ?? '.bao_tmp');
    this.assets = resolve(root, config.assetsPath ?? 'assets');
    this.output = resolve(root, config.buildPath ?? 'build');
    this.cache = resolve(root, '.bao_cache');
    // Absolute source/output paths use their basename inside the temporary cwd.
    const assetsLocal = isAbsolute(config.assetsPath ?? '') ? basename(this.assets) : config.assetsPath ?? 'assets';
    const outputLocal = isAbsolute(config.buildPath ?? '') ? basename(this.output) : config.buildPath ?? 'build';
    this.stagedAssets = resolve(this.tmp, assetsLocal);
    this.stagedOutput = resolve(this.tmp, outputLocal);
    this.candidate = `${this.output}.bao-stage`;
    this.backup = `${this.output}.bao-backup`;
    this.manifest = resolve(root, 'bao.manifest.json');
    this.manifestCandidate = resolve(root, '.bao.manifest.stage.json');
    this.manifestBackup = resolve(root, '.bao.manifest.backup.json');
    this.journalPath = resolve(root, '.bao.build-state.json');
  }

  static async create(config: Config = {}): Promise<BuildTransaction> {
    if (active) throw new Error('A Project build is already running in this process');
    active = true;
    try {
      const transaction = new BuildTransaction(process.cwd(), config);
      await transaction.validate();
      return transaction;
    } catch (error) { active = false; throw error; }
  }

  release(): void { active = false; }

  private async validate(): Promise<void> {
    if (!contains(this.tmp, this.stagedAssets) || this.tmp === this.stagedAssets ||
        !contains(this.tmp, this.stagedOutput) || this.tmp === this.stagedOutput) {
      throw new Error('assetsPath and buildPath must stay inside the temporary build directory');
    }
    const [root, tmp, assets, output, cache] = await Promise.all(
      [this.root, this.tmp, this.assets, this.output, this.cache].map(canonical),
    );
    const overlaps = (a: string, b: string) => contains(a, b) || contains(b, a);
    if (contains(tmp, root) || contains(output, root) || overlaps(tmp, assets) ||
        overlaps(tmp, output) || overlaps(output, assets) || overlaps(tmp, cache) || overlaps(output, cache) ||
        overlaps(this.stagedAssets, this.stagedOutput)) {
      throw new Error('Unsafe overlapping temporary, asset, output, or cache paths');
    }
    // Reserved publication paths must not alias a user-controlled directory.
    for (const path of [this.manifest, this.candidate, this.backup, this.manifestCandidate, this.manifestBackup, this.journalPath, `${this.journalPath}.next`]) {
      if (await exists(path) && (await lstat(path)).isSymbolicLink()) {
        throw new Error(`Refusing symlink at reserved build path: ${path}`);
      }
      const resolved = await canonical(path);
      if (overlaps(resolved, assets) || overlaps(resolved, tmp) || overlaps(resolved, output) || overlaps(resolved, cache)) {
        throw new Error(`Unsafe reserved build path: ${path}`);
      }
    }
  }

  async recover(): Promise<void> {
    // An initial journal is installed atomically before any publication work.
    // A leftover .next without the journal therefore describes an uncommitted build.
    if (!(await exists(this.journalPath)) && await exists(`${this.journalPath}.next`)) {
      const pending = JSON.parse(await readFile(`${this.journalPath}.next`, 'utf8')) as Journal;
      this.validateJournal(pending);
      await rename(`${this.journalPath}.next`, this.journalPath);
    }
    if (!(await exists(this.journalPath))) {
      for (const path of [this.candidate, this.backup, this.manifestCandidate, this.manifestBackup]) {
        if (await exists(path)) throw new Error(`Reserved build path already exists without a journal: ${path}`);
      }
      return;
    }
    const journal = JSON.parse(await readFile(this.journalPath, 'utf8')) as Journal;
    this.validateJournal(journal);
    if (journal.status === 'in_progress') await this.rollback(journal);
    await this.cleanPublication();
  }

  private validateJournal(journal: Journal): void {
    if (journal.version !== 1 || journal.output !== this.output ||
        !['in_progress', 'success'].includes(journal.status) ||
        typeof journal.hadOutput !== 'boolean' || typeof journal.hadManifest !== 'boolean') {
      throw new Error('Invalid build recovery journal; rerun with the original buildPath configuration');
    }
  }

  private async rollback(journal: Journal): Promise<void> {
    for (const [live, backup, candidate, hadPrevious] of [
      [this.output, this.backup, this.candidate, journal.hadOutput],
      [this.manifest, this.manifestBackup, this.manifestCandidate, journal.hadManifest],
    ] as const) {
      if (await exists(backup)) {
        await rm(live, { recursive: true, force: true });
        await rename(backup, live);
      } else if (!hadPrevious && !(await exists(candidate))) {
        await rm(live, { recursive: true, force: true });
      }
    }
  }

  private async cleanPublication(): Promise<void> {
    for (const path of [this.candidate, this.backup, this.manifestCandidate, this.manifestBackup, `${this.journalPath}.next`]) {
      await rm(path, { recursive: true, force: true });
    }
    await rm(this.journalPath, { force: true });
  }

  async run(steps: () => Promise<void>, saveManifest: (path: string) => Promise<void>): Promise<void> {
    await rm(this.tmp, { recursive: true, force: true });
    await mkdir(this.stagedAssets, { recursive: true });
    await cp(this.assets, this.stagedAssets, { recursive: true });
    try {
      process.chdir(this.tmp);
      await steps();
    } finally { process.chdir(this.root); }

    // Fully prepare both artifacts before changing the last successful build.
    await mkdir(dirname(this.output), { recursive: true });
    const journal: Journal = {
      version: 1, status: 'in_progress', output: this.output,
      hadOutput: await exists(this.output), hadManifest: await exists(this.manifest),
    };
    await writeFile(`${this.journalPath}.next`, JSON.stringify(journal), { flag: 'wx' });
    await rename(`${this.journalPath}.next`, this.journalPath);
    try {
      await cp(this.stagedOutput, this.candidate, { recursive: true });
      await saveManifest(this.manifestCandidate);
      if (journal.hadOutput) await rename(this.output, this.backup);
      if (journal.hadManifest) await rename(this.manifest, this.manifestBackup);
      await rename(this.candidate, this.output);
      await rename(this.manifestCandidate, this.manifest);
      // Atomic journal replacement distinguishes committed output from rollback.
      await writeFile(`${this.journalPath}.next`, JSON.stringify({ ...journal, status: 'success' }), { flag: 'wx' });
      await rename(`${this.journalPath}.next`, this.journalPath);
    } catch (error) {
      try { await this.rollback(journal); await this.cleanPublication(); }
      catch (recoveryError) { throw new AggregateError([error, recoveryError], 'Build failed and rollback needs recovery on the next build'); }
      throw error;
    }
    await this.cleanPublication();
  }
}
