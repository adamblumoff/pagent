interface CloudflareEnvelope<T> {
  success: boolean;
  result: T;
  errors?: Array<{ code?: number; message?: string }>;
}

interface TunnelResult {
  id?: string;
  name?: string;
  status?: "inactive" | "degraded" | "healthy" | "down";
}

interface DnsResult {
  id?: string;
}

const runtimeFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);

export class CloudflareApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "CloudflareApiError";
  }
}

export class CloudflareApi {
  private readonly baseUrl: string;

  constructor(
    private readonly accountId: string,
    private readonly zoneId: string,
    private readonly apiToken: string,
    baseUrl = "https://api.cloudflare.com/client/v4",
    private readonly fetcher: typeof fetch = runtimeFetch,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/u, "");
  }

  async createOrFindTunnel(name: string): Promise<{
    tunnelId: string;
    created: boolean;
  }> {
    try {
      const tunnel = await this.request<TunnelResult>(
        `/accounts/${this.accountId}/cfd_tunnel`,
        {
          method: "POST",
          body: JSON.stringify({ name, config_src: "cloudflare" }),
        },
      );
      return { tunnelId: requiredId(tunnel, "tunnel"), created: true };
    } catch (error) {
      if (!(error instanceof CloudflareApiError) || error.status !== 409) {
        throw error;
      }
      const query = new URLSearchParams({ name, is_deleted: "false" });
      const tunnels = await this.request<TunnelResult[]>(
        `/accounts/${this.accountId}/cfd_tunnel?${query}`,
      );
      const tunnel = tunnels.find((candidate) => candidate.name === name);
      if (!tunnel) {
        throw new CloudflareApiError(
          "Cloudflare reported a tunnel name conflict but returned no matching tunnel.",
          409,
        );
      }
      return { tunnelId: requiredId(tunnel, "tunnel"), created: false };
    }
  }

  async configureTunnel(
    tunnelId: string,
    hostname: string,
    originPort: number,
  ): Promise<void> {
    await this.request(
      `/accounts/${this.accountId}/cfd_tunnel/${tunnelId}/configurations`,
      {
        method: "PUT",
        body: JSON.stringify({
          config: {
            ingress: [
              {
                hostname,
                path: "^/v1/(events|probe)$",
                service: `http://127.0.0.1:${originPort}`,
              },
              { service: "http_status:404" },
            ],
          },
        }),
      },
    );
  }

  async upsertDns(hostname: string, tunnelId: string): Promise<string> {
    const query = new URLSearchParams({ type: "CNAME", name: hostname });
    const records = await this.request<DnsResult[]>(
      `/zones/${this.zoneId}/dns_records?${query}`,
    );
    const body = JSON.stringify({
      type: "CNAME",
      name: hostname,
      content: `${tunnelId}.cfargotunnel.com`,
      proxied: true,
      ttl: 1,
      comment: "Managed by Pagent provisioner",
    });
    const existingId = records[0]?.id;
    const record = await this.request<DnsResult>(
      existingId
        ? `/zones/${this.zoneId}/dns_records/${existingId}`
        : `/zones/${this.zoneId}/dns_records`,
      { method: existingId ? "PUT" : "POST", body },
    );
    return requiredId(record, "DNS record");
  }

  async getTunnelToken(tunnelId: string): Promise<string> {
    const token = await this.request<string>(
      `/accounts/${this.accountId}/cfd_tunnel/${tunnelId}/token`,
    );
    if (typeof token !== "string" || token.length < 20) {
      throw new CloudflareApiError("Cloudflare returned an invalid tunnel token.", 502);
    }
    return token;
  }

  async rotateTunnelToken(tunnelId: string, tunnelSecret: string): Promise<string> {
    await this.request(`/accounts/${this.accountId}/cfd_tunnel/${tunnelId}`, {
      method: "PATCH",
      body: JSON.stringify({ tunnel_secret: tunnelSecret }),
    });
    return this.getTunnelToken(tunnelId);
  }

  async deleteDns(recordId: string): Promise<void> {
    await this.request(`/zones/${this.zoneId}/dns_records/${recordId}`, {
      method: "DELETE",
    }, true);
  }

  async deleteTunnel(tunnelId: string): Promise<void> {
    await this.request(
      `/accounts/${this.accountId}/cfd_tunnel/${tunnelId}`,
      { method: "DELETE" },
      true,
    );
  }

  private async request<T = unknown>(
    path: string,
    init: RequestInit = {},
    allowNotFound = false,
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}${path}`, {
        ...init,
        signal: init.signal ?? AbortSignal.timeout(10_000),
        headers: {
          authorization: `Bearer ${this.apiToken}`,
          "content-type": "application/json",
          ...init.headers,
        },
      });
    } catch (error) {
      const detail = error instanceof Error
        ? `${error.name}: ${error.message}`
        : "unknown runtime error";
      throw new CloudflareApiError(`Could not reach the Cloudflare API (${detail}).`, 502);
    }
    if (allowNotFound && response.status === 404) return undefined as T;

    let envelope: CloudflareEnvelope<T>;
    try {
      const value = await response.json() as unknown;
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("Invalid Cloudflare envelope");
      }
      envelope = value as CloudflareEnvelope<T>;
    } catch {
      if (!response.ok) {
        throw new CloudflareApiError("Cloudflare rejected the request.", response.status);
      }
      throw new CloudflareApiError("Cloudflare returned invalid JSON.", 502);
    }
    if (!response.ok || envelope.success !== true) {
      const detail = envelope.errors?.[0]?.message;
      throw new CloudflareApiError(
        detail ? `Cloudflare rejected the request: ${detail}` : "Cloudflare rejected the request.",
        response.status,
      );
    }
    return envelope.result;
  }
}

function requiredId(value: { id?: string }, kind: string): string {
  if (typeof value.id !== "string" || value.id.length === 0) {
    throw new CloudflareApiError(`Cloudflare returned an invalid ${kind} ID.`, 502);
  }
  return value.id;
}
