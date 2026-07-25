import { randomUUID } from "node:crypto";
import invariant from "invariant";
import { Op } from "sequelize";
import { DirectionFilter, SearchableModel, StatusFilter } from "@shared/types";
import { toError } from "@shared/utils/error";
import { sleep } from "@shared/utils/timers";
import type { SortFilter } from "@shared/types";
import type Collection from "@server/models/Collection";
import type Comment from "@server/models/Comment";
import Document from "@server/models/Document";
import type Team from "@server/models/Team";
import type User from "@server/models/User";
import { DocumentHelper } from "@server/models/helpers/DocumentHelper";
import type Share from "@server/models/Share";
import Logger from "@server/logging/Logger";
import Redis from "@server/storage/redis";
import type {
  SearchOptions,
  SearchResponse,
} from "@server/utils/BaseSearchProvider";
import { BaseSearchProvider } from "@server/utils/BaseSearchProvider";
import PostgresSearchProvider from "plugins/search-postgres/server/PostgresSearchProvider";
import { EmbeddingClient } from "./EmbeddingClient";
import env from "./env";
import {
  MeilisearchClient,
  type MeilisearchHit,
  type MeilisearchIndexSettings,
  type MeilisearchSearchResponse,
} from "./MeilisearchClient";

interface DocumentIndexRecord {
  ancestorDocumentIds: string[];
  collectionId: string | null;
  collaboratorIds: string[];
  createdAt: number;
  createdById: string;
  id: string;
  isArchived: boolean;
  isDeleted: boolean;
  isDraft: boolean;
  isTemplate: boolean;
  isTrialImport: boolean;
  memberGroupIds: string[];
  memberUserIds: string[];
  previousTitles: string[];
  teamId: string;
  text: string;
  title: string;
  updatedAt: number;
}

interface DocumentChunkIndexRecord extends DocumentIndexRecord {
  chunkIndex: number;
  documentId: string;
  _vectors: {
    default: number[];
  };
}

interface DocumentChunkMetadata {
  ancestorDocumentIds: string[];
  collectionId: string | null;
  collaboratorIds: string[];
  createdAt: number;
  createdById: string;
  id: string;
  isArchived: boolean;
  isDeleted: boolean;
  isDraft: boolean;
  isTemplate: boolean;
  isTrialImport: boolean;
  memberGroupIds: string[];
  memberUserIds: string[];
  teamId: string;
  updatedAt: number;
}

interface CollectionIndexRecord {
  description: string;
  id: string;
  name: string;
  teamId: string;
  updatedAt: number;
}

/**
 * Search provider backed by Meilisearch with PostgreSQL authorization checks.
 */
export default class MeilisearchSearchProvider extends BaseSearchProvider {
  private static readonly EMBEDDING_BATCH_SIZE = 32;

  private static readonly INDEX_LOCK_TTL = 60_000;

  private static readonly KEYWORD_RRF_WEIGHT = 1.5;

  private static readonly RRF_CONSTANT = 60;

  private static readonly SEMANTIC_RRF_WEIGHT = 1;

  private static readonly TEXT_CHUNK_OVERLAP = 150;

  private static readonly TEXT_CHUNK_SIZE = 1_000;

  public id = "meilisearch";

  private readonly client = new MeilisearchClient({
    apiKey: env.MEILISEARCH_API_KEY ?? "",
    indexPrefix: env.MEILISEARCH_INDEX_PREFIX,
    url: env.MEILISEARCH_URL ?? "",
  });

  private readonly embeddings = env.semanticSearchEnabled
    ? new EmbeddingClient({
        apiKey: env.MEILISEARCH_EMBEDDING_API_KEY ?? "",
        dimensions: env.MEILISEARCH_EMBEDDING_DIMENSIONS,
        model: env.MEILISEARCH_EMBEDDING_MODEL,
        url: env.MEILISEARCH_EMBEDDING_URL ?? "",
      })
    : undefined;

