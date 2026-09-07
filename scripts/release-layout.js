import { cp } from 'node:fs/promises';
import path from 'node:path';

export function releaseNameFor(packageMetadata) {
  return `viqueue-v${packageMetadata.version}-rc`;
}

export async function copyBuiltReleaseOutputs(dist, stage) {
  for (const directory of ['bin', 'src']) {
    await cp(path.join(dist, directory), path.join(stage, directory), { recursive: true });
  }
  await cp(path.join(dist, 'package.json'), path.join(stage, 'package.json'));
}
