import { getProviderConfig, listModels } from "@/lib/agents/registry";
import { inflightGames, readGuardConfig, type PublicMode } from "@/lib/guard";
import { listRunning } from "@/lib/live";
import { fileStore } from "@/lib/store/fileStore";
import { runningTournaments } from "@/lib/tournaments/run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface HealthResponse {
  ok: boolean;
  persistent: boolean; // false when the tmp fallback is in use
  liveGames: number;
  tournaments: number;
  mode: PublicMode;
  adminConfigured: boolean;
  warnings: string[];
}

// Liveness and config sanity for the host's health check. Never rate limited,
// and never reports a path, an env value or the token.
export async function GET() {
  const cfg = readGuardConfig();
  const health = await fileStore.health();
  const warnings = [...cfg.warnings];
  if (
    cfg.mode === "open" &&
    process.env.ARENA_DATA_DIR?.trim() &&
    listModels().some((m) => getProviderConfig(m.id) !== null)
  ) {
    warnings.push(
      "Real models are configured and ARENA_PUBLIC_MODE is open: anyone can spend your API keys."
    );
  }
  const body: HealthResponse = {
    ok: health.writable,
    persistent: health.persistent,
    liveGames: listRunning().length + inflightGames(),
    tournaments: runningTournaments(),
    mode: cfg.mode,
    adminConfigured: cfg.adminTokenHash !== null,
    warnings,
  };
  return Response.json(body, {
    status: health.writable ? 200 : 503,
    headers: { "cache-control": "no-store" },
  });
}
