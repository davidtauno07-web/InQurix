// Downloads the local embedding model once at build time so semantic search runs fully offline.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODEL = 'Xenova/all-MiniLM-L6-v2';
const FILES = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json', 'vocab.txt', 'onnx/model_quantized.onnx'];
const dir = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'resources/models', MODEL);

for (const f of FILES) {
  const dest = path.join(dir, f);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) continue;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const res = await fetch(`https://huggingface.co/${MODEL}/resolve/main/${f}`);
  if (!res.ok) throw new Error(`Failed to download ${f}: ${res.status}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  console.log(`downloaded ${f}`);
}
console.log(`Model ready in ${dir}`);
