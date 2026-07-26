import Redis from "@server/storage/redis";

/** Supported phases of a resumable Meilisearch full-index rebuild. */
export type MeilisearchReindexPhase =
  | "collections"
  | "documents"
  | "documentChunks"
  | "swapping"
  | "cleanup";

/** Persisted state for a resumable Meilisearch full-index rebuild. */
export interface MeilisearchReindexState {
  configurationFingerprint: string;
  createdAt: string;
  cursors: {
    collections: string | undefined;
    documentChunks: string | undefined;
    documents: string | undefined;
  };
  indexes: {
    collections: string;
    documentChunks: string | undefined;
    documents: string;
  };
  phase: MeilisearchReindexPhase;
  runId: string;
  swapTaskUid?: number;
  version: 1;
}

/**
 * Persists the resumable state of one Meilisearch full-index rebuild.
 */
export class MeilisearchReindexStateStore {
  private readonly key: string;

  /**
   * @param indexPrefix - the Meilisearch index prefix that owns the rebuild.
   */
  public constructor(indexPrefix: string) {
    this.key = `meilisearch:reindex:${indexPrefix}`;
  }

  /**
   * Reads the pending rebuild state, if present.
   *
   * @returns the persisted state or undefined when no rebuild is pending.
   * @throws when the persisted state is not a supported rebuild state.
   */
  public async get(): Promise<MeilisearchReindexState | undefined> {
    const value = await Redis.defaultClient.get(this.key);
    if (!value) {
      return undefined;
    }

    let state: MeilisearchReindexState;
    try {
      state = JSON.parse(value) as MeilisearchReindexState;
    } catch {
      throw new Error(
        "Meilisearch reindex state is invalid; run reindex with --fresh"
      );
    }

    if (!state || !this.isValidState(state)) {
      throw new Error(
        "Meilisearch reindex state is invalid; run reindex with --fresh"
      );
    }
    return state;
  }

  /**
   * Writes a rebuild state without an expiry so interrupted runs can resume.
   *
   * @param state - the rebuild state to persist.
   * @returns a promise that resolves when Redis has accepted the state.
   */
  public async save(state: MeilisearchReindexState): Promise<void> {
    await Redis.defaultClient.set(this.key, JSON.stringify(state));
  }

  /**
   * Removes the pending rebuild state.
   *
   * @returns a promise that resolves when the state is removed.
   */
  public async clear(): Promise<void> {
    await Redis.defaultClient.del(this.key);
  }

  private isValidState(value: MeilisearchReindexState): boolean {
    return (
      value.version === 1 &&
      typeof value.runId === "string" &&
      typeof value.configurationFingerprint === "string" &&
      typeof value.createdAt === "string" &&
      (value.phase === "collections" ||
        value.phase === "documents" ||
        value.phase === "documentChunks" ||
        value.phase === "swapping" ||
        value.phase === "cleanup") &&
      typeof value.indexes?.collections === "string" &&
      typeof value.indexes?.documents === "string" &&
      (typeof value.indexes?.documentChunks === "string" ||
        value.indexes?.documentChunks === undefined) &&
      value.cursors !== null &&
      typeof value.cursors === "object" &&
      (typeof value.cursors.collections === "string" ||
        value.cursors.collections === undefined) &&
      (typeof value.cursors.documents === "string" ||
        value.cursors.documents === undefined) &&
      (typeof value.cursors.documentChunks === "string" ||
        value.cursors.documentChunks === undefined) &&
      (value.swapTaskUid === undefined ||
        (Number.isInteger(value.swapTaskUid) && value.swapTaskUid >= 0))
    );
  }
}
