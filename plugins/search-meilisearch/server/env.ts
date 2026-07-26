import { IsBoolean, IsInt, IsOptional, IsUrl, Min } from "class-validator";
import { Environment } from "@server/env";
import environment from "@server/utils/environment";

/**
 * Parses the configured Meilisearch locales.
 *
 * @param value - a comma-separated locale configuration value.
 * @returns the configured locales or the default Chinese and English locales.
 */
export function parseMeilisearchLocales(value: string | undefined): string[] {
  const locales = value
    ?.split(",")
    .map((locale) => locale.trim())
    .filter(Boolean);

  return locales?.length ? locales : ["zho", "eng"];
}

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

  /** Locales used to tokenize indexed documents and keyword queries. */
  public MEILISEARCH_LOCALES = parseMeilisearchLocales(
    environment.MEILISEARCH_LOCALES
  );

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

  /** Maximum concurrent embedding requests during a full index rebuild. */
  @IsInt()
  @Min(1)
  public MEILISEARCH_EMBEDDING_CONCURRENCY =
    this.toOptionalNumber(environment.MEILISEARCH_EMBEDDING_CONCURRENCY) ?? 1;

  /** Maximum byte size for a document chunk indexing request. */
  @IsInt()
  @Min(1)
  public MEILISEARCH_DOCUMENT_CHUNK_MAX_PAYLOAD_BYTES =
    this.toOptionalNumber(
      environment.MEILISEARCH_DOCUMENT_CHUNK_MAX_PAYLOAD_BYTES
    ) ?? 5 * 1024 * 1024;

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
