import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { PolicyViolationError, ToolError } from "@agent-framework/core";

export interface EgressPolicyOptions {
  /** Hostnames allowed; `*.example.com` matches subdomains. Required: egress is deny-by-default. */
  allowHosts: readonly string[];
  allowedProtocols?: readonly string[];
  /** Allow private, loopback and link-local addresses (never for model-controlled URLs). Default false. */
  allowPrivateNetworks?: boolean;
  /** DNS resolver, injectable for tests. */
  lookup?: (hostname: string) => Promise<{ address: string }[]>;
}

export interface EgressPolicy {
  /** Throws PolicyViolationError when `url` may not be fetched. */
  check(url: string | URL): Promise<URL>;
}

export function isPrivateAddress(address: string): boolean {
  const ip = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(ip) === 4) {
    const [a = 0, b = 0] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (isIP(ip) === 6) {
    if (ip === "::1" || ip === "::") return true;
    if (ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("fe8") || ip.startsWith("fe9") || ip.startsWith("fea") || ip.startsWith("feb")) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
    return mapped?.[1] !== undefined && isPrivateAddress(mapped[1]);
  }
  return false;
}

function hostAllowed(host: string, allow: readonly string[]): boolean {
  const h = host.toLowerCase();
  return allow.some((pattern) => {
    const p = pattern.toLowerCase();
    return p.startsWith("*.") ? h.endsWith(p.slice(1)) && h.length > p.length - 1 : h === p;
  });
}

/** SSRF protection: protocol + host allow-list + resolved-address checks. */
export function createEgressPolicy(options: EgressPolicyOptions): EgressPolicy {
  const protocols = options.allowedProtocols ?? ["https:"];
  const lookup = options.lookup ?? ((host: string) => dnsLookup(host, { all: true }));
  return {
    async check(input) {
      let url: URL;
      try {
        url = new URL(input);
      } catch {
        throw new PolicyViolationError("Invalid URL");
      }
      if (!protocols.includes(url.protocol)) throw new PolicyViolationError(`Protocol ${url.protocol} is not allowed`);
      if (url.username !== "" || url.password !== "") throw new PolicyViolationError("Credentials in URLs are not allowed");
      const host = url.hostname.replace(/^\[|\]$/g, "");
      if (!hostAllowed(host, options.allowHosts)) throw new PolicyViolationError(`Host '${host}' is not on the egress allow-list`);
      if (options.allowPrivateNetworks !== true) {
        const addresses = isIP(host) !== 0 ? [{ address: host }] : await lookup(host);
        if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) {
          throw new PolicyViolationError(`Host '${host}' resolves to a private or reserved address`);
        }
      }
      return url;
    },
  };
}

export interface SafeFetchOptions {
  policy: EgressPolicy;
  maxRedirects?: number;
  /** Response bodies larger than this are rejected. Default 1 MB. */
  maxBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/** fetch() with the egress policy applied to the URL and to every redirect hop, plus size and time limits. */
export async function safeFetch(url: string, init: RequestInit, options: SafeFetchOptions): Promise<{ status: number; headers: Headers; body: string }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxBytes = options.maxBytes ?? 1_000_000;
  const signals = [AbortSignal.timeout(options.timeoutMs ?? 15_000), ...(options.signal === undefined ? [] : [options.signal])];
  let current = await options.policy.check(url);
  for (let hop = 0; ; hop++) {
    const response = await fetchImpl(current, { ...init, redirect: "manual", signal: AbortSignal.any(signals) });
    if (response.status >= 300 && response.status < 400 && response.headers.has("location")) {
      if (hop >= (options.maxRedirects ?? 3)) throw new PolicyViolationError("Too many redirects");
      current = await options.policy.check(new URL(response.headers.get("location") as string, current));
      continue;
    }
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > maxBytes) throw new ToolError(`Response larger than ${maxBytes} bytes`);
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) throw new ToolError(`Response larger than ${maxBytes} bytes`);
    return { status: response.status, headers: response.headers, body: new TextDecoder().decode(buffer) };
  }
}
