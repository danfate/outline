import Logger from "@server/logging/Logger";
import Redis from "@server/storage/redis";
import env from "./env";
import MeilisearchSearchProvider from "./MeilisearchSearchProvider";

/**
 * Rebuilds Meilisearch indexes from the current Outline database.
 *
 * @returns a promise that resolves after the indexes are rebuilt.
 * @throws when Meilisearch configuration or indexing fails.
 */
export async function main(): Promise<void> {
  if (!env.MEILISEARCH_URL || !env.MEILISEARCH_API_KEY) {
    throw new Error(
      "MEILISEARCH_URL and MEILISEARCH_API_KEY must be configured"
    );
  }

  try {
    await new MeilisearchSearchProvider().rebuild();
    Logger.info("plugins", "Meilisearch indexes rebuilt");
  } finally {
    Redis.defaultClient.disconnect();
  }
}

if (process.argv[1]?.endsWith("reindex.js")) {
  void main().catch((error: Error) => {
    Logger.error("Failed to rebuild Meilisearch indexes", error);
    process.exitCode = 1;
  });
}
