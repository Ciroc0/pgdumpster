function decodeJwtRole(value: string): string | undefined {
  const payload = value.split(".")[1];
  if (payload === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    if (parsed === null || typeof parsed !== "object" || !("role" in parsed)) {
      return undefined;
    }
    return typeof parsed.role === "string" ? parsed.role : undefined;
  } catch {
    return undefined;
  }
}

export function storageCredentialClass(
  value: string,
): "privileged" | "unprivileged" | "unknown" {
  if (value.startsWith("sb_secret_")) return "privileged";
  if (value.startsWith("sb_publishable_")) return "unprivileged";
  const role = decodeJwtRole(value);
  if (role === "service_role") return "privileged";
  if (role === "anon") return "unprivileged";
  return "unknown";
}
