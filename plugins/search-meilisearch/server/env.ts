import { IsOptional, IsUrl } from "class-validator";
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
}

export default new MeilisearchPluginEnvironment();
