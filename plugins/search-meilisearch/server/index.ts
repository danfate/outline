import { Hook, PluginManager } from "@server/utils/PluginManager";
import config from "../plugin.json";
import env from "./env";
import MeilisearchIndexProcessor from "./MeilisearchIndexProcessor";
import MeilisearchSearchProvider from "./MeilisearchSearchProvider";

if (env.MEILISEARCH_URL && env.MEILISEARCH_API_KEY) {
  PluginManager.add([
    {
      ...config,
      type: Hook.SearchProvider,
      value: new MeilisearchSearchProvider(),
    },
    {
      ...config,
      type: Hook.Processor,
      value: MeilisearchIndexProcessor,
    },
  ]);
}
