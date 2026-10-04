import type { Mistral } from '@mistralai/mistralai';

export interface ChunkOptions {
  maxChars?: number;
  overlapChars?: number;
}

/** Small deterministic chunker: paragraph boundaries first, character windows as fallback. */
export function chunkDocument(text: string, options: ChunkOptions = {}): string[] {
  const maxChars = options.maxChars ?? 1_200;
  const overlapChars = options.overlapChars ?? 200;
  if (maxChars <= 0 || overlapChars < 0 || overlapChars >= maxChars) {
    throw new Error('invalid chunk sizes');
  }

  const paragraphs = text
    .trim()
    .split(/\n\s*\n/u)
    .map((part) => part.trim())
    .filter(Boolean);
  if (paragraphs.length === 0) return [];

  const chunks: string[] = [];
  let current = '';
  const flush = () => {
    if (current) chunks.push(current);
  };

  for (const paragraph of paragraphs) {
    const separator = current ? '\n\n' : '';
    if (current.length + separator.length + paragraph.length <= maxChars) {
      current += separator + paragraph;
      continue;
    }

    const carry = current.slice(-overlapChars);
    flush();
    current = carry;
    let remaining = paragraph;
    while (remaining) {
      const joiner = current ? '\n\n' : '';
      const room = maxChars - current.length - joiner.length;
      if (remaining.length <= room) {
        current += joiner + remaining;
        remaining = '';
      } else {
        current += joiner + remaining.slice(0, Math.max(1, room));
        remaining = remaining.slice(Math.max(1, room));
        const overlap = current.slice(-overlapChars);
        flush();
        current = overlap;
      }
    }
  }
  flush();
  return chunks;
}

/** One Mistral request per supplied batch; callers choose their own batch size. */
export async function embedTexts(
  client: Pick<Mistral, 'embeddings'>,
  texts: string[],
  model = 'mistral-embed',
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const response = await client.embeddings.create({ model, inputs: texts });
  const embeddings: number[][] = [];
  for (const item of response.data) {
    if (!item.embedding || item.embedding.some((value) => !Number.isFinite(value))) {
      throw new Error('invalid embedding response');
    }
    embeddings.push(item.embedding);
  }
  if (embeddings.length !== texts.length) {
    throw new Error('invalid embedding response');
  }
  return embeddings;
}
