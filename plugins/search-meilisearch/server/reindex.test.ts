import { parseReindexOptions } from "./reindex";

describe("parseReindexOptions", () => {
  it("uses resumable rebuild mode by default", () => {
    expect(parseReindexOptions([])).toEqual({
      fresh: false,
      status: false,
    });
  });

  it("parses the fresh rebuild option", () => {
    expect(parseReindexOptions(["--fresh"])).toEqual({
      fresh: true,
      status: false,
    });
  });

  it("rejects incompatible options", () => {
    expect(() => parseReindexOptions(["--fresh", "--status"])).toThrow(
      "cannot be used together"
    );
  });
});
