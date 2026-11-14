import { timingSafeEqual } from "node:crypto";
import { getDb } from "@/server/db";
import { processDue } from "@/server/runner";

/**
 * Advances executions with a due retry. Call from a scheduler (cron) with
 * `Authorization: Bearer $WORKER_SECRET`. Disabled when WORKER_SECRET is unset.
 */
export async function POST(req: Request) {
  const secret = process.env.WORKER_SECRET;
  if (!secret) return Response.json({ error: "Worker disabled" }, { status: 503 });
  const given = Buffer.from(req.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const processed = await processDue(await getDb());
  return Response.json({ processed });
}