  private initialization: Promise<void> | undefined;

  /**
   * Searches documents visible through a public share.
   *
   * @param team - the team owning the shared content.
   * @param options - search options.
   * @returns matching documents and the estimated total.
   */
  public async searchForTeam(
    team: Team,
    options: SearchOptions = {}
  ): Promise<SearchResponse> {
    await this.ensureIndexes();
    const filters = this.documentFilters(team.id, options);
    filters.push("isDeleted = false", "isDraft = false");

    const documentIds = await this.shareDocumentIds(options.share);
    if (documentIds) {
      filters.push(this.inFilter("id", documentIds));
    } else if (!options.share?.collectionId) {
      const collectionIds = await team.collectionIds();
      filters.push(this.inFilter("collectionId", collectionIds));
    }

    const response = await this.searchDocuments(filters, options);
    const ids = response.hits.map((hit) => hit.id);
    if (!ids.length) {
      return { results: [], total: response.estimatedTotalHits };
    }

    const where = await PostgresSearchProvider.buildWhere(team, {
      ...options,
      query: undefined,
      statusFilter: [...(options.statusFilter ?? []), StatusFilter.Published],
    });
    where[Op.and].push({ id: ids });
    const documents = await Document.unscoped().findAll({ where });

    return {
      results: this.toResults(response.hits, documents),
      total: response.estimatedTotalHits,
    };
  }

  /**
   * Searches document titles visible to a user.
   *
   * @param user - the searching user.
   * @param options - search options.
   * @returns matching documents.
   */
  public async searchTitlesForUser(
    user: User,
    options: SearchOptions = {}
  ): Promise<Document[]> {
    await this.ensureIndexes();
    const { limit = 15, offset = 0, query } = options;
    const response = await this.client.search("documents", {
      attributesToSearch: ["title", "previousTitles"],
      filter: await this.userDocumentFilters(user, options),
      limit,
      offset,
      query,
      sort: this.sort(options.sort, options.direction),
    });

    return this.authorizedDocuments(user, response.hits, options);
  }

  /**
   * Searches collections visible to a user.
   *
   * @param user - the searching user.
   * @param options - search options.
   * @returns matching collections.
   */
  public async searchCollectionsForUser(
    user: User,
    options: SearchOptions = {}
  ): Promise<Collection[]> {
    await this.ensureIndexes();
    const { limit = 15, offset = 0, query } = options;
    const collectionIds = await user.collectionIds();
    if (!collectionIds.length) {
      return [];
    }

    const response = await this.client.search("collections", {
      filter: [
        `teamId = ${this.filterValue(user.teamId)}`,
        this.inFilter("id", collectionIds),
      ],
      limit,
      offset,
      query,
      sort: this.sort(options.sort, options.direction),
    });
    const ids = response.hits.map((hit) => hit.id);
    if (!ids.length) {
      return [];
    }

    const collections = await (
      await import("@server/models/Collection")
    ).default.findAll({
      where: {
        id: ids,
        teamId: user.teamId,
      },
    });
    return this.orderByHits(response.hits, collections);
  }

  /**
   * Searches documents visible to a user.
   *
   * @param user - the searching user.
   * @param options - search options.
   * @returns matching documents and the estimated total.
   */
  public async searchForUser(
    user: User,
    options: SearchOptions = {}
  ): Promise<SearchResponse> {
    await this.ensureIndexes();
    const response = await this.searchDocuments(
      await this.userDocumentFilters(user, options),
      options
    );
    const documents = await this.authorizedDocuments(
      user,
      response.hits,
      options
    );

    return {
      results: this.toResults(response.hits, documents),
      total: response.estimatedTotalHits,
    };
  }

