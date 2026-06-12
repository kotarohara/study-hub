import { define } from "../utils.ts";
import { getConfig } from "../lib/config.ts";
import { checkDatabase, checkStorage } from "../lib/health.ts";

export const handler = define.handlers({
  async GET() {
    const config = getConfig();
    const [database, storage] = await Promise.all([
      checkDatabase(config.DATABASE_URL),
      checkStorage(config.S3_ENDPOINT),
    ]);
    const ok = database.ok && storage.ok;
    return Response.json(
      { status: ok ? "ok" : "degraded", checks: { database, storage } },
      { status: ok ? 200 : 503 },
    );
  },
});
