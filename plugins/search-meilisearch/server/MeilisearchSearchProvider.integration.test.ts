import { randomUUID } from "node:crypto";
import { http, passthrough } from "msw";
import { SearchableModel } from "@shared/types";
import {
  AuthenticationProvider,
  Collection,
  Team,
  User,
  type Document,
} from "@server/models";
import { buildDocument, buildUser } from "@server/test/factories";
import { server } from "@server/test/msw";
import { EmbeddingClient } from "./EmbeddingClient";
import env from "./env";
import { MeilisearchClient } from "./MeilisearchClient";
import MeilisearchSearchProvider from "./MeilisearchSearchProvider";

const semanticSearchConfigured =
  process.env.MEILISEARCH_SEMANTIC_SEARCH_ENABLED === "true" &&
  !!process.env.MEILISEARCH_EMBEDDING_URL &&
  !!process.env.MEILISEARCH_EMBEDDING_API_KEY;

const describeSemanticSearch = semanticSearchConfigured
  ? describe
  : describe.skip;

describeSemanticSearch("Meilisearch semantic search", () => {
  let document: Document | undefined;
  let user: User | undefined;
  const provider = new MeilisearchSearchProvider();

  beforeAll(() => {
    server.use(
      http.all(`${env.MEILISEARCH_URL}/*`, () => passthrough()),
      http.all(`${env.MEILISEARCH_EMBEDDING_URL}/*`, () => passthrough())
    );
  });

  afterEach(async () => {
    if (!document || !user) {
      return;
    }
    await provider.remove(
      SearchableModel.Document,
      document.id,
      document.teamId
    );
    await document.destroy({ force: true });
    if (document.collectionId) {
      await Collection.destroy({
        force: true,
        where: { id: document.collectionId },
      });
    }
    await User.destroy({ force: true, where: { id: user.id } });
    await AuthenticationProvider.destroy({
      force: true,
      where: { teamId: user.teamId },
    });
    await Team.destroy({ force: true, where: { id: user.teamId } });
    document = undefined;
    user = undefined;
  });

  it("indexes a document chunk and returns the document through the provider", async () => {
    user = await buildUser();
    const query = `语义索引验证${randomUUID()}`;
    document = await buildDocument({
      teamId: user.teamId,
      text: `这是用于 ${query} 的测试文档正文。`,
      title: "语义搜索测试",
      userId: user.id,
    });

    await provider.index(SearchableModel.Document, document);
    await provider.updateMetadata(SearchableModel.Document, document.id, {});

    const settingsResponse = await fetch(
      `${env.MEILISEARCH_URL}/indexes/${env.MEILISEARCH_INDEX_PREFIX}_documents/settings`,
      {
        headers: {
          Authorization: `Bearer ${env.MEILISEARCH_API_KEY}`,
        },
      }
    );
    expect(settingsResponse.ok).toBe(true);
    await expect(settingsResponse.json()).resolves.toMatchObject({
      localizedAttributes: [
        {
          attributePatterns: ["title", "previousTitles", "text"],
          locales: env.MEILISEARCH_LOCALES,
        },
      ],
    });

    const embeddings = new EmbeddingClient({
      apiKey: env.MEILISEARCH_EMBEDDING_API_KEY ?? "",
      dimensions: env.MEILISEARCH_EMBEDDING_DIMENSIONS,
      model: env.MEILISEARCH_EMBEDDING_MODEL,
      url: env.MEILISEARCH_EMBEDDING_URL ?? "",
    });
    const [vector] = await embeddings.embed([query]);
    const client = new MeilisearchClient({
      apiKey: env.MEILISEARCH_API_KEY ?? "",
      indexPrefix: env.MEILISEARCH_INDEX_PREFIX,
      url: env.MEILISEARCH_URL ?? "",
    });
    const chunks = await client.search("document_chunks", {
      filter: [`teamId = ${JSON.stringify(user.teamId)}`],
      hybrid: {
        embedder: "default",
        semanticRatio: 1,
      },
      limit: 10,
      offset: 0,
      vector,
    });
    const results = await provider.searchForUser(user, { query });
    const titleResults = await provider.searchTitlesForUser(user, {
      query: "语义搜索测试",
    });

    expect(chunks.hits.map((hit) => hit.documentId)).toContain(document.id);
    expect(results.results.map((result) => result.document.id)).toContain(
      document.id
    );
    expect(titleResults.map((result) => result.id)).toContain(document.id);
  }, 15_000);
});