  /**
   * Writes a searchable item to Meilisearch.
   *
   * @param model - the indexed model type.
   * @param item - the model instance to index.
   */
  public async index(
    model: SearchableModel,
    item: Document | Collection | Comment
  ): Promise<void> {
    await this.withIndexLock(async () => {
      await this.ensureIndexes();
      if (model === SearchableModel.Comment) {
        return;
      }
      if (model === SearchableModel.Collection) {
        const CollectionModel = (await import("@server/models/Collection"))
          .default;
        const collection = await CollectionModel.unscoped().findByPk(item.id);
        if (!collection) {
          return;
        }
        await this.client.addDocuments("collections", [
          this.collectionRecord(collection),
        ]);
        return;
      }

      const document = await Document.unscoped().findByPk(item.id, {
        include: [
          { association: "memberships", required: false },
          { association: "groupMemberships", required: false },
        ],
        paranoid: false,
      });
      if (!document || document.deletedAt) {
        await this.client.deleteDocument("documents", item.id);
        if (this.embeddings) {
          await this.client.deleteDocumentsByFilter(
            "document_chunks",
            `documentId = ${this.filterValue(item.id)}`
          );
        }
        return;
      }
      await this.client.addDocuments("documents", [
        this.documentRecord(document),
      ]);
      if (this.embeddings) {
        await this.replaceDocumentChunks(document);
      }
    });
  }

  /**
   * Removes an item from Meilisearch.
   *
   * @param model - the indexed model type.
   * @param id - the model identifier.
   * @param _teamId - unused.
   */
  public async remove(
    model: SearchableModel,
    id: string,
    _teamId: string
  ): Promise<void> {
    await this.withIndexLock(async () => {
      await this.ensureIndexes();
      if (model === SearchableModel.Document) {
        await this.client.deleteDocument("documents", id);
        if (this.embeddings) {
          await this.client.deleteDocumentsByFilter(
            "document_chunks",
            `documentId = ${this.filterValue(id)}`
          );
        }
        return;
      }
      if (model === SearchableModel.Collection) {
        await this.client.deleteDocument("collections", id);
      }
    });
  }

  /**
   * Refreshes an item's index record after metadata changes.
   *
   * @param model - the indexed model type.
   * @param id - the model identifier.
   * @param _metadata - metadata already persisted in PostgreSQL.
   */
  public async updateMetadata(
    model: SearchableModel,
    id: string,
    _metadata: Record<string, unknown>
  ): Promise<void> {
    if (model === SearchableModel.Comment) {
      return;
    }
    if (model === SearchableModel.Document) {
      const document = await Document.unscoped().findByPk(id, {
        include: [
          { association: "memberships", required: false },
          { association: "groupMemberships", required: false },
        ],
        paranoid: false,
      });
      if (!document) {
        await this.remove(model, id, "");
        return;
      }
      if (document.deletedAt) {
        await this.remove(model, id, "");
        return;
      }
      await this.withIndexLock(async () => {
        await this.ensureIndexes();
        await this.client.addDocuments("documents", [
          this.documentRecord(document),
        ]);
        if (this.embeddings) {
          await this.updateDocumentChunkMetadata(document);
        }
      });
      return;
    }

    const CollectionModel = (await import("@server/models/Collection")).default;
    const collection = await CollectionModel.unscoped().findByPk(id, {
      paranoid: false,
    });
    if (!collection) {
      await this.remove(model, id, "");
      return;
    }
    await this.index(model, collection);
  }

