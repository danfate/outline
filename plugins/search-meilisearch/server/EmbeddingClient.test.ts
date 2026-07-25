import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { EmbeddingClient } from "./EmbeddingClient";

describe("EmbeddingClient", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (!server) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => (error ? reject(error) : resolve()));
    });
    server = undefined;
  });

  it("rejects a response without an embedding array", async () => {
    const url = await startServer((response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ data: {} }));
    });
    const client = new EmbeddingClient({
      apiKey: "test-key",
      dimensions: 2,
      model: "test-model",
      url,
    });

    await expect(client.embed(["test input"])).rejects.toThrow(
      "Embedding response did not contain every requested input"
    );
  });

  it("sends an OpenAI-compatible request and orders embeddings by index", async () => {
    let requestBody = "";
    const url = await startServer(async (response, request) => {
      for await (const chunk of request) {
        requestBody += chunk.toString();
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          data: [
            { embedding: [0, 1], index: 1 },
            { embedding: [1, 0], index: 0 },
          ],
        })
      );
    });
    const client = new EmbeddingClient({
      apiKey: "test-key",
      dimensions: 2,
      model: "test-model",
      url,
    });

    await expect(client.embed(["first", "second"])).resolves.toEqual([
      [1, 0],
      [0, 1],
    ]);
    expect(requestBody).toContain('"model":"test-model"');
    expect(requestBody).toContain('"input":["first","second"]');
  });

  it("rejects an embedding with an unexpected dimension", async () => {
    const url = await startServer((response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ data: [{ embedding: [1], index: 0 }] }));
    });
    const client = new EmbeddingClient({
      apiKey: "test-key",
      dimensions: 2,
      model: "test-model",
      url,
    });

    await expect(client.embed(["test input"])).rejects.toThrow(
      "Embedding response contains an invalid vector"
    );
  });

  it("rejects an embedding response without a vector", async () => {
    const url = await startServer((response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ data: [{ index: 0 }] }));
    });
    const client = new EmbeddingClient({
      apiKey: "test-key",
      dimensions: 2,
      model: "test-model",
      url,
    });

    await expect(client.embed(["test input"])).rejects.toThrow(
      "Embedding response contains an invalid vector"
    );
  });

  async function startServer(
    handler: (
      response: ServerResponse,
      request: IncomingMessage
    ) => void | Promise<void>
  ): Promise<string> {
    server = createServer(async (request, response) => {
      await handler(response, request);
    });
    await new Promise<void>((resolve) => {
      server?.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Unable to determine embeddings test server address");
    }
    return `http://127.0.0.1:${address.port}`;
  }
});
