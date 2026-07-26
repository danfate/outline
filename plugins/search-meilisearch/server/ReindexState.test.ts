import { randomUUID } from "node:crypto";
import Redis from "@server/storage/redis";
import {
  MeilisearchReindexStateStore,
  type MeilisearchReindexState,
} from "./ReindexState";

describe("MeilisearchReindexStateStore", () => {
  const indexPrefix = `reindex-test-${randomUUID()}`;
  const store = new MeilisearchReindexStateStore(indexPrefix);

  afterEach(async () => {
    await store.clear();
  });

  it("persists a document checkpoint for a resumable rebuild", async () => {
    const state: MeilisearchReindexState = {
      configurationFingerprint: "semantic:BAAI/bge-m3:1024:1",
      createdAt: "2026-07-26T00:00:00.000Z",
      cursors: {
        collections: "collection-1",
        documentChunks: "document-2",
        documents: "document-3",
      },
      indexes: {
        collections: "test_collections_rebuild_run-1",
        documentChunks: "test_document_chunks_rebuild_run-1",
        documents: "test_documents_rebuild_run-1",
      },
      phase: "documentChunks",
      runId: "run-1",
      version: 1,
    };

    await store.save(state);

    await expect(store.get()).resolves.toEqual(state);
  });

  it("rejects a malformed persisted state with recovery guidance", async () => {
    await Redis.defaultClient.set(
      `meilisearch:reindex:${indexPrefix}`,
      JSON.stringify({
        configurationFingerprint: "semantic:BAAI/bge-m3:1024:1",
        createdAt: "2026-07-26T00:00:00.000Z",
        cursors: null,
        indexes: {
          collections: "test_collections_rebuild_run-1",
          documents: "test_documents_rebuild_run-1",
        },
        phase: "collections",
        runId: "run-1",
        version: 1,
      })
    );

    await expect(store.get()).rejects.toThrow("run reindex with --fresh");
  });
});
