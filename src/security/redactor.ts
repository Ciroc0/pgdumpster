const SECRET_PATTERNS: readonly RegExp[] = [
  /\bBearer\s+[^\s,;]+/giu,
  /\b(?:sbp|sb_secret|service_role)_[A-Za-z0-9._-]+\b/gu,
  /\b(?:postgres(?:ql)?):\/\/[^\s/@:]+:[^\s/@]+@/giu,
  /\b(?:AWS_SECRET_ACCESS_KEY|PGDUMPSTER_ACCESS_TOKEN|PGDUMPSTER_DB_URL)\s*[=:]\s*[^\s]+/giu,
];

export class Redactor {
  readonly #secrets = new Set<string>();

  register(secret: string): void {
    if (secret.length < 4) {
      throw new Error(
        "Refusing to register a secret shorter than 4 characters",
      );
    }
    this.#secrets.add(secret);
  }

  redact(value: string): string {
    let output = value;
    const knownSecrets = [...this.#secrets].sort(
      (left, right) => right.length - left.length,
    );
    for (const secret of knownSecrets)
      output = output.replaceAll(secret, "[REDACTED]");
    for (const pattern of SECRET_PATTERNS)
      output = output.replace(pattern, "[REDACTED]");
    return output;
  }

  sanitize(value: unknown): unknown {
    if (typeof value === "string") return this.redact(value);
    if (Array.isArray(value)) return value.map((entry) => this.sanitize(entry));
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
          key,
          this.sanitize(entry),
        ]),
      );
    }
    return value;
  }
}
