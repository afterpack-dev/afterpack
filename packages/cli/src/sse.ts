export interface SSEEvent {
  event: string;
  data: string;
}

export class RateLimitedError extends Error {
  readonly retryAfterSeconds: number | null;
  readonly scansIn24h: number | null;

  constructor(retryAfterSeconds: number | null, scansIn24h: number | null) {
    super("Rate limited");
    this.name = "RateLimitedError";
    this.retryAfterSeconds = retryAfterSeconds;
    this.scansIn24h = scansIn24h;
  }
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export async function* streamSSE(
  url: string,
  options?: RequestInit,
  fetchImpl: FetchLike = fetch,
): AsyncGenerator<SSEEvent> {
  const response = await fetchImpl(url, options);

  if (!response.ok) {
    if (response.status === 429) {
      const body = (await response.json().catch(() => null)) as {
        error?: unknown;
        retryAfterSeconds?: number;
        scansIn24h?: number;
      } | null;
      if (body && typeof body === "object" && body.error === "rate_limited") {
        throw new RateLimitedError(
          typeof body.retryAfterSeconds === "number" ? body.retryAfterSeconds : null,
          typeof body.scansIn24h === "number" ? body.scansIn24h : null,
        );
      }
    }
    throw new Error(`SSE request failed: ${response.status} ${response.statusText}`);
  }

  const body = response.body;
  if (!body) throw new Error("SSE response has no body");

  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "message";
  let currentData: string[] = [];

  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.startsWith("event:")) {
        currentEvent = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        currentData.push(line.slice(5).trim());
      } else if (line.trim() === "" && currentData.length > 0) {
        yield { event: currentEvent, data: currentData.join("\n") };
        currentEvent = "message";
        currentData = [];
      }
    }
  }

  if (currentData.length > 0) yield { event: currentEvent, data: currentData.join("\n") };
}
