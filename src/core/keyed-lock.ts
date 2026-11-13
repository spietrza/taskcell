/** A per-key mutex: jobs sharing a key run one after the other (a failed job does not block the next). */
export function keyedLock(): <T>(key: string, job: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<unknown>>();
  return (key, job) => {
    const run = (tails.get(key) ?? Promise.resolve()).then(job);
    const tail = run.catch(() => undefined);
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return run;
  };
}
