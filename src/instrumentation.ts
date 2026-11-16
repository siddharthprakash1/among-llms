export async function register() {
  // Positive block, not an early return: Next also compiles this file for the
  // edge runtime and only drops the node-only imports when they sit inside it.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Hosted deployments only, so a local dev restart behaves as it always has.
    if (process.env.ARENA_DATA_DIR?.trim()) {
      const { abandonOrphanedTournaments } = await import("./lib/tournaments/run");
      const { readGuardConfig } = await import("./lib/guard");
      for (const w of readGuardConfig().warnings) console.warn(`[arena] ${w}`);
      await abandonOrphanedTournaments().catch((e) => console.warn("[arena] reconcile failed", e));
    }
  }
}
