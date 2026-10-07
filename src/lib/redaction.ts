const secrets = new Set<string>();
export const secretKey = (key: string): boolean => /password|secret|token|api.?key|authorization|cookie/i.test(key) && !/^(authorization_url|callback_url)$|_env_var$|(?:Configured|Required|Present)$/.test(key);
export function rememberSecret(value: unknown): void {
  if (typeof value === "string" && value.length >= 8) secrets.add(value);
}
export function redactText(value: string): string {
  for (const [key, secret] of Object.entries(process.env)) if (secretKey(key)) rememberSecret(secret);
  for (const secret of secrets) value = value.split(secret).join("[hidden]");
  return value.replace(/(\/mcp\/)[A-Za-z0-9_-]{8,}/g, "$1[hidden]")
    .replace(/\b(sk-[A-Za-z0-9_-]{16,})\b/g, "[hidden]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\/=-]+/gi, "$1[hidden]")
    .replace(/((?:["']?[\w-]*(?:token|secret|password|api[_-]?key)[\w-]*["']?)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1[hidden]")
    .replace(/(--(?:token|password|secret|api-key)\s+)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1[hidden]");
}
export function redact<T>(value: T): T {
  if (typeof value === "string") return redactText(value) as T;
  if (Array.isArray(value)) return value.map(redact) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
      if (secretKey(key) || key === "headers" || key === "env") {
        if (typeof entry === "object" && entry !== null) {
          Object.values(entry).forEach(rememberSecret);
          return [key, Object.fromEntries(Object.keys(entry).map(k => [k, "[hidden]"]))];
        }
        rememberSecret(entry);
        return [key, entry ? "[hidden]" : entry];
      }
      return [key, redact(entry)];
    })) as T;
  }
  return value;
}
