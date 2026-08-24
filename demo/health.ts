export interface HealthResult {
  status: "healthy" | "unhealthy";
  latencyMs: number;
  thresholdMs: number;
}

export function checkHealth(
  latencyMs: number,
  thresholdMs: number,
): HealthResult {
  return {
    status: latencyMs <= thresholdMs ? "healthy" : "unhealthy",
    latencyMs,
    thresholdMs,
  };
}
