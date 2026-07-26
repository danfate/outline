import { Buffer } from "node:buffer";
import { batchByByteSize } from "./batchByByteSize";

describe("batchByByteSize", () => {
  it("splits records into JSON payloads that do not exceed the byte limit", () => {
    const records = [
      { id: "one", text: "first" },
      { id: "two", text: "second" },
      { id: "three", text: "third" },
    ];
    const limit = Buffer.byteLength(JSON.stringify(records.slice(0, 2)));

    const batches = batchByByteSize(records, limit);

    expect(batches).toEqual([records.slice(0, 2), records.slice(2)]);
    expect(
      batches.every(
        (batch) => Buffer.byteLength(JSON.stringify(batch)) <= limit
      )
    ).toBe(true);
  });
});
