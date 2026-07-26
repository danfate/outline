export interface MeilisearchClientOptions {
  apiKey: string;
  indexPrefix: string;
  url: string;
}

export interface MeilisearchSearchOptions {
  attributesToCrop?: string[];
  attributesToHighlight?: string[];
  attributesToRetrieve?: string[];
  attributesToSearchOn?: string[];
  filter?: string[];
  hybrid?: {
    embedder: string;
    semanticRatio: number;
  };
  limit: number;
  locales?: string[];
  offset: number;
  query?: string;
  sort?: string[];
  vector?: number[];
}

export interface MeilisearchHit {
  chunkIndex?: number;
  documentId?: string;
  _formatted?: {
    text?: string;
  };
  id: string;
  text?: string;
  title?: string;
}

export interface MeilisearchSearchResponse<
  THit extends MeilisearchHit = MeilisearchHit,
> {
  estimatedTotalHits: number;
  hits: THit[];
}

export interface MeilisearchEmbedderSettings {
  dimensions: number;
  source: "userProvided";
}

export interface MeilisearchIndexSettings {
  embedders?: Record<string, MeilisearchEmbedderSettings>;
  filterableAttributes: string[];
  localizedAttributes?: {
    attributePatterns: string[];
    locales: string[];
  }[];
  searchableAttributes: string[];
  sortableAttributes: string[];
}

interface MeilisearchTask {
  status: "enqueued" | "failed" | "processing" | "succeeded";
  taskUid: number;
  error?: {
    code?: string;
    message: string;
  };
}

interface MeilisearchSwapTask {
  details?: {
    swaps?: {
      indexes: string[];
    }[];
  };
  taskUid?: number;
  uid?: number;
}

interface MeilisearchTaskList {
  results: MeilisearchSwapTask[];
}

/**
 * Minimal Meilisearch HTTP client used by the search provider.
 */
export class MeilisearchClient {
  private static readonly TASK_POLL_INTERVAL = 100;

  private static readonly TASK_TIMEOUT = 300_000;

  private readonly apiKey: string;
  private readonly indexPrefix: string;
  private readonly url: string;

  /**
   * @param options - connection settings for the Meilisearch service.
   */
  public constructor(options: MeilisearchClientOptions) {
    this.apiKey = options.apiKey;
    this.indexPrefix = options.indexPrefix;
    this.url = options.url.replace(/\/$/, "");
  }

  /**
   * Creates an index when it does not already exist.
   *
   * @param index - the unprefixed index name.
   * @returns a promise that resolves after the index is available.
   */
  public async createIndex(index: string): Promise<void> {
    const response = await this.request<MeilisearchTask>("/indexes", {
      body: JSON.stringify({
        primaryKey: "id",
        uid: this.indexName(index),
      }),
      method: "POST",
      allowConflict: true,
    });
    if (response) {
      await this.waitForTask(response.taskUid, true);
    }
  }

  /**
   * Updates an index configuration.
   *
   * @param index - the unprefixed index name.
   * @param settings - the Meilisearch settings to apply.
   * @returns a promise that resolves after the settings are active.
   */
  public async updateSettings(
    index: string,
    settings: MeilisearchIndexSettings
  ): Promise<void> {
    const task = await this.request<MeilisearchTask>(
      `/indexes/${this.indexName(index)}/settings`,
      {
        body: JSON.stringify(settings),
        method: "PATCH",
      }
    );
    if (!task) {
      throw new Error("Meilisearch settings task was not created");
    }
    await this.waitForTask(task.taskUid);
  }

  /**
   * Adds or replaces documents in an index.
   *
   * @param index - the unprefixed index name.
   * @param documents - the documents to write.
   * @returns a promise that resolves after the documents are indexed.
   */
  public async addDocuments<T extends object>(
    index: string,
    documents: T[]
  ): Promise<void> {
    if (!documents.length) {
      return;
    }

    const task = await this.request<MeilisearchTask>(
      `/indexes/${this.indexName(index)}/documents`,
      {
        body: JSON.stringify(documents),
        method: "POST",
      }
    );
    if (!task) {
      throw new Error("Meilisearch document task was not created");
    }
    await this.waitForTask(task.taskUid);
  }

