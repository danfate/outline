import { SearchableModel } from "@shared/types";
import { Document } from "@server/models";
import BaseProcessor from "@server/queues/processors/BaseProcessor";
import type {
  DocumentGroupEvent,
  DocumentUserEvent,
  Event,
} from "@server/types";
import SearchProviderManager from "@server/utils/SearchProviderManager";
import env from "./env";

/**
 * Reindexes document membership changes that are specific to Meilisearch.
 */
export default class MeilisearchIndexProcessor extends BaseProcessor {
  public static applicableEvents: Event["name"][] = [
    "documents.add_user",
    "documents.remove_user",
    "documents.add_group",
    "documents.remove_group",
  ];

  /**
   * Avoids creating jobs unless Meilisearch is the active search provider.
   *
   * @param _event - the event being considered for indexing.
   * @returns whether to enqueue the event.
   */
  public static shouldQueue = async (_event: Event): Promise<boolean> =>
    env.SEARCH_PROVIDER === "meilisearch";

  /**
   * Reindexes a changed document and descendants inheriting its membership.
   *
   * @param event - the membership event to process.
   * @returns a promise that resolves once affected documents are indexed.
   */
  public async perform(event: Event): Promise<void> {
    if (
      event.name !== "documents.add_user" &&
      event.name !== "documents.remove_user" &&
      event.name !== "documents.add_group" &&
      event.name !== "documents.remove_group"
    ) {
      return;
    }

    const provider = SearchProviderManager.getProvider();
    if (provider.id !== "meilisearch") {
      return;
    }

    const documentId = (event as DocumentUserEvent | DocumentGroupEvent)
      .documentId;
    const document = await Document.findByPk(documentId, { paranoid: false });
    if (!document) {
      return;
    }

    const childDocumentIds = await document.findAllChildDocumentIds();
    const childDocuments = childDocumentIds.length
      ? await Document.findAll({ where: { id: childDocumentIds } })
      : [];
    for (const indexedDocument of [document, ...childDocuments]) {
      await provider.index(SearchableModel.Document, indexedDocument);
    }
  }
}
