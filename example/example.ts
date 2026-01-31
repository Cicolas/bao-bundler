import { Project, CopyRunner, FolderFlow, FileFlow } from "..";

const project = new Project('bao', {
  tmpPath: './.bao_tmp',
  runners: [
    [new CopyRunner(), new FolderFlow('images', 'images')],
    [new CopyRunner(), new FolderFlow('fonts', 'fonts')],
    [
      new CopyRunner({
        isFile: true,
      }),
      new FileFlow('favicon.ico', 'favicon.ico'),
    ],
  ],
});

project.build();
project.saveToManifest();