  /**
   * Rebuilds the Meilisearch indexes and atomically publishes them.
   *
   * @returns a promise that resolves after the new indexes are active.
   */
  public async rebuild(): Promise<void> {
    await this.withIndexLock(async () => {
      await this.ensureIndexes();
      const suffix = `rebuild_${Date.now()}`;
      const documentIndex = `documents_${suffix}`;
      const collectionIndex = `collections_${suffix}`;
      const chunkIndex = `document_chunks_${suffix}`;
      const indexes: [string, string][] = [
        ["documents", documentIndex],
        ["collections", collectionIndex],
      ];
      if (this.embeddings) {
        indexes.push(["document_chunks", chunkIndex]);
      }

      try {
        await Promise.all([
          this.prepareIndex(documentIndex, this.documentSettings()),
          this.prepareIndex(collectionIndex, this.collectionSettings()),
          this.embeddings
            ? this.prepareIndex(chunkIndex, this.documentChunkSettings())
            : Promise.resolve(),
        ]);
        await Promise.all([
          this.rebuildDocuments(documentIndex),
          this.rebuildCollections(collectionIndex),
          this.embeddings
            ? this.rebuildDocumentChunks(chunkIndex)
            : Promise.resolve(),
        ]);
        await this.client.swapIndexes(indexes);
      } finally {
        await Promise.all(
          indexes.map(([, temporaryIndex]) =>
            this.client.deleteIndex(temporaryIndex).catch(() => undefined)
          )
        );
      }
    });
  }

  private async searchDocuments(
    filters: string[],
    options: SearchOptions
  ): Promise<MeilisearchSearchResponse> {
    const { limit = 15, offset = 0, query } = options;
    const shouldUseSemanticSearch =
      !!this.embeddings && !!query?.trim() && !options.sort;
    const candidateLimit = shouldUseSemanticSearch
      ? Math.max(50, (offset + limit) * 3)
      : limit;
    const keywordResponse = await this.client.search("documents", {
      attributesToCrop: ["text:45"],
      attributesToHighlight: ["text"],
      filter: filters,
      limit: candidateLimit,
      offset: shouldUseSemanticSearch ? 0 : offset,
      query,
      sort: this.sort(options.sort, options.direction),
    });
    if (!shouldUseSemanticSearch || !this.embeddings || !query) {
      return keywordResponse;
    }

    try {
      const [vector] = await this.embed([query]);
      const semanticResponse = await this.client.search("document_chunks", {
        attributesToCrop: ["text:45"],
        attributesToHighlight: ["text"],
        filter: this.documentChunkFilters(filters),
        hybrid: {
          embedder: "default",
          semanticRatio: 1,
        },
        limit: candidateLimit,
        offset: 0,
        vector,
      });
      const hits = this.fuseHits(
        keywordResponse.hits,
        semanticResponse.hits,
        query
      ).slice(offset, offset + limit);
      return {
        estimatedTotalHits: Math.max(
          keywordResponse.estimatedTotalHits,
          hits.length
        ),
        hits,
      };
    } catch (error) {
      Logger.error(
        "Meilisearch semantic search failed, using keyword search",
        toError(error)
      );
      return {
        ...keywordResponse,
        hits: keywordResponse.hits.slice(offset, offset + limit),
      };
    }
  }

  private fuseHits(
    keywordHits: MeilisearchHit[],
    semanticHits: MeilisearchHit[],
    query: string
  ): MeilisearchHit[] {
    const results = new Map<
      string,
      {
        hit: MeilisearchHit;
        score: number;
      }
    >();
    const normalizedQuery = query.trim().toLocaleLowerCase();

    keywordHits.forEach((hit, index) => {
      const exactTitle =
        hit.title?.trim().toLocaleLowerCase() === normalizedQuery ? 1 : 0;
      results.set(hit.id, {
        hit,
        score:
          MeilisearchSearchProvider.KEYWORD_RRF_WEIGHT /
            (MeilisearchSearchProvider.RRF_CONSTANT + index + 1) +
          exactTitle,
      });
    });

    const semanticDocuments = new Map<string, MeilisearchHit>();
    for (const hit of semanticHits) {
      if (hit.documentId && !semanticDocuments.has(hit.documentId)) {
        semanticDocuments.set(hit.documentId, {
          _formatted: hit._formatted,
          id: hit.documentId,
          text: hit.text,
        });
      }
    }
    for (const [index, hit] of [...semanticDocuments.values()].entries()) {
      const existing = results.get(hit.id);
      const score =
        MeilisearchSearchProvider.SEMANTIC_RRF_WEIGHT /
        (MeilisearchSearchProvider.RRF_CONSTANT + index + 1);
      if (existing) {
        existing.score += score;
      } else {
        results.set(hit.id, { hit, score });
      }
    }

    return [...results.values()]
      .sort((a, b) => b.score - a.score)
      .map((result) => result.hit);
  }