  /**
   * Updates fields on existing documents without replacing unspecified fields.
   *
   * @param index - the unprefixed index name.
   * @param documents - partial document records to update.
   * @returns a promise that resolves after the documents are indexed.
   */
  public async updateDocuments<T extends object>(
    index: string,
    documents: T[]
  ): Promise<void> {
    if (!documents.length) {
      return;
    }

    const task = await this.request<MeilisearchTask>(
      `/indexes/${this.indexName(index)}/documents`,
      {
        body: JSON.stringify(documents),
        method: "PUT",
      }
    );
    if (!task) {
      throw new Error("Meilisearch document update task was not created");
    }
    await this.waitForTask(task.taskUid);
  }

  /**
   * Deletes a document from an index.
   *
   * @param index - the unprefixed index name.
   * @param id - the document identifier.
   * @returns a promise that resolves after the document is removed.
   */
  public async deleteDocument(index: string, id: string): Promise<void> {
    const task = await this.request<MeilisearchTask>(
      `/indexes/${this.indexName(index)}/documents/${encodeURIComponent(id)}`,
      { method: "DELETE" }
    );
    if (!task) {
      throw new Error("Meilisearch document deletion task was not created");
    }
    await this.waitForTask(task.taskUid);
  }

  /**
   * Deletes every document matching a filter expression.
   *
   * @param index - the unprefixed index name.
   * @param filter - Meilisearch filter expression.
   * @returns a promise that resolves after matching documents are removed.
   */
  public async deleteDocumentsByFilter(
    index: string,
    filter: string
  ): Promise<void> {
    const task = await this.request<MeilisearchTask>(
      `/indexes/${this.indexName(index)}/documents/delete`,
      {
        body: JSON.stringify({ filter }),
        method: "POST",
      }
    );
    if (!task) {
      throw new Error("Meilisearch document deletion task was not created");
    }
    await this.waitForTask(task.taskUid);
  }

  /**
   * Deletes an index and all of its documents.
   *
   * @param index - the unprefixed index name.
   * @returns a promise that resolves after the index is removed.
   */
  public async deleteIndex(index: string): Promise<void> {
    const task = await this.request<MeilisearchTask>(
      `/indexes/${this.indexName(index)}`,
      { method: "DELETE" }
    );
    if (!task) {
      throw new Error("Meilisearch index deletion task was not created");
    }
    await this.waitForTask(task.taskUid);
  }

  /**
   * Deletes an index when it exists.
   *
   * @param index - the unprefixed index name.
   * @returns a promise that resolves after the index is absent.
   */
  public async deleteIndexIfExists(index: string): Promise<void> {
    const task = await this.request<MeilisearchTask>(
      `/indexes/${this.indexName(index)}`,
      {
        method: "DELETE",
        allowNotFound: true,
      }
    );
    if (task) {
      await this.waitForTask(task.taskUid, false, true);
    }
  }

  /**
   * Atomically exchanges index UID pairs.
   *
   * @param indexes - unprefixed index name pairs to exchange.
   * @returns a promise that resolves after the indexes are swapped.
   */
  public async swapIndexes(indexes: [string, string][]): Promise<void> {
    await this.waitForTask(await this.startSwapIndexes(indexes));
  }

  /**
   * Submits an atomic index exchange without waiting for it to finish.
   *
   * @param indexes - unprefixed index name pairs to exchange.
   * @returns the submitted Meilisearch task identifier.
   */
  public async startSwapIndexes(indexes: [string, string][]): Promise<number> {
    const task = await this.request<MeilisearchTask>("/swap-indexes", {
      body: JSON.stringify(
        indexes.map(([first, second]) => ({
          indexes: [this.indexName(first), this.indexName(second)],
        }))
      ),
      method: "POST",
    });
    if (!task) {
      throw new Error("Meilisearch index swap task was not created");
    }
    return task.taskUid;
  }

  /**
   * Finds an existing atomic index exchange for exactly the supplied pairs.
   *
   * @param indexes - unprefixed index name pairs to match.
   * @returns the Meilisearch task identifier or undefined when no matching task exists.
   */
  public async findSwapTask(
    indexes: [string, string][]
  ): Promise<number | undefined> {
    const tasks = await this.request<MeilisearchTaskList>(
      "/tasks?types=indexSwap&limit=1000",
      { method: "GET" }
    );
    const expected = this.swapPairsKey(
      indexes.map(([first, second]) => [
        this.indexName(first),
        this.indexName(second),
      ])
    );

    for (const task of tasks?.results ?? []) {
      const swaps = task.details?.swaps;
      const taskUid = task.uid ?? task.taskUid;
      if (!swaps || taskUid === undefined) {
        continue;
      }
      if (this.swapPairsKey(swaps.map((swap) => swap.indexes)) === expected) {
        return taskUid;
      }
    }

    return undefined;
  }

