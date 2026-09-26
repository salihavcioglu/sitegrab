// SiteGrab — (c) 2026 Salih Avcioglu. MIT License.
import { createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { ZipArchive } from 'archiver';

/** Zips the contents of `dir` (without the top-level folder) into `outFile`. Resolves to the zip size in bytes. */
export async function zipDirectory(dir, outFile) {
  await mkdir(path.dirname(outFile), { recursive: true });
  await new Promise((resolve, reject) => {
    const output = createWriteStream(outFile);
    const archive = new ZipArchive({ zlib: { level: 6 } });
    const fail = (err) => {
      archive.abort?.();
      output.destroy();
      reject(err);
    };
    output.on('close', resolve);
    output.on('error', fail);
    archive.on('error', fail);
    archive.on('warning', (err) => {
      if (err.code !== 'ENOENT') fail(err);
    });
    archive.pipe(output);
    archive.directory(dir, false);
    archive.finalize().catch(fail);
  });
  return (await stat(outFile)).size;
}
