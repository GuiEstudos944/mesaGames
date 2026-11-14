export function elapsedTimerMs(timer, nowMs = Date.now(), clockOffsetMs = 0) {
  const accumulated = Math.max(0, Number(timer?.elapsed_ms_when_paused) || 0);
  if (timer?.status !== "running" || !timer.started_at) return accumulated;
  const startedAt = Date.parse(timer.started_at);
  if (!Number.isFinite(startedAt)) return accumulated;
  return accumulated + Math.max(0, nowMs + clockOffsetMs - startedAt);
}

export function displayedTimerMs(timer, nowMs = Date.now(), clockOffsetMs = 0) {
  const elapsed = elapsedTimerMs(timer, nowMs, clockOffsetMs);
  return timer?.mode === "countdown"
    ? Math.max(0, (Number(timer.duration_ms) || 0) - elapsed)
    : elapsed;
}

export function formatTimerMs(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

export function normalizeTimerState(row) {
  const mode = row?.mode === "countdown" ? "countdown" : "stopwatch";
  const status = ["running", "paused"].includes(row?.status) ? row.status : "stopped";
  const duration = Math.trunc(Number(row?.duration_ms));
  const elapsed = Math.trunc(Number(row?.elapsed_ms_when_paused));
  const startedAt = typeof row?.started_at === "string" && Number.isFinite(Date.parse(row.started_at))
    ? new Date(row.started_at).toISOString()
    : null;

  return {
    mode,
    status,
    started_at: startedAt,
    duration_ms: Math.min(59_999_000, Math.max(0, Number.isFinite(duration) ? duration : 300_000)),
    elapsed_ms_when_paused: Math.max(0, Number.isFinite(elapsed) ? elapsed : 0),
    updated_at: Number.isFinite(Date.parse(row?.updated_at))
      ? new Date(row.updated_at).toISOString()
      : new Date().toISOString()
  };
}
