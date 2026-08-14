import type { Redactor } from "./redactor.js";

export class SecretValue {
  readonly #value: string;

  constructor(value: string, redactor: Redactor) {
    if (value.length === 0) throw new Error("Secret value cannot be empty");
    this.#value = value;
    redactor.register(value);
  }

  expose(): string {
    return this.#value;
  }

  toString(): string {
    return "[REDACTED]";
  }

  toJSON(): string {
    return "[REDACTED]";
  }
}
