import type { Guardrail, GuardrailStage } from "@agent-framework/core";

// ------------------------------------------------------------------ PII

export type PIIType = "email" | "phone" | "creditCard" | "ssn" | "iban" | "ipAddress";

const PII_PATTERNS: Record<PIIType, RegExp> = {
  email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  phone: /(?<![\w-]|\d[\s.-])\+?\d{1,3}[\s.-]?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}(?![\w-]|[\s.-]\d)/g,
  creditCard: /\b(?:\d[ -]?){13,19}\b/g,
  ssn: /\b\d{3}-\d{2}-\d{4}\b/g,
  iban: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g,
  ipAddress: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g,
};

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

export interface PIIMatch {
  type: PIIType;
  value: string;
  index: number;
}

/** Deterministic PII detection. Card numbers are Luhn-checked to reduce false positives. */
export function detectPII(text: string, types: readonly PIIType[] = Object.keys(PII_PATTERNS) as PIIType[]): PIIMatch[] {
  const matches: PIIMatch[] = [];
  for (const type of types) {
    for (const m of text.matchAll(PII_PATTERNS[type])) {
      const value = m[0];
      if (type === "creditCard") {
        const digits = value.replace(/\D/g, "");
        if (digits.length < 13 || !luhn(digits)) continue;
      }
      if (type === "phone" && value.replace(/\D/g, "").length < 9) continue;
      matches.push({ type, value, index: m.index });
    }
  }
  // Prefer the most specific type when patterns overlap (e.g. a card number also looks like a phone).
  const order: PIIType[] = ["creditCard", "iban", "ssn", "email", "ipAddress", "phone"];
  return matches
    .sort((a, b) => a.index - b.index || order.indexOf(a.type) - order.indexOf(b.type))
    .filter((m, i, all) => !all.slice(0, i).some((p) => m.index < p.index + p.value.length));
}

export function redactPII(text: string, types?: readonly PIIType[]): string {
  let out = text;
  for (const m of detectPII(text, types).sort((a, b) => b.index - a.index)) {
    out = `${out.slice(0, m.index)}[${m.type.toUpperCase()}]${out.slice(m.index + m.value.length)}`;
  }
  return out;
}

export function piiGuardrail(options: { action?: "redact" | "block"; types?: readonly PIIType[]; stages?: readonly GuardrailStage[] } = {}): Guardrail {
  const action = options.action ?? "redact";
  return {
    name: "pii",
    stages: options.stages ?? ["input", "output"],
    check(content) {
      const found = detectPII(content, options.types);
      if (found.length === 0) return { action: "allow" };
      const kinds = [...new Set(found.map((f) => f.type))].join(", ");
      return action === "block"
        ? { action: "block", reason: `Contains PII: ${kinds}` }
        : { action: "redact", content: redactPII(content, options.types), reason: `Redacted PII: ${kinds}` };
    },
  };
}

// ------------------------------------------------------------------ prompt injection

const INJECTION_SIGNALS: { pattern: RegExp; weight: number; label: string }[] = [
  { pattern: /\b(ignore|disregard|forget)\b.{0,30}\b(previous|prior|above|earlier|all)\b.{0,30}\b(instructions?|rules|prompts?|messages?)\b/i, weight: 0.6, label: "override-instructions" },
  { pattern: /\byou are now\b|\bact as\b.{0,40}\b(unrestricted|jailbroken|developer mode|DAN)\b/i, weight: 0.4, label: "role-hijack" },
  { pattern: /\b(system|developer)\s*(prompt|message|instructions?)\b.{0,40}\b(reveal|show|print|repeat|output)\b|\b(reveal|show|print|repeat)\b.{0,40}\b(system|hidden)\s*(prompt|instructions?)\b/i, weight: 0.5, label: "prompt-exfiltration" },
  { pattern: /<\/?(system|assistant|im_start|im_end)>|\[\/?INST\]|###\s*(system|instruction)/i, weight: 0.4, label: "fake-delimiters" },
  { pattern: /\b(send|post|upload|exfiltrate|forward)\b.{0,60}\b(https?:\/\/|api key|password|credentials|token|secret)/i, weight: 0.5, label: "exfiltration" },
  { pattern: /\b(call|use|invoke|run)\b.{0,20}\b(the )?tool\b.{0,60}\b(delete|transfer|pay|drop|grant)\b/i, weight: 0.4, label: "tool-coercion" },
  { pattern: /\bdo not (tell|inform|mention)\b.{0,30}\b(user|anyone)\b/i, weight: 0.3, label: "concealment" },
];

export interface InjectionAssessment {
  score: number;
  signals: string[];
}

/**
 * Heuristic prompt-injection scoring (0–1). Deterministic and cheap; combine
 * with a classifier through the DecisionEngine for higher recall. Detection is
 * defense in depth: the tool boundary stays the real control.
 */
export function detectPromptInjection(text: string): InjectionAssessment {
  const signals = INJECTION_SIGNALS.filter((s) => s.pattern.test(text));
  const score = Math.min(1, signals.reduce((sum, s) => sum + s.weight, 0));
  return { score, signals: signals.map((s) => s.label) };
}

export function promptInjectionGuardrail(options: { threshold?: number; stages?: readonly GuardrailStage[] } = {}): Guardrail {
  const threshold = options.threshold ?? 0.5;
  return {
    name: "prompt-injection",
    stages: options.stages ?? ["input", "tool_result"],
    check(content) {
      const { score, signals } = detectPromptInjection(content);
      return score >= threshold ? { action: "block", reason: `Possible prompt injection (${signals.join(", ")}; score ${score.toFixed(2)})` } : { action: "allow" };
    },
  };
}

// ------------------------------------------------------------------ content, secrets, size

export function contentPolicyGuardrail(options: { name?: string; deny: readonly (RegExp | string)[]; stages?: readonly GuardrailStage[] }): Guardrail {
  const patterns = options.deny.map((d) => (typeof d === "string" ? new RegExp(d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") : d));
  return {
    name: options.name ?? "content-policy",
    stages: options.stages ?? ["input", "output"],
    check(content) {
      const hit = patterns.find((p) => p.test(content));
      return hit === undefined ? { action: "allow" } : { action: "block", reason: `Matched denied pattern ${hit.source}` };
    },
  };
}

const SECRET_PATTERNS: RegExp[] = [
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
];

/** Redact credentials from tool results and outputs so they never reach the model or the user. */
export function secretLeakGuardrail(options: { stages?: readonly GuardrailStage[] } = {}): Guardrail {
  return {
    name: "secret-leak",
    stages: options.stages ?? ["tool_result", "output"],
    check(content) {
      let out = content;
      for (const p of SECRET_PATTERNS) out = out.replace(p, "[REDACTED_SECRET]");
      return out === content ? { action: "allow" } : { action: "redact", content: out, reason: "Credential-like value redacted" };
    },
  };
}

export function maxLengthGuardrail(options: { maxChars: number; stages?: readonly GuardrailStage[]; action?: "block" | "truncate" }): Guardrail {
  return {
    name: "max-length",
    stages: options.stages ?? ["input"],
    check(content) {
      if (content.length <= options.maxChars) return { action: "allow" };
      return options.action === "truncate"
        ? { action: "redact", content: content.slice(0, options.maxChars), reason: `Truncated to ${options.maxChars} characters` }
        : { action: "block", reason: `Longer than ${options.maxChars} characters` };
    },
  };
}
