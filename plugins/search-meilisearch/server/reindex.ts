import Logger from "@server/logging/Logger";
import Redis from "@server/storage/redis";
import env from "./env";
import MeilisearchSearchProvider from "./MeilisearchSearchProvider";

/** Normalized command-line options for the Meilisearch reindex task. */
export interface ReindexOptions {
  fresh: boolean;
  status: boolean;
}

/**
 * Parses the command-line options supported by the Meilisearch reindex task.
 *
 * @param args - arguments supplied after the executable name.
 * @returns normalized reindex options.
 * @throws when an unsupported or incompatible option is provided.
 */
export function parseReindexOptions(args: string[]): ReindexOptions {
  const options: ReindexOptions = {
    fresh: false,
    status: false,
  };

  for (const arg of args) {
    if (arg === "--fresh") {
      options.fresh = true;
      continue;
    }
    if (arg === "--status") {
      options.status = true;
      continue;
    }
    throw new Error(`Unsupported Meilisearch reindex option: ${arg}`);
  }
  if (options.fresh && options.status) {
    throw new Error("--fresh and --status cannot be used together");
  }
  return options;
}

/**
 * Rebuilds Meilisearch indexes from the current Outline database.
 *
 * @returns a promise that resolves after the indexes are rebuilt.
 * @throws when Meilisearch configuration or indexing fails.
 */
export async function main(args = process.argv.slice(2)): Promise<void> {
  if (!env.MEILISEARCH_URL || !env.MEILISEARCH_API_KEY) {
    throw new Error(
      "MEILISEARCH_URL and MEILISEARCH_API_KEY must be configured"
    );
  }

  try {
    const options = parseReindexOptions(args);
    const provider = new MeilisearchSearchProvider();
    if (options.status) {
      const state = await provider.getRebuildStatus();
      Logger.info(
        "plugins",
        state
          ? "Meilisearch index rebuild is pending"
          : "No Meilisearch index rebuild is pending",
        state
      );
      return;
    }
    await provider.rebuild({ fresh: options.fresh });
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
