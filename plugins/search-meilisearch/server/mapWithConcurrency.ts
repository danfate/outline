/**
 * Maps values while limiting the number of active asynchronous operations.
 *
 * @param values - values to map.
 * @param concurrency - maximum number of simultaneous mapper calls.
 * @param mapper - asynchronous operation for each value.
 * @returns mapped values in their original order.
 */
export async function mapWithConcurrency<T, TResult>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<TResult>
): Promise<TResult[]> {
  const results: TResult[] = [];
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, worker)
  );
  return results;
}
