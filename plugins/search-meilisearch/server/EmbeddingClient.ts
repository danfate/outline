export interface EmbeddingClientOptions {
  apiKey: string;
  dimensions: number;
  model: string;
  url: string;
}

interface EmbeddingResponse {
  data: {
    embedding: number[];
    index: number;
  }[];
}

/**
 * Minimal client for an OpenAI-compatible embeddings endpoint.
 */
export class EmbeddingClient {
  private readonly apiKey: string;
  private readonly dimensions: number;
  private readonly model: string;
  private readonly url: string;

  /**
   * @param options - connection and model settings for the embeddings service.
   */
  public constructor(options: EmbeddingClientOptions) {
    this.apiKey = options.apiKey;
    this.dimensions = options.dimensions;
    this.model = options.model;
    this.url = options.url.replace(/\/$/, "");
  }

  /**
   * Generates one embedding for every input string.
   *
   * @param input - texts to encode.
   * @returns embeddings in the same order as the input.
   * @throws when the service response is invalid or does not match the configured dimensions.
   */
  public async embed(input: string[]): Promise<number[][]> {
    if (!input.length) {
      return [];
    }

    const response = await this.request(input);
    if (!response.ok) {
      throw new Error(
        `Embedding request failed with status ${response.status}`
      );
    }

    const body = (await response.json()) as EmbeddingResponse;
    if (!Array.isArray(body.data) || body.data.length !== input.length) {
      throw new Error(
        "Embedding response did not contain every requested input"
      );
    }
    const embeddings = body.data.sort((a, b) => a.index - b.index);
    for (const [index, item] of embeddings.entries()) {
      if (!Number.isInteger(item.index) || item.index !== index) {
        throw new Error("Embedding response indexes do not match the request");
      }
      if (
        !Array.isArray(item.embedding) ||
        item.embedding.length !== this.dimensions ||
        item.embedding.some((value) => !Number.isFinite(value))
      ) {
        throw new Error("Embedding response contains an invalid vector");
      }
    }
    return embeddings.map((item) => item.embedding);
  }

  private request(input: string[]): Promise<Response> {
    return fetch(`${this.url}/embeddings`, {
      body: JSON.stringify({ input, model: this.model }),
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    });
  }
}