  private async authorizedDocuments(
    user: User,
    hits: MeilisearchHit[],
    options: SearchOptions
  ): Promise<Document[]> {
    const ids = hits.map((hit) => hit.id);
    if (!ids.length) {
      return [];
    }

    const where = await PostgresSearchProvider.buildWhere(user, {
      ...options,
      query: undefined,
    });
    where[Op.and].push({ id: ids });
    const documents = await Document.unscoped().findAll({
      include: this.userMembershipIncludes(user),
      subQuery: false,
      where,
    });
    const authorizedIds = documents.map((document) => document.id);
    const authorizedDocuments = await Document.withMembershipScope(user.id, {
      includeDrafts: true,
    }).findAll({
      where: {
        id: authorizedIds,
        teamId: user.teamId,
      },
    });
    return this.orderByHits(hits, authorizedDocuments);
  }

  private async ensureIndexes(): Promise<void> {
    if (!this.initialization) {
      this.initialization = this.initializeIndexes();
    }
    await this.initialization;
  }

  private async initializeIndexes(): Promise<void> {
    await Promise.all([
      this.prepareIndex("documents", this.documentSettings()),
      this.prepareIndex("collections", this.collectionSettings()),
      this.embeddings
        ? this.prepareIndex("document_chunks", this.documentChunkSettings())
        : Promise.resolve(),
    ]);
  }

  private prepareIndex(index: string, settings: MeilisearchIndexSettings) {
    return this.client
      .createIndex(index)
      .then(() => this.client.updateSettings(index, settings));
  }

  private documentSettings(): MeilisearchIndexSettings {
    return {
      filterableAttributes: [
        "collectionId",
        "collaboratorIds",
        "createdAt",
        "createdById",
        "id",
        "isArchived",
        "isDeleted",
        "isDraft",
        "isTemplate",
        "isTrialImport",
        "memberGroupIds",
        "memberUserIds",
        "teamId",
        "updatedAt",
      ],
      searchableAttributes: ["title", "previousTitles", "text"],
      sortableAttributes: ["createdAt", "title", "updatedAt"],
    };
  }

  private documentChunkSettings(): MeilisearchIndexSettings {
    return {
      embedders: {
        default: {
          dimensions: env.MEILISEARCH_EMBEDDING_DIMENSIONS,
          source: "userProvided",
        },
      },
      filterableAttributes: [
        "collectionId",
        "collaboratorIds",
        "createdAt",
        "createdById",
        "documentId",
        "isArchived",
        "isDeleted",
        "isDraft",
        "isTemplate",
        "isTrialImport",
        "memberGroupIds",
        "memberUserIds",
        "teamId",
        "updatedAt",
      ],
      searchableAttributes: ["title", "text"],
      sortableAttributes: ["createdAt", "title", "updatedAt"],
    };
  }

  private collectionSettings(): MeilisearchIndexSettings {
    return {
      filterableAttributes: ["id", "teamId"],
      searchableAttributes: ["name", "description"],
      sortableAttributes: ["name", "updatedAt"],
    };
  }

  private async rebuildDocuments(index: string): Promise<void> {
    const batchSize = 500;
    let offset = 0;

    while (true) {
      const documents = await Document.unscoped().findAll({
        include: [
          { association: "memberships", required: false },
          { association: "groupMemberships", required: false },
        ],
        limit: batchSize,
        offset,
        order: [["id", "ASC"]],
      });
      await this.client.addDocuments(
        index,
        documents.map((document) => this.documentRecord(document))
      );
      if (documents.length < batchSize) {
        return;
      }
      offset += batchSize;
    }
  }