  /**
   * Waits for a previously submitted Meilisearch task.
   *
   * @param taskUid - the Meilisearch task identifier.
   * @param allowExistingIndex - whether an existing index task failure is accepted.
   * @param allowMissingIndex - whether a missing index task failure is accepted.
   * @returns a promise that resolves after the task succeeds.
   */
  public async waitForTask(
    taskUid: number,
    allowExistingIndex = false,
    allowMissingIndex = false
  ): Promise<void> {
    await this.waitForTaskResult(
      taskUid,
      allowExistingIndex,
      allowMissingIndex
    );
  }

  /**
   * Searches an index.
   *
   * @param index - the unprefixed index name.
   * @param options - the query options.
   * @returns matching documents and Meilisearch's estimated total.
   */
  public search<THit extends MeilisearchHit = MeilisearchHit>(
    index: string,
    options: MeilisearchSearchOptions
  ): Promise<MeilisearchSearchResponse<THit>> {
    return this.request<MeilisearchSearchResponse<THit>>(
      `/indexes/${this.indexName(index)}/search`,
      {
        body: JSON.stringify({
          attributesToCrop: options.attributesToCrop,
          attributesToHighlight: options.attributesToHighlight,
          attributesToRetrieve: options.attributesToRetrieve,
          attributesToSearchOn: options.attributesToSearchOn,
          cropMarker: "…",
          filter: options.filter,
          highlightPostTag: "</b>",
          highlightPreTag: "<b>",
          hybrid: options.hybrid,
          limit: options.limit,
          locales: options.locales,
          offset: options.offset,
          q: options.query,
          sort: options.sort,
          vector: options.vector,
        }),
        method: "POST",
      }
    ).then((response) => {
      if (!response) {
        throw new Error("Meilisearch search response was not returned");
      }
      return response;
    });
  }

  private indexName(index: string) {
    return `${this.indexPrefix}_${index}`;
  }

  private swapPairsKey(indexes: string[][]): string {
    return JSON.stringify(
      indexes
        .map((pair) => [...pair].sort())
        .sort((first, second) => {
          const firstKey = JSON.stringify(first);
          const secondKey = JSON.stringify(second);
          return firstKey.localeCompare(secondKey);
        })
    );
  }

  private async request<T>(
    path: string,
    options: {
      allowConflict?: boolean;
      allowNotFound?: boolean;
      body?: string;
      method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
    }
  ): Promise<T | undefined> {
    const response = await fetch(`${this.url}${path}`, {
      body: options.body,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      method: options.method,
    });

    if (options.allowConflict && response.status === 409) {
      return undefined;
    }
    if (options.allowNotFound && response.status === 404) {
      return undefined;
    }
    if (!response.ok) {
      throw new Error(
        `Meilisearch request failed with status ${response.status}`
      );
    }

    return (await response.json()) as T;
  }

  private async waitForTaskResult(
    taskUid: number,
    allowExistingIndex = false,
    allowMissingIndex = false
  ): Promise<void> {
    const timeoutAt = Date.now() + MeilisearchClient.TASK_TIMEOUT;

    while (Date.now() < timeoutAt) {
      const task = await this.request<MeilisearchTask>(`/tasks/${taskUid}`, {
        method: "GET",
      });
      if (task?.status === "succeeded") {
        return;
      }
      if (task?.status === "failed") {
        if (
          allowExistingIndex &&
          (task.error?.code === "index_already_exists" ||
            task.error?.message.endsWith("already exists."))
        ) {
          return;
        }
        if (
          allowMissingIndex &&
          (task.error?.code === "index_not_found" ||
            task.error?.message.endsWith("not found."))
        ) {
          return;
        }
        throw new Error(task.error?.message ?? "Meilisearch task failed");
      }
      await new Promise<void>((resolve) =>
        setTimeout(resolve, MeilisearchClient.TASK_POLL_INTERVAL)
      );
    }

    throw new Error("Meilisearch task timed out");
  }
}
