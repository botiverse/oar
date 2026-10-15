/**
 * A function that imports its implementation on its first call, so a
 * runtime's entry module stays light (no ACP SDK, about 20 MB of heap) until
 * a host actually opens a session, lists models or reads usage. Every later
 * call shares the import; a failed import is tried again on the next call.
 */
export function onFirstCall<A extends readonly unknown[], R>(load: () => Promise<(...args: A) => Promise<R>>): (...args: A) => Promise<R> {
  let loading: Promise<(...args: A) => Promise<R>> | null = null;
  const loaded = async (): Promise<(...args: A) => Promise<R>> => {
    try {
      return await load();
    } catch (error) {
      loading = null;
      throw error;
    }
  };
  return async (...args) => {
    loading ??= loaded();
    const implementation = await loading;
    return implementation(...args);
  };
}
