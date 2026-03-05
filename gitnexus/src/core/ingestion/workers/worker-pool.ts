import { Worker } from 'node:worker_threads';
import os from 'node:os';

export interface WorkerPool {
  /**
   * Dispatch items across workers. Items are split into chunks (one per worker),
   * each worker processes its chunk, and results are concatenated back in order.
   *
   * @param onProgress - Called with cumulative files processed across all workers
   */
  dispatch<TInput, TResult>(items: TInput[], onProgress?: (filesProcessed: number) => void): Promise<TResult[]>;

  /**
   * Terminate all workers. Must be called when done.
   */
  terminate(): Promise<void>;

  /** Number of workers in the pool */
  readonly size: number;
}

/**
 * Create a pool of worker threads.
 *
 * @param workerUrl - URL to the worker script (use `new URL('./parse-worker.js', import.meta.url)`)
 * @param poolSize - Number of workers (defaults to cpus - 1, minimum 1)
 */
export const createWorkerPool = (workerUrl: URL, poolSize?: number): WorkerPool => {
  const maxSize = poolSize ?? Math.max(1, os.cpus().length - 1);
  const workers: Worker[] = [];

  const getItemWeight = (item: unknown): number => {
    // Heuristic: many workloads (like parse-worker) send `{ path, content }` objects.
    // Weight by content length to reduce chunk skew from a few very large files.
    if (item && typeof item === 'object') {
      const maybeContent = (item as { content?: unknown }).content;
      if (typeof maybeContent === 'string' && maybeContent.length > 0) {
        return maybeContent.length;
      }
    }
    return 1;
  };

  const ensureWorkers = (count: number): void => {
    while (workers.length < count) {
      workers.push(new Worker(workerUrl));
    }
  };

  const dispatch = <TInput, TResult>(items: TInput[], onProgress?: (filesProcessed: number) => void): Promise<TResult[]> => {
    if (items.length === 0) return Promise.resolve([]);

    // Lazily create only the number of workers we actually need for this dispatch.
    // Creating many idle workers is expensive and can destabilize native add-ons in small repos.
    const size = Math.min(maxSize, items.length);
    ensureWorkers(size);

    // Split into one chunk per worker, but weight-balance by item size when possible.
    // This keeps us at one postMessage() per worker (minimize clone overhead),
    // while reducing the common skew from a handful of huge source files.
    const entries = items.map((item, index) => ({
      index,
      item,
      weight: getItemWeight(item),
    }));
    entries.sort((left, right) => {
      if (right.weight !== left.weight) return right.weight - left.weight;
      return left.index - right.index;
    });

    const buckets: Array<{ totalWeight: number; items: Array<{ index: number; item: TInput }> }> = Array.from(
      { length: size },
      () => ({ totalWeight: 0, items: [] }),
    );

    for (const entry of entries) {
      let best = 0;
      for (let i = 1; i < buckets.length; i++) {
        if (buckets[i].totalWeight < buckets[best].totalWeight) best = i;
      }
      buckets[best].items.push({ index: entry.index, item: entry.item });
      buckets[best].totalWeight += entry.weight;
    }

    const chunks: TInput[][] = buckets
      .map(bucket =>
        bucket.items
          .sort((a, b) => a.index - b.index) // preserve original order within each chunk
          .map(entry => entry.item)
      )
      .filter(chunk => chunk.length > 0);

    // Track per-worker progress for cumulative reporting
    const workerProgress = new Array(chunks.length).fill(0);

    // Send one chunk to each worker, collect results
    const promises = chunks.map((chunk, i) => {
      const worker = workers[i];
      return new Promise<TResult>((resolve, reject) => {
        const handler = (msg: any) => {
          if (msg && msg.type === 'progress') {
            // Intermediate progress from worker
            workerProgress[i] = msg.filesProcessed;
            if (onProgress) {
              const total = workerProgress.reduce((a, b) => a + b, 0);
              onProgress(total);
            }
          } else if (msg && msg.type === 'result') {
            // Final result
            worker.removeListener('message', handler);
            resolve(msg.data);
          } else {
            // Legacy: treat any non-typed message as result (backward compat)
            worker.removeListener('message', handler);
            resolve(msg);
          }
        };
        worker.on('message', handler);
        worker.once('error', (err) => {
          worker.removeListener('message', handler);
          reject(err);
        });
        worker.postMessage(chunk);
      });
    });

    return Promise.all(promises);
  };

  const terminate = async (): Promise<void> => {
    await Promise.all(workers.map(w => w.terminate()));
    workers.length = 0;
  };

  return {
    dispatch,
    terminate,
    get size() {
      return workers.length;
    },
  };
};
