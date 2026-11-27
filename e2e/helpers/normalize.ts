const HASH_LIKE = /[A-Za-z0-9_.~-]{8,}/g;
const EXTENSION = /\.(?:[cm]?js|css|json|html|rsc|txt|wasm)(?:\.map)?$/;
const HEX_QUERY_VALUE = /([?&][^=&]+=)[0-9a-f]{8,}(?=&|$)/gi;

export function stripHashes(text: string): string {
  return text.replace(HASH_LIKE, (token) => {
    const extension = EXTENSION.exec(token)?.[0];
    if (extension === undefined && (!/\d/.test(token) || !/[A-Za-z]/.test(token))) return token;
    return `#${extension ?? ""}`;
  });
}

export function stripQueryHashes(search: string): string {
  return search.replace(HEX_QUERY_VALUE, "$1#");
}
