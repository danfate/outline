import { randomUUID } from "node:crypto";
import invariant from "invariant";
import { Op } from "sequelize";
import { DirectionFilter, SearchableModel, StatusFilter } from "@shared/types";
import { sleep } from "@shared/utils/timers";
import type { SortFilter } from "@shared/types";
import type Collection from "@server/models/Collection";
import type Comment from "@server/models/Comment";
import Document from "@server/models/Document";
import type Team from "@server/models/Team";
import type User from "@server/models/User";
import { DocumentHelper } from "@server/models/helpers/DocumentHelper";
import type Share from "@server/models/Share";
import Redis from "@server/storage/redis";
import type {
  SearchOptions,
  SearchResponse,
} from "@server/utils/BaseSearchProvider";
import { BaseSearchProvider } from "@server/utils/BaseSearchProvider";
import PostgresSearchProvider from "plugins/search-postgres/server/PostgresSearchProvider";
import env from "./env";
import { MeilisearchClient, type MeilisearchHit } from "./MeilisearchClient";

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
  private static readonly INDEX_LOCK_TTL = 60_000;

  public id = "meilisearch";

  private readonly client = new MeilisearchClient({
    apiKey: env.MEILISEARCH_API_KEY ?? "",
    indexPrefix: env.MEILISEARCH_INDEX_PREFIX,
    url: env.MEILISEARCH_URL ?? "",
  });

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
    const { limit = 15, offset = 0, query } = options;
    const filters = this.documentFilters(team.id, options);
    filters.push("isDeleted = false", "isDraft = false");

    const documentIds = await this.shareDocumentIds(options.share);
    if (documentIds) {
      filters.push(this.inFilter("id", documentIds));
    } else if (!options.share?.collectionId) {
      const collectionIds = await team.collectionIds();
      filters.push(this.inFilter("collectionId", collectionIds));
    }

    const response = await this.client.search("documents", {
      attributesToCrop: ["text:45"],
      attributesToHighlight: ["text"],
      filter: filters,
      limit,
      offset,
      query,
      sort: this.sort(options.sort, options.direction),
    });
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
    const { limit = 15, offset = 0, query } = options;
    const response = await this.client.search("documents", {
      attributesToCrop: ["text:45"],
      attributesToHighlight: ["text"],
      filter: await this.userDocumentFilters(user, options),
      limit,
      offset,
      query,
      sort: this.sort(options.sort, options.direction),
    });
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
        return;
      }
      await this.client.addDocuments("documents", [
        this.documentRecord(document),
      ]);
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
        paranoid: false,
      });
      if (!document) {
        await this.remove(model, id, "");
        return;
      }
      await this.index(model, document);
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
   * Rebuilds both Meilisearch indexes and atomically publishes them.
   *
   * @returns a promise that resolves after the new indexes are active.
   */
  public async rebuild(): Promise<void> {
    await this.withIndexLock(async () => {
      await this.ensureIndexes();
      const suffix = `rebuild_${Date.now()}`;
      const documentIndex = `documents_${suffix}`;
      const collectionIndex = `collections_${suffix}`;

      await Promise.all([
        this.prepareIndex(documentIndex, this.documentSettings()),
        this.prepareIndex(collectionIndex, this.collectionSettings()),
      ]);
      await Promise.all([
        this.rebuildDocuments(documentIndex),
        this.rebuildCollections(collectionIndex),
      ]);
      await this.client.swapIndexes("documents", documentIndex);
      await this.client.swapIndexes("collections", collectionIndex);
      await Promise.all([
        this.client.deleteIndex(documentIndex),
        this.client.deleteIndex(collectionIndex),
      ]);
    });
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
    ]);
  }

  private prepareIndex(index: string, settings: Record<string, string[]>) {
    return this.client
      .createIndex(index)
      .then(() => this.client.updateSettings(index, settings));
  }

  private documentSettings(): Record<string, string[]> {
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

  private collectionSettings(): Record<string, string[]> {
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
          context: hit._formatted?.text,
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
