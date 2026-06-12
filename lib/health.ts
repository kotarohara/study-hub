import postgres from "postgres";

export interface CheckResult {
  ok: boolean;
  error?: string;
}

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Verifies the database accepts connections and answers a trivial query. */
export async function checkDatabase(databaseUrl: string): Promise<CheckResult> {
  let sql: ReturnType<typeof postgres> | undefined;
  try {
    sql = postgres(databaseUrl, { max: 1, connect_timeout: 5 });
    await sql`select 1`;
    return { ok: true };
  } catch (err) {
    return { ok: false, error: toMessage(err) };
  } finally {
    await sql?.end({ timeout: 1 });
  }
}

/**
 * Verifies the object-storage endpoint is reachable. Any HTTP response counts
 * as reachable (unauthenticated requests legitimately get 403 from S3/MinIO);
 * only network-level failures are reported as down.
 */
export async function checkStorage(endpoint: string): Promise<CheckResult> {
  try {
    const res = await fetch(endpoint, {
      method: "HEAD",
      signal: AbortSignal.timeout(5_000),
    });
    await res.body?.cancel();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: toMessage(err) };
  }
}
