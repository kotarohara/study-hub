/** True if `needle` appears in the message of `err` or any error in its
 * cause chain. Drizzle wraps postgres errors, so constraint names live on
 * `err.cause`, not the thrown message. */
export function errorChainIncludes(err: unknown, needle: string): boolean {
  let cur: unknown = err;
  while (cur instanceof Error) {
    if (cur.message.includes(needle)) return true;
    cur = cur.cause;
  }
  return false;
}
