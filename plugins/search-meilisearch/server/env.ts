import { IsOptional, IsUrl } from "class-validator";
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
}

export default new MeilisearchPluginEnvironment();
