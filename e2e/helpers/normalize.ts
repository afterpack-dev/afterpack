const HASH_LIKE = /[A-Za-z0-9_.~-]{8,}/g;
const EXTENSION = /\.(?:[cm]?js|css|json|html|rsc|txt|wasm)(?:\.map)?$/;

export function stripHashes(text: string): string {
  return text.replace(HASH_LIKE, (token) => {
    if (!/\d/.test(token) || !/[A-Za-z]/.test(token)) return token;
    return `#${EXTENSION.exec(token)?.[0] ?? ""}`;
  });
}
