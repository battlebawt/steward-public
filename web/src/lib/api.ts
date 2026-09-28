import type { ApiEnvelope, StructuredApiErrorBody } from "../domain";
import { StructuredApiError } from "./errors";

export interface ApiClientOptions {
  baseUrl?: string;
  csrfToken?: string;
  fetcher?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

export interface ApiClient {
  request<T>(path: string, init?: RequestInit): Promise<ApiEnvelope<T>>;
  get<T>(path: string, signal?: AbortSignal): Promise<ApiEnvelope<T>>;
  post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<ApiEnvelope<T>>;
}

/** Abort the previous request for a key and ignore a response that arrived late. */
export class LatestRequestGate {
  private readonly controllers = new Map<string, AbortController>();
  private readonly sequence = new Map<string, number>();
  constructor(private readonly client: ApiClient) {}
  async get<T>(key: string, path: string): Promise<ApiEnvelope<T> | undefined> {
    this.controllers.get(key)?.abort();
    const controller = new AbortController();
    this.controllers.set(key, controller);
    const seq = (this.sequence.get(key) ?? 0) + 1;
    this.sequence.set(key, seq);
    const result = await this.client.get<T>(path, controller.signal);
    if (this.sequence.get(key) !== seq) return undefined;
    return result;
  }
  cancel(key: string) { this.controllers.get(key)?.abort(); this.sequence.set(key, (this.sequence.get(key) ?? 0) + 1); }
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const fetcher = options.fetcher ?? fetch;
  const baseUrl = options.baseUrl ?? "/api/v1";

  async function request<T>(path: string, init: RequestInit = {}): Promise<ApiEnvelope<T>> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    if (options.csrfToken) headers.set("X-CSRF-Token", options.csrfToken);
    const response = await fetcher(`${baseUrl}${path}`, {
      ...init,
      credentials: "include",
      headers,
    });
    const payload = (await response.json().catch(() => null)) as (ApiEnvelope<T> & { error?: StructuredApiErrorBody }) | StructuredApiErrorBody | null;
    if (!response.ok) {
      const body = payload && "error" in payload && payload.error ? payload.error : payload && "code" in payload ? payload : { code: "HTTP_ERROR", message: `Request failed (${response.status})` };
      throw new StructuredApiError(body, response.status);
    }
    if (!payload || !("data" in payload)) {
      throw new StructuredApiError({ code: "MALFORMED_RESPONSE", message: "The server returned an invalid response." }, response.status);
    }
    return payload;
  }

  return {
    request,
    get: (path, signal) => request(path, { method: "GET", signal }),
    post: (path, body, signal) => request(path, { method: "POST", body: JSON.stringify(body), signal }),
  };
}
