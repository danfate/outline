import type {
  Filter,
  FilterCondition,
  FilterGroup,
  FilterValue,
} from "@shared/helpers/FilterHelper";
import { isISO8601Duration } from "@server/validation";

const DATE_FIELDS = new Set([
  "archivedAt",
  "createdAt",
  "publishedAt",
  "updatedAt",
]);

const FIELD_BY_FILTER_FIELD: Record<string, string> = {
  documentId: "id",
  userId: "collaboratorIds",
};

/**
 * Convert an Outline document filter into a Meilisearch filter expression.
 *
 * @param filter the Outline filter expression to convert.
 * @param now the reference time used to resolve ISO 8601 durations.
 * @returns a Meilisearch-compatible filter expression.
 */
export function toMeilisearchFilter(filter: Filter, now = new Date()): string {
  if (isGroup(filter)) {
    return `(${filter.filters
      .map((entry) => toMeilisearchFilter(entry, now))
      .join(` ${filter.operator} `)})`;
  }

  return conditionToMeilisearchFilter(filter, now);
}

/**
 * Checks whether a document filter has equivalent Meilisearch syntax.
 *
 * @param filter the Outline filter expression to inspect.
 * @returns whether the expression can be evaluated by Meilisearch.
 */
export function isMeilisearchFilterSupported(filter: Filter): boolean {
  if (isGroup(filter)) {
    return filter.filters.every(isMeilisearchFilterSupported);
  }

  return ![
    "containsStrict",
    "endsWith",
    "endsWithStrict",
    "startsWithStrict",
  ].includes(filter.operator);
}

function isGroup(filter: Filter): filter is FilterGroup {
  return "filters" in filter;
}

function conditionToMeilisearchFilter(
  condition: FilterCondition,
  now: Date
): string {
  const field = FIELD_BY_FILTER_FIELD[condition.field] ?? condition.field;
  const { operator, value } = condition;

  if (operator === "isNull") {
    return `${field} IS NULL`;
  }
  if (operator === "isNotNull") {
    return `${field} IS NOT NULL`;
  }
  if (value === undefined) {
    throw new Error(`Filter operator '${operator}' requires a value`);
  }

  const resolvedValue = filterValue(value, DATE_FIELDS.has(field), now);

  switch (operator) {
    case "eq":
      return `${field} = ${resolvedValue}`;
    case "neq":
      return `${field} != ${resolvedValue}`;
    case "lt":
      return `${field} < ${resolvedValue}`;
    case "lte":
      return `${field} <= ${resolvedValue}`;
    case "gt":
      return `${field} > ${resolvedValue}`;
    case "gte":
      return `${field} >= ${resolvedValue}`;
    case "contains":
    case "containsStrict":
      return `${field} CONTAINS ${resolvedValue}`;
    case "startsWith":
    case "startsWithStrict":
      return `${field} STARTS WITH ${resolvedValue}`;
    case "endsWith":
    case "endsWithStrict":
      throw new Error(
        `Meilisearch does not support the '${operator}' filter operator`
      );
    case "in":
      return `${field} IN ${resolvedValue}`;
    case "notIn":
      return `${field} NOT IN ${resolvedValue}`;
    default:
      throw new Error("Unsupported filter operator");
  }
}

function filterValue(
  value: FilterValue,
  isDateField: boolean,
  now: Date
): string {
  if (!isDateField) {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return JSON.stringify(value.map((entry) => dateToTimestamp(entry, now)));
  }

  return JSON.stringify(dateToTimestamp(value, now));
}

function dateToTimestamp(value: string | number | boolean, now: Date): number {
  if (typeof value !== "string") {
    throw new Error("Date filters require an ISO 8601 string value");
  }

  if (isISO8601Duration(value)) {
    return durationToDate(value, now).getTime();
  }

  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    throw new Error(`Invalid ISO 8601 date '${value}'`);
  }
  return timestamp;
}

function durationToDate(duration: string, now: Date): Date {
  const match = duration.match(
    /^(?<sign>-)?P(?:(?<years>\d+)Y)?(?:(?<months>\d+)M)?(?:(?<weeks>\d+)W)?(?:(?<days>\d+)D)?$/
  );
  if (!match?.groups) {
    throw new Error(`Unsupported ISO 8601 duration '${duration}'`);
  }

  const sign = match.groups.sign ? -1 : 1;
  const date = new Date(now);
  date.setUTCFullYear(
    date.getUTCFullYear() + sign * Number(match.groups.years ?? 0)
  );
  date.setUTCMonth(
    date.getUTCMonth() + sign * Number(match.groups.months ?? 0)
  );
  date.setUTCDate(
    date.getUTCDate() +
      sign *
        (Number(match.groups.weeks ?? 0) * 7 + Number(match.groups.days ?? 0))
  );
  return date;
}
