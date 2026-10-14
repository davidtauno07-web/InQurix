import path from 'node:path';

export type Embedder = (texts: string[]) => Promise<Float32Array[]>;

export const EMBED_MODEL = 'Xenova/all-MiniLM-L6-v2';
export const EMBED_DIM = 384;

/**
 * Local sentence embeddings (MiniLM, quantized ONNX) loaded from the bundled
 * model directory. Remote model downloads are disabled so nothing leaves the device.
 */
export async function createEmbedder(modelsDir: string): Promise<Embedder> {
  const { env, pipeline } = await import('@huggingface/transformers');
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = modelsDir.endsWith(path.sep) ? modelsDir : modelsDir + path.sep;
  const extractor = await pipeline('feature-extraction', EMBED_MODEL, { dtype: 'q8', device: 'cpu' });
  return async (texts: string[]) => {
    if (!texts.length) return [];
    const out = await extractor(texts.map((t) => t.slice(0, 2000)), { pooling: 'mean', normalize: true });
    const data = out.data as Float32Array;
    const dim = out.dims[out.dims.length - 1] as number;
    return texts.map((_, i) => data.slice(i * dim, (i + 1) * dim));
  };
}

export function toBlob(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
}

export function fromBlob(b: Uint8Array): Float32Array {
  const copy = new Uint8Array(b);
  return new Float32Array(copy.buffer, 0, copy.byteLength / 4);
}

export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
