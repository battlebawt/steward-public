import { describe, expect, it, mock } from "bun:test";
import { createApiClient } from "../src/lib/api";
import { StructuredApiError } from "../src/lib/errors";

describe("API client", () => {
  it("uses credentials, CSRF and abort signals", async () => {
    const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    const fetcher = mock(async (input: RequestInfo | URL, init?: RequestInit) => { calls.push([input, init]); return new Response(JSON.stringify({ data: { ok: true }, requestId: "r1", observedAt: "now" }), { status: 200, headers: { "Content-Type": "application/json" } }); });
    const controller = new AbortController();
    const result = await createApiClient({ csrfToken: "csrf", fetcher }).get("/accounts", controller.signal);
    expect(result.data).toEqual({ ok: true });
    expect(calls[0]?.[0]).toBe("/api/v1/accounts");
    expect(calls[0]?.[1]).toMatchObject({ credentials: "include", signal: controller.signal });
    const headers = calls[0]?.[1]?.headers as Headers;
    expect(headers.get("X-CSRF-Token")).toBe("csrf");
  });

  it("preserves structured server errors", async () => {
    const fetcher = mock(async () => new Response(JSON.stringify({ error: { code: "LIMIT_EXCEEDED", message: "Daily limit exceeded", retryable: false, nextAction: "Request an exact exception approval." }, requestId: "r2", observedAt: "now" }), { status: 409 }));
    await expect(createApiClient({ fetcher }).get("/accounts/a" )).rejects.toBeInstanceOf(StructuredApiError);
    await expect(createApiClient({ fetcher }).get("/accounts/a" )).rejects.toMatchObject({ code: "LIMIT_EXCEEDED", nextAction: "Request an exact exception approval." });
  });
});
