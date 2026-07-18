import { useState, useEffect, useCallback, useRef } from "react";

/**
 * Executa uma função assíncrona e gerencia loading/error/data.
 * Re-executa automaticamente quando as deps mudam.
 * `refresh()` força re-execução manual.
 */
export function useAsync<T>(
  fn: () => Promise<T>,
  deps: unknown[] = [],
): { data: T | null; loading: boolean; error: string | null; refresh: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Mantém referência estável para fn sem precisar colocá-la em deps
  const fnRef = useRef(fn);
  fnRef.current = fn;

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await fnRef.current());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, deps); // deps controla quando re-executa

  useEffect(() => { void run(); }, [run]);

  return { data, loading, error, refresh: run };
}
