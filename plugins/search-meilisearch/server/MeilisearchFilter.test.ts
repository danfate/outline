import {
  isMeilisearchFilterSupported,
  toMeilisearchFilter,
} from "./MeilisearchFilter";

describe("toMeilisearchFilter", () => {
  const now = new Date("2026-09-02T00:00:00.000Z");

  it("converts nested document filters and date durations", () => {
    expect(
      toMeilisearchFilter(
        {
          operator: "AND",
          filters: [
            { field: "collectionId", operator: "eq", value: "collection" },
            {
              operator: "OR",
              filters: [
                { field: "archivedAt", operator: "isNull" },
                {
                  field: "updatedAt",
                  operator: "gte",
                  value: "-P1D",
                },
              ],
            },
          ],
        },
        now
      )
    ).toBe(
      '(collectionId = "collection" AND (archivedAt IS NULL OR updatedAt >= 1788220800000))'
    );
  });

  it("maps document and collaborator filters to indexed fields", () => {
    expect(
      toMeilisearchFilter(
        { field: "userId", operator: "in", value: ["one", "two"] },
        now
      )
    ).toBe('collaboratorIds IN ["one","two"]');
  });

  it("reports filters without equivalent Meilisearch syntax", () => {
    expect(
      isMeilisearchFilterSupported({
        field: "title",
        operator: "endsWith",
        value: "guide",
      })
    ).toBe(false);
  });
});
