import { readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modelsRoot = path.join(root, 'dist', 'models');
const catalogPath = path.join(modelsRoot, 'catalog.json');
const maxChunkBytes = 24 * 1024 * 1024;
const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
let chunkedModels = 0;

for (const model of catalog.models || []) {
  const modelPath = path.join(modelsRoot, model.file);
  const modelStat = await stat(modelPath).catch(() => null);
  if (!modelStat || modelStat.size <= maxChunkBytes) continue;

  const modelBytes = await readFile(modelPath);
  const chunks = [];
  for (let offset = 0, index = 0; offset < modelBytes.length; offset += maxChunkBytes, index += 1) {
    const suffix = String(index).padStart(3, '0');
    const relativePath = `${model.file}.part-${suffix}`;
    await writeFile(path.join(modelsRoot, relativePath), modelBytes.subarray(offset, offset + maxChunkBytes));
    chunks.push(relativePath);
  }

  model.fileSizeBytes = modelBytes.length;
  model.chunks = chunks;
  await unlink(modelPath);
  chunkedModels += 1;
}

await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
console.log(`Split ${chunkedModels} large model${chunkedModels === 1 ? '' : 's'} into Cloudflare-safe assets.`);
