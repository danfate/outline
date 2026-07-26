import { vi } from "vitest";
import { MeilisearchClient } from "./MeilisearchClient";

describe("MeilisearchClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends locales and the current title-search field", async () => {
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
      locales: ["zho", "eng"],
      offset: 0,
      query: "进程间通信",
    });

    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({
      attributesToSearchOn: ["title"],
      locales: ["zho", "eng"],
    });
  });
});