  private async rebuildCollections(index: string): Promise<void> {
    const CollectionModel = (await import("@server/models/Collection")).default;
    const batchSize = 500;
    let offset = 0;

    while (true) {
      const collections = await CollectionModel.unscoped().findAll({
        limit: batchSize,
        offset,
        order: [["id", "ASC"]],
      });
      await this.client.addDocuments(
        index,
        collections.map((collection) => this.collectionRecord(collection))
      );
      if (collections.length < batchSize) {
        return;
      }
      offset += batchSize;
    }
  }

  private async rebuildDocumentChunks(index: string): Promise<void> {
    const batchSize = 50;
    let offset = 0;

    while (true) {
      const documents = await Document.unscoped().findAll({
        include: [
          { association: "memberships", required: false },
          { association: "groupMemberships", required: false },
        ],
        limit: batchSize,
        offset,
        order: [["id", "ASC"]],
      });
      const chunks = await Promise.all(
        documents.map((document) => this.documentChunkRecords(document))
      );
      await this.client.addDocuments(index, chunks.flat());
      if (documents.length < batchSize) {
        return;
      }
      offset += batchSize;
    }
  }

  private async replaceDocumentChunks(document: Document): Promise<void> {
    const chunks = await this.documentChunkRecords(document);
    await this.client.deleteDocumentsByFilter(
      "document_chunks",
      `documentId = ${this.filterValue(document.id)}`
    );
    await this.client.addDocuments("document_chunks", chunks);
  }

  private async updateDocumentChunkMetadata(document: Document): Promise<void> {
    const batchSize = 1_000;
    let offset = 0;

    while (true) {
      const response = await this.client.search("document_chunks", {
        attributesToRetrieve: ["id"],
        filter: [`documentId = ${this.filterValue(document.id)}`],
        limit: batchSize,
        offset,
        query: "",
      });
      await this.client.updateDocuments(
        "document_chunks",
        response.hits.map((hit) => ({
          ...this.documentChunkMetadata(document),
          id: hit.id,
        }))
      );
      if (response.hits.length < batchSize) {
        return;
      }
      offset += batchSize;
    }
  }

  private async documentChunkRecords(
    document: Document
  ): Promise<DocumentChunkIndexRecord[]> {
    const chunks = this.textChunks(DocumentHelper.toPlainText(document));
    const vectors = await this.embed(
      chunks.map((chunk) => `${document.title}\n\n${chunk}`)
    );
    const record = this.documentRecord(document);
    return chunks.map((text, chunkIndex) => ({
      ...record,
      _vectors: { default: vectors[chunkIndex] },
      chunkIndex,
      documentId: document.id,
      id: `${document.id}_${chunkIndex}`,
      text,
    }));
  }

  private documentChunkMetadata(document: Document): DocumentChunkMetadata {
    const record = this.documentRecord(document);
    return {
      ancestorDocumentIds: record.ancestorDocumentIds,
      collectionId: record.collectionId,
      collaboratorIds: record.collaboratorIds,
      createdAt: record.createdAt,
      createdById: record.createdById,
      id: "",
      isArchived: record.isArchived,
      isDeleted: record.isDeleted,
      isDraft: record.isDraft,
      isTemplate: record.isTemplate,
      isTrialImport: record.isTrialImport,
      memberGroupIds: record.memberGroupIds,
      memberUserIds: record.memberUserIds,
      teamId: record.teamId,
      updatedAt: record.updatedAt,
    };
  }

  private async embed(input: string[]): Promise<number[][]> {
    if (!this.embeddings) {
      throw new Error("Semantic search is not enabled");
    }

    const vectors: number[][] = [];
    for (
      let offset = 0;
      offset < input.length;
      offset += MeilisearchSearchProvider.EMBEDDING_BATCH_SIZE
    ) {
      vectors.push(
        ...(await this.embeddings.embed(
          input.slice(
            offset,
            offset + MeilisearchSearchProvider.EMBEDDING_BATCH_SIZE
          )
        ))
      );
    }
    return vectors;
  }

