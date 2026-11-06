// Retries network errors with a 1/2/4 s backoff, but never waits longer than budgetMs in total:
// each call is cut at the remaining budget (its own fetch timeout may be longer). Other errors throw at once.
// No DOM: shared by the quiz and its tests.
const networkError = () => Object.assign(new Error('network'), { code: 'network' });

export async function withRetry(fn, { signal, budgetMs = 10_000, delays = [1000, 2000, 4000] } = {}) {
  const deadline = Date.now() + budgetMs;
  for (let i = 0; ; i++) {
    let timer;
    try {
      const cut = new Promise((_, rej) => { timer = setTimeout(() => rej(networkError()), Math.max(0, deadline - Date.now())); });
      return await Promise.race([fn(), cut]);
    } catch (e) {
      if (e.code !== 'network' || signal?.aborted || i >= delays.length || Date.now() + delays[i] >= deadline) throw e;
      await new Promise((r) => setTimeout(r, delays[i]));
    } finally { clearTimeout(timer); }
  }
}
