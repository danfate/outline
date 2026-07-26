import { Buffer } from "node:buffer";

/**
 * Splits records into batches whose JSON payloads fit within a byte limit.
 *
 * @param records - records to batch.
 * @param maximumBytes - maximum JSON payload size per batch.
 * @returns batches in their original order.
 * @throws when one record exceeds the configured payload limit.
 */
export function batchByByteSize<T extends object>(
  records: T[],
  maximumBytes: number
): T[][] {
  const batches: T[][] = [];
  let batch: T[] = [];
  let batchBytes = 2;

  for (const record of records) {
    const serialized = JSON.stringify(record);
    if (!serialized) {
      throw new Error("Unable to serialize Meilisearch document chunk");
    }
    const recordBytes = Buffer.byteLength(serialized);
    if (recordBytes + 2 > maximumBytes) {
      throw new Error(
        "A Meilisearch document chunk exceeds MEILISEARCH_DOCUMENT_CHUNK_MAX_PAYLOAD_BYTES"
      );
    }

    let separatorBytes = batch.length ? 1 : 0;
    if (batchBytes + separatorBytes + recordBytes > maximumBytes) {
      batches.push(batch);
      batch = [];
      batchBytes = 2;
      separatorBytes = 0;
    }

    batch.push(record);
    batchBytes += separatorBytes + recordBytes;
  }

  if (batch.length) {
    batches.push(batch);
  }
  return batches;
}
