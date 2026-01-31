import { Project, CopyRunner, FolderFlow, FileFlow } from '..';

await new Project('bao', [
  {
    runner: new CopyRunner(),
    flow: new FolderFlow({
      source: 'assets/images',
      dest: 'build/images',
    }),
  },
  {
    runner: new CopyRunner(),
    flow: new FolderFlow({
      source: 'assets/fonts',
      dest: 'build/fonts',
      expand: true,
    }),
  },
  {
    runner: new CopyRunner(),
    flow: new FileFlow({
      source: 'assets/favicon.ico',
      dest: 'build/favicon.ico',
    }),
  },
]).build();
