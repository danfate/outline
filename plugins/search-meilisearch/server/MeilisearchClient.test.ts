import { vi } from "vitest";
import { MeilisearchClient } from "./MeilisearchClient";

describe("MeilisearchClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("ignores an asynchronous not-found error when deleting an index", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ taskUid: 1 }), { status: 202 })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              code: "index_not_found",
              message: "Index `test_documents` not found.",
            },
            status: "failed",
            taskUid: 1,
          }),
          { status: 200 }
        )
      );
    vi.stubGlobal("fetch", fetch);
    const client = new MeilisearchClient({
      apiKey: "test-key",
      indexPrefix: "test",
      url: "http://meilisearch.test",
    });

    await expect(
      client.deleteIndexIfExists("documents")
    ).resolves.toBeUndefined();
  });

  it("finds a previously submitted matching index swap task", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [
            {
              details: {
                swaps: [
                  {
                    indexes: ["test_collections", "test_collections_rebuild"],
                  },
                  {
                    indexes: ["test_documents", "test_documents_rebuild"],
                  },
                ],
              },
              status: "processing",
              type: "indexSwap",
              uid: 42,
            },
          ],
        }),
        { status: 200 }
      )
    );
    vi.stubGlobal("fetch", fetch);
    const client = new MeilisearchClient({
      apiKey: "test-key",
      indexPrefix: "test",
      url: "http://meilisearch.test",
    });

    await expect(
      client.findSwapTask([
        ["documents", "documents_rebuild"],
        ["collections", "collections_rebuild"],
      ])
    ).resolves.toBe(42);
  });

  it("sends configured locales with a search query", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          estimatedTotalHits: 0,
          hits: [],
        }),
        { status: 200 }
      )
    );
    vi.stubGlobal("fetch", fetch);
    const client = new MeilisearchClient({
      apiKey: "test-key",
      indexPrefix: "test",
      url: "http://meilisearch.test",
    });

    await client.search("documents", {
      attributesToSearchOn: ["title"],
      limit: 10,
      locales: ["eng", "zho"],
      offset: 0,
      query: "Python 进程间通信",
    });

    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({
      attributesToSearchOn: ["title"],
      locales: ["eng", "zho"],
    });
  });
});
