// @vitest-isolate true
// Opt in with MEILISEARCH_INTEGRATION_TESTS=1. DATABASE_SCHEMA and
// MEILISEARCH_TEST_INDEX_PREFIX must be unique outline_cjk_test_<hex> names.
// DATABASE_URL must set its connection search_path to that schema,public.
// Provide MEILISEARCH_TEST_URL and MEILISEARCH_TEST_API_KEY, leaving the regular
// MEILISEARCH_URL and MEILISEARCH_API_KEY empty while test setup imports plugins.
// Only the isolated schema and indexes are created and removed by this suite.
import fs from "node:fs";
import path from "node:path";
import { http, passthrough } from "msw";
import { SearchableModel, UserRole } from "@shared/types";
import { migrations, sequelize } from "@server/storage/database";
import {
  buildCollection,
  buildDocument,
  buildPersonalCollection,
  buildTeam,
  buildUser,
} from "@server/test/factories";
import { server } from "@server/test/msw";
import env from "./env";
import { MeilisearchClient } from "./MeilisearchClient";
import MeilisearchSearchProvider from "./MeilisearchSearchProvider";

describe.skipIf(process.env.MEILISEARCH_INTEGRATION_TESTS !== "1")(
  "Meilisearch personal document visibility",
  () => {
    let provider: MeilisearchSearchProvider;
    let client: MeilisearchClient;
    let owner: Awaited<ReturnType<typeof buildUser>>;
    let member: Awaited<ReturnType<typeof buildUser>>;
    let admin: Awaited<ReturnType<typeof buildUser>>;
    let personal: Awaited<ReturnType<typeof buildPersonalCollection>>;
    let shared: Awaited<ReturnType<typeof buildCollection>>;
    let document: Awaited<ReturnType<typeof buildDocument>>;
    let schemaCreated = false;
    let indexesCreated = false;

    beforeEach(() => {
      server.use(http.all(`${env.MEILISEARCH_URL}/*`, () => passthrough()));
    });

    beforeAll(async () => {
      const schema = process.env.DATABASE_SCHEMA;
      const url = process.env.MEILISEARCH_TEST_URL;
      const key = process.env.MEILISEARCH_TEST_API_KEY;
      const prefix = process.env.MEILISEARCH_TEST_INDEX_PREFIX;
      if (
        !schema?.match(/^outline_cjk_test_[a-f0-9]+$/) ||
        !prefix?.match(/^outline_cjk_test_[a-f0-9]+$/) ||
        !url ||
        !key
      ) {
        throw new Error(
          "Integration tests require isolated schema and index settings"
        );
      }

      env.MEILISEARCH_URL = url;
      env.MEILISEARCH_API_KEY = key;
      env.MEILISEARCH_INDEX_PREFIX = prefix;
      server.use(http.all(`${url}/*`, () => passthrough()));

      await sequelize.createSchema(schema, {});
      schemaCreated = true;
      const baseline = path.resolve("server/migrations/baseline");
      await sequelize.query(
        fs.readFileSync(path.join(baseline, "schema.sql"), "utf8")
      );
      await sequelize.query(
        `CREATE TABLE "${schema}"."SequelizeMeta" ("name" VARCHAR(255) PRIMARY KEY)`
      );
      await sequelize.query(
        `INSERT INTO "${schema}"."SequelizeMeta" SELECT json_array_elements_text($names::json)`,
        {
          bind: {
            names: fs.readFileSync(
              path.join(baseline, "migrations.json"),
              "utf8"
            ),
          },
        }
      );
      await migrations.up();

      const team = await buildTeam({ authenticationProviders: [] });
      owner = await buildUser({ teamId: team.id, role: UserRole.Member });
      member = await buildUser({ teamId: team.id, role: UserRole.Member });
      admin = await buildUser({ teamId: team.id, role: UserRole.Admin });
      personal = await buildPersonalCollection(owner);
      shared = await buildCollection({ teamId: team.id, userId: owner.id });
      document = await buildDocument({
        teamId: team.id,
        userId: owner.id,
        collectionId: personal.id,
        title: "CJK privacy regression",
        text: "这篇文档介绍进程间通信。",
      });

      provider = new MeilisearchSearchProvider();
      client = new MeilisearchClient({ apiKey: key, indexPrefix: prefix, url });
      await provider.index(SearchableModel.Collection, personal);
      indexesCreated = true;
      await provider.index(SearchableModel.Document, document);
    }, 120_000);

    afterAll(async () => {
      server.use(http.all(`${env.MEILISEARCH_URL}/*`, () => passthrough()));
      try {
        if (indexesCreated) {
          await Promise.all([
            client.deleteIndex("documents"),
            client.deleteIndex("collections"),
          ]);
        }
      } finally {
        if (schemaCreated) {
          const schema = process.env.DATABASE_SCHEMA;
          if (schema?.match(/^outline_cjk_test_[a-f0-9]+$/)) {
            await sequelize.dropSchema(schema, {});
          }
        }
      }
    }, 60_000);

    it("returns personal documents and collections only to their owner", async () => {
      for (const user of [owner, member, admin]) {
        const expected = user.id === owner.id ? [document.id] : [];
        const response = await provider.searchForUser(user, {
          query: "进程间通信",
        });
        expect(response.results.map((result) => result.document.id)).toEqual(
          expected
        );
        const titles = await provider.searchTitlesForUser(user, {
          query: "CJK",
        });
        expect(titles.map((entry) => entry.id)).toEqual(expected);
        const collections = await provider.searchCollectionsForUser(user, {
          query: "Personal",
        });
        expect(collections.map((entry) => entry.id)).toEqual(
          user.id === owner.id ? [personal.id] : []
        );
      }
    });

    it("revokes access even before a stale shared index record is refreshed", async () => {
      await document.update({ collectionId: shared.id });
      await provider.updateMetadata(SearchableModel.Document, document.id, {});
      expect(
        (await provider.searchForUser(member, { query: "CJK" })).results.map(
          (result) => result.document.id
        )
      ).toEqual([document.id]);

      await document.update({ collectionId: personal.id });
      expect(
        (await provider.searchForUser(member, { query: "CJK" })).results
      ).toEqual([]);
      expect(
        await provider.searchTitlesForUser(admin, { query: "CJK" })
      ).toEqual([]);

      await provider.updateMetadata(SearchableModel.Document, document.id, {});
      expect(
        (await provider.searchForUser(member, { query: "CJK" })).total
      ).toBe(0);
      expect(
        (await provider.searchForUser(owner, { query: "CJK" })).results.map(
          (result) => result.document.id
        )
      ).toEqual([document.id]);
    });

    it("removes the personal document from the index on permanent deletion", async () => {
      await provider.remove(
        SearchableModel.Document,
        document.id,
        owner.teamId
      );
      expect(
        (await provider.searchForUser(owner, { query: "CJK" })).results
      ).toEqual([]);
    });
  }
);
