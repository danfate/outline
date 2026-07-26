import { parseMeilisearchLocales } from "./env";

describe("parseMeilisearchLocales", () => {
  it("ignores empty locales from a comma-separated setting", () => {
    expect(parseMeilisearchLocales("zho, ,eng,")).toEqual(["zho", "eng"]);
  });
});
