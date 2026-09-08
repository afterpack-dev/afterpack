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

export async function* streamSSE(
  url: string,
  options?: RequestInit,
): AsyncGenerator<SSEEvent> {
  const response = await fetch(url, options);

  if (!response.ok) {
    if (response.status === 429) {
      const body = await response.json().catch(() => null);
      if (
        body &&
        typeof body === "object" &&
        (body as { error?: unknown }).error === "rate_limited"
      ) {
        const b = body as {
          retryAfterSeconds?: number;
          scansIn24h?: number;
        };
        throw new RateLimitedError(
          typeof b.retryAfterSeconds === "number" ? b.retryAfterSeconds : null,
          typeof b.scansIn24h === "number" ? b.scansIn24h : null,
        );
      }
    }
    throw new Error(
      `SSE request failed: ${response.status} ${response.statusText}`,
    );
  }

  const body = response.body;
  if (!body) {
    throw new Error("SSE response has no body");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "message";
  let currentData: string[] = [];

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });

    const lines = buffer.split("\n");
    // Keep the last incomplete line in the buffer
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.startsWith("event:")) {
        currentEvent = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        currentData.push(line.slice(5).trim());
      } else if (line === "") {
        // Empty line = end of event
        if (currentData.length > 0) {
          yield { event: currentEvent, data: currentData.join("\n") };
          currentEvent = "message";
          currentData = [];
        }
      }
    }
  }

  // Flush any remaining event
  if (currentData.length > 0) {
    yield { event: currentEvent, data: currentData.join("\n") };
  }
}