  private textChunks(text: string): string[] {
    const chunks: string[] = [];
    let start = 0;

    while (start < text.length) {
      let end = Math.min(
        start + MeilisearchSearchProvider.TEXT_CHUNK_SIZE,
        text.length
      );
      if (end < text.length) {
        const boundary = text.lastIndexOf(" ", end);
        if (boundary > start + MeilisearchSearchProvider.TEXT_CHUNK_SIZE / 2) {
          end = boundary;
        }
      }
      const chunk = text.slice(start, end).trim();
      if (chunk) {
        chunks.push(chunk);
      }
      start = Math.max(
        end - MeilisearchSearchProvider.TEXT_CHUNK_OVERLAP,
        start + 1
      );
    }
    return chunks;
  }

  private async userDocumentFilters(user: User, options: SearchOptions) {
    const [collectionIds, groupIds] = await Promise.all([
      user.collectionIds(),
      user.groupIds(),
    ]);
    const accessFilters = [
      collectionIds.length ? this.inFilter("collectionId", collectionIds) : "",
      `memberUserIds = ${this.filterValue(user.id)}`,
      groupIds.length ? this.inFilter("memberGroupIds", groupIds) : "",
    ].filter(Boolean);
    if (options.statusFilter?.includes(StatusFilter.Draft)) {
      accessFilters.push(
        `isDraft = true AND collectionId IS NULL AND createdById = ${this.filterValue(user.id)}`
      );
    }
    const filters = this.documentFilters(user.teamId, options);
    filters.push(`(${accessFilters.join(" OR ")})`);
    return filters;
  }

  private documentFilters(teamId: string, options: SearchOptions) {
    const filters = [
      `teamId = ${this.filterValue(teamId)}`,
      "isDeleted = false",
      "isTemplate = false",
      "isTrialImport = false",
    ];
    if (options.collectionId) {
      filters.push(`collectionId = ${this.filterValue(options.collectionId)}`);
    }
    if (options.documentIds?.length) {
      filters.push(this.inFilter("id", options.documentIds));
    }
    if (options.collaboratorIds?.length) {
      filters.push(
        this.containsAllFilter("collaboratorIds", options.collaboratorIds)
      );
    }
    if (options.dateFilter) {
      const milliseconds = {
        day: 86_400_000,
        week: 604_800_000,
        month: 2_592_000_000,
        year: 31_536_000_000,
      }[options.dateFilter];
      filters.push(`updatedAt > ${Date.now() - milliseconds}`);
    }
    if (options.statusFilter?.length) {
      const statuses = options.statusFilter.map((status) => {
        if (status === StatusFilter.Archived) {
          return "isArchived = true";
        }
        if (status === StatusFilter.Draft) {
          return "isDraft = true AND isArchived = false";
        }
        return "isDraft = false AND isArchived = false";
      });
      filters.push(`(${statuses.join(" OR ")})`);
    }
    return filters;
  }

  private documentChunkFilters(filters: string[]) {
    return filters.map((filter) =>
      filter.startsWith("id IN [")
        ? filter.replace("id IN [", "documentId IN [")
        : filter
    );
  }

  private async shareDocumentIds(share: Share | undefined) {
    if (!share) {
      return undefined;
    }
    if (share.collectionId) {
      return undefined;
    }
    if (!share.documentId || !share.includeChildDocuments) {
      return [];
    }
    const document = await share.$get("document");
    invariant(document, "Cannot find document for share");
    return [
      document.id,
      ...(await document.findAllChildDocumentIds({
        archivedAt: { [Op.is]: null },
      })),
    ];
  }

