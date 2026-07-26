/**
 * Splits text into overlapping chunks without separating Unicode surrogate pairs.
 *
 * @param text - plain text to split.
 * @param chunkSize - maximum number of UTF-16 code units in a chunk.
 * @param overlap - number of UTF-16 code units shared by neighboring chunks.
 * @returns non-empty text chunks in their original order.
 */
export function textChunks(
  text: string,
  chunkSize = 1_000,
  overlap = 150
): string[] {
  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + chunkSize, text.length);
    if (end < text.length) {
      const boundary = text.lastIndexOf(" ", end);
      if (boundary > start + chunkSize / 2) {
        end = boundary;
      }
    }
    end = surrogatePairBoundary(text, end);

    const chunk = text.slice(start, end).trim();
    if (chunk) {
      chunks.push(chunk);
    }
    if (end === text.length) {
      return chunks;
    }
    start = surrogatePairBoundary(text, Math.max(end - overlap, start + 1));
  }

  return chunks;
}

function surrogatePairBoundary(text: string, index: number): number {
  if (
    index > 0 &&
    index < text.length &&
    isHighSurrogate(text.charCodeAt(index - 1)) &&
    isLowSurrogate(text.charCodeAt(index))
  ) {
    return index - 1;
  }
  return index;
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}
