import { Project, CopyRunner, FolderFlow, FileFlow } from '..';

let project!: Project;

try {
  project = await Project.loadFromManifest({
    runners: [CopyRunner],
    flows: [FolderFlow, FileFlow],
  });
} catch (err) {
  if (err instanceof Error && err.message === 'manifestFileNotfound') {
    console.log('No existing manifest, creating new project.');
    project = new Project('bao', {
      tmpPath: './.bao_tmp',
      steps: [
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
      ],
    });
  } else {
    throw err;
  }
}

await project.build();
project.saveToManifest();
