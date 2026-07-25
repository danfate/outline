import { IsBoolean, IsInt, IsOptional, IsUrl, Min } from "class-validator";
import { Environment } from "@server/env";
import environment from "@server/utils/environment";

class MeilisearchPluginEnvironment extends Environment {
  /** The Meilisearch service URL. */
  @IsOptional()
  @IsUrl({
    require_tld: false,
    require_protocol: true,
    allow_underscores: true,
    protocols: ["http", "https"],
  })
  public MEILISEARCH_URL = this.toOptionalString(environment.MEILISEARCH_URL);

  /** The server-only Meilisearch API key. */
  @IsOptional()
  public MEILISEARCH_API_KEY = this.toOptionalString(
    environment.MEILISEARCH_API_KEY
  );

  /** Prefix for Meilisearch index UIDs. */
  @IsOptional()
  public MEILISEARCH_INDEX_PREFIX =
    this.toOptionalString(environment.MEILISEARCH_INDEX_PREFIX) ?? "outline";

  /** Whether semantic document search is enabled. */
  @IsBoolean()
  public MEILISEARCH_SEMANTIC_SEARCH_ENABLED = this.toBoolean(
    environment.MEILISEARCH_SEMANTIC_SEARCH_ENABLED ?? "false"
  );

  /** The OpenAI-compatible embedding API base URL. */
  @IsOptional()
  @IsUrl({
    require_tld: false,
    require_protocol: true,
    allow_underscores: true,
    protocols: ["http", "https"],
  })
  public MEILISEARCH_EMBEDDING_URL = this.toOptionalString(
    environment.MEILISEARCH_EMBEDDING_URL
  );

  /** The server-only embedding API key. */
  @IsOptional()
  public MEILISEARCH_EMBEDDING_API_KEY = this.toOptionalString(
    environment.MEILISEARCH_EMBEDDING_API_KEY
  );

  /** The embedding model name. */
  @IsOptional()
  public MEILISEARCH_EMBEDDING_MODEL =
    this.toOptionalString(environment.MEILISEARCH_EMBEDDING_MODEL) ??
    "BAAI/bge-m3";

  /** The number of dimensions produced by the embedding model. */
  @IsInt()
  @Min(1)
  public MEILISEARCH_EMBEDDING_DIMENSIONS =
    this.toOptionalNumber(environment.MEILISEARCH_EMBEDDING_DIMENSIONS) ?? 1024;

  /**
   * Whether the complete semantic search configuration is available.
   *
   * @returns whether semantic search can be initialized.
   * @throws when semantic search is enabled without its required settings.
   */
  public get semanticSearchEnabled(): boolean {
    if (!this.MEILISEARCH_SEMANTIC_SEARCH_ENABLED) {
      return false;
    }
    if (
      !this.MEILISEARCH_EMBEDDING_URL ||
      !this.MEILISEARCH_EMBEDDING_API_KEY ||
      !this.MEILISEARCH_EMBEDDING_MODEL
    ) {
      throw new Error(
        "MEILISEARCH_EMBEDDING_URL, MEILISEARCH_EMBEDDING_API_KEY, and MEILISEARCH_EMBEDDING_MODEL must be configured when semantic search is enabled"
      );
    }
    return true;
  }
}

export default new MeilisearchPluginEnvironment();
