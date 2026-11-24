const FORMATS = new Map<string, string>([
  ["gzip", "gzip"],
  ["x-gzip", "gzip"],
  ["deflate", "deflate"],
  ["br", "brotli"],
  ["zstd", "zstd"],
]);

export function contentCodings(headers: Headers): string[] {
  const value = headers.get("content-encoding");
  if (value === null) return [];
  return value
    .split(",")
    .map((coding) => coding.trim().toLowerCase())
    .filter((coding) => coding !== "" && coding !== "identity");
}

function looksEncoded(format: string, bytes: Uint8Array): boolean {
  if (format !== "gzip" && format !== "deflate") return true;
  if (bytes.length < 2) return false;
  if (format === "gzip") return bytes[0] === 0x1f && bytes[1] === 0x8b;
  return (bytes[0] & 0x0f) === 8 && bytes[0] >> 4 <= 7 && ((bytes[0] << 8) | bytes[1]) % 31 === 0;
}

function decompressor(format: string): DecompressionStream | null {
  try {
    return new DecompressionStream(format as CompressionFormat);
  } catch {
    return null;
  }
}

async function decompress(bytes: Uint8Array, stream: DecompressionStream): Promise<Uint8Array> {
  const source = new Response(new Uint8Array(bytes)).body;
  if (source === null) return new Uint8Array(0);
  return new Uint8Array(await new Response(source.pipeThrough(stream)).arrayBuffer());
}

export async function decodeContent(
  body: Uint8Array,
  codings: readonly string[],
): Promise<Uint8Array | null> {
  let out = body;
  for (let i = codings.length - 1; i >= 0; i--) {
    const format = FORMATS.get(codings[i]) ?? codings[i];
    const stream = decompressor(format);
    if (stream === null) return null;
    if (!looksEncoded(format, out)) return out;
    try {
      out = await decompress(out, stream);
    } catch {
      return null;
    }
  }
  return out;
}
