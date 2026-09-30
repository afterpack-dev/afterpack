const HASH_LIKE = /[A-Za-z0-9_.~-]{8,}/g;

export function stripHashes(text: string): string {
  return text.replace(HASH_LIKE, (token) =>
    /\d/.test(token) && /[A-Za-z]/.test(token) ? "#" : token,
  );
}
