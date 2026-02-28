export interface SSEEvent {
  event: string;
  data: string;
}

export async function* streamSSE(
  url: string,
  options?: RequestInit,
): AsyncGenerator<SSEEvent> {
  const response = await fetch(url, options);

  if (!response.ok) {
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
