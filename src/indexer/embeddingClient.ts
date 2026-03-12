/**
 * JXA client for embeddingd — the macOS app wrapping all-MiniLM-L6-v2 (384-dim).
 *
 * Calls embeddingd via JXA Apple Events:
 *   - embed(text)             → number[384]
 *   - generateEmbeddings([…]) → number[] (flat, chunk by 384)
 */

import { executeJXA } from '../utils/scriptExecution.js';

export const MODEL_NAME = 'all-MiniLM-L6-v2';
export const DIMENSIONS = 384;
const BATCH_SIZE = 64;

/**
 * Embed a single text string. Returns a 384-element number array.
 */
export async function embedText(text: string): Promise<number[]> {
  const script = `(function() {
  var app = Application('com.gwjrmwd.embeddingd');
  return JSON.stringify(app.embed(${JSON.stringify(text)}));
})()`;
  const result = await executeJXA(script);
  if (!Array.isArray(result) || result.length !== DIMENSIONS) {
    throw new Error(`embeddingd: expected ${DIMENSIONS}-dim array, got ${Array.isArray(result) ? result.length : typeof result}`);
  }
  return result;
}

/**
 * Embed a batch of texts. Returns an array of 384-element number arrays,
 * one per input text. Chunks into batches of BATCH_SIZE to avoid overloading.
 */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const results: number[][] = [];

  for (let offset = 0; offset < texts.length; offset += BATCH_SIZE) {
    const chunk = texts.slice(offset, offset + BATCH_SIZE);
    const script = `(function() {
  var app = Application('com.gwjrmwd.embeddingd');
  return JSON.stringify(app.generateEmbeddings(${JSON.stringify(chunk)}));
})()`;
    const flat: number[] = await executeJXA(script);

    if (!Array.isArray(flat)) {
      throw new Error('embeddingd: generateEmbeddings did not return an array');
    }

    // Chunk the flat array into DIMENSIONS-sized sub-arrays
    for (let i = 0; i < chunk.length; i++) {
      const start = i * DIMENSIONS;
      const vec = flat.slice(start, start + DIMENSIONS);
      if (vec.length !== DIMENSIONS) {
        throw new Error(`embeddingd: expected ${DIMENSIONS} dims for item ${offset + i}, got ${vec.length}`);
      }
      results.push(vec);
    }
  }

  return results;
}

/**
 * Convert a number[] embedding to a hex-encoded Float32 little-endian blob
 * suitable for sqlite-vec.
 */
export function embeddingToHex(nums: number[]): string {
  const buf = Buffer.alloc(nums.length * 4);
  for (let i = 0; i < nums.length; i++) {
    buf.writeFloatLE(nums[i], i * 4);
  }
  return buf.toString('hex');
}