  private documentRecord(document: Document): DocumentIndexRecord {
    return {
      ancestorDocumentIds: [],
      collectionId: document.collectionId ?? null,
      collaboratorIds: document.collaboratorIds,
      createdAt: document.createdAt.getTime(),
      createdById: document.createdById,
      id: document.id,
      isArchived: !!document.archivedAt,
      isDeleted: !!document.deletedAt,
      isDraft: !document.publishedAt,
      isTemplate: document.template,
      isTrialImport: !!document.sourceMetadata?.trial,
      memberGroupIds: document.groupMemberships.map(
        (membership) => membership.groupId
      ),
      memberUserIds: document.memberships.map(
        (membership) => membership.userId
      ),
      previousTitles: document.previousTitles ?? [],
      teamId: document.teamId,
      text: DocumentHelper.toPlainText(document),
      title: document.title,
      updatedAt: document.updatedAt.getTime(),
    };
  }

  private collectionRecord(collection: Collection): CollectionIndexRecord {
    return {
      description: collection.description ?? "",
      id: collection.id,
      name: collection.name,
      teamId: collection.teamId,
      updatedAt: collection.updatedAt.getTime(),
    };
  }

  private userMembershipIncludes(user: User) {
    return [
      {
        association: "memberships",
        where: { userId: user.id },
        required: false,
        separate: false,
      },
      {
        association: "groupMemberships",
        required: false,
        separate: false,
        include: [
          {
            association: "group",
            required: true,
            include: [
              {
                association: "groupUsers",
                required: true,
                where: { userId: user.id },
              },
            ],
          },
        ],
      },
    ];
  }

  private async withIndexLock<T>(callback: () => Promise<T>): Promise<T> {
    const token = randomUUID();
    const key = `meilisearch:index-lock:${env.MEILISEARCH_INDEX_PREFIX}`;

    while (
      (await Redis.defaultClient.set(
        key,
        token,
        "PX",
        MeilisearchSearchProvider.INDEX_LOCK_TTL,
        "NX"
      )) !== "OK"
    ) {
      await sleep(100);
    }

    const renewal = setInterval(() => {
      void Redis.defaultClient
        .eval(
          "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) end return 0",
          1,
          key,
          token,
          String(MeilisearchSearchProvider.INDEX_LOCK_TTL)
        )
        .catch(() => undefined);
    }, MeilisearchSearchProvider.INDEX_LOCK_TTL / 3);

    try {
      return await callback();
    } finally {
      clearInterval(renewal);
      await Redis.defaultClient.eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0",
        1,
        key,
        token
      );
    }
  }

  private toResults(hits: MeilisearchHit[], documents: Document[]) {
    const documentsById = new Map(
      documents.map((document) => [document.id, document])
    );
    return hits.flatMap((hit, index) => {
      const document = documentsById.get(hit.id);
      if (!document) {
        return [];
      }
      return [
        {
          context: hit._formatted?.text ?? hit.text,
          document,
          ranking: hits.length - index,
        },
      ];
    });
  }

  private orderByHits<T extends { id: string }>(
    hits: MeilisearchHit[],
    items: T[]
  ): T[] {
    const itemsById = new Map(items.map((item) => [item.id, item]));
    return hits.flatMap((hit) => {
      const item = itemsById.get(hit.id);
      return item ? [item] : [];
    });
  }

  private sort(sort?: SortFilter, direction?: DirectionFilter) {
    if (!sort) {
      return undefined;
    }
    return [`${sort}:${(direction ?? DirectionFilter.DESC).toLowerCase()}`];
  }

  private inFilter(field: string, values: string[]) {
    return `${field} IN [${values.map((value) => this.filterValue(value)).join(", ")}]`;
  }

  private containsAllFilter(field: string, values: string[]) {
    return values
      .map((value) => `${field} = ${this.filterValue(value)}`)
      .join(" AND ");
  }

  private filterValue(value: string) {
    return JSON.stringify(value);
  }
}
