import Logger from "@server/logging/Logger";
import Redis from "@server/storage/redis";
import env from "./env";
import MeilisearchSearchProvider from "./MeilisearchSearchProvider";

async function main() {
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

void main().catch((error: Error) => {
  Logger.error("Failed to rebuild Meilisearch indexes", error);
  process.exitCode = 1;
});
