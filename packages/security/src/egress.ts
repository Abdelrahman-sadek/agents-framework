import { lookup as dnsLookupCallback, type LookupAddress, type LookupOptions } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { PolicyViolationError, ToolError } from "@agent-farmework/core";

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
  /**
   * Whether a resolved address may be connected to. `safeFetch` calls it at
   * connect time, so the address that was checked is the address used (no
   * DNS-rebinding window). Policies without it get the private-address check.
   */
  allowsAddress?(address: string): boolean;
}

function isPrivateIPv4(ip: string): boolean {
  const [a = 0, b = 0, c = 0] = ip.split(".").map(Number);
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

/** Expand any textual IPv6 form (compressed, embedded IPv4) to eight 16-bit groups. */
function parseIPv6(ip: string): number[] | undefined {
  let text = ip.split("%")[0] ?? ip;
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)?.[1];
  if (v4 !== undefined) {
    const [a = 0, b = 0, c = 0, d = 0] = v4.split(".").map(Number);
    text = `${text.slice(0, -v4.length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", tail] = text.split("::");
  const left = head === "" ? [] : head.split(":");
  const right = tail === undefined || tail === "" ? [] : tail.split(":");
  const fill = tail === undefined ? 0 : 8 - left.length - right.length;
  const groups = [...left, ...Array<string>(Math.max(0, fill)).fill("0"), ...right].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : undefined;
}

const v4From = (hi: number, lo: number): string => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;

export function isPrivateAddress(address: string): boolean {
  const ip = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(ip) === 4) return isPrivateIPv4(ip);
  if (isIP(ip) !== 6) return false;
  const g = parseIPv6(ip);
  if (g === undefined) return true; // unparseable: fail closed
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
  const zeroPrefix = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  if (zeroPrefix && g5 === 0) return g6 === 0 ? g7 <= 1 : isPrivateIPv4(v4From(g6, g7)); // ::, ::1, IPv4-compatible
  if (zeroPrefix && g5 === 0xffff) return isPrivateIPv4(v4From(g6, g7)); // IPv4-mapped
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0xffff && g5 === 0) return isPrivateIPv4(v4From(g6, g7)); // IPv4-translated (SIIT)
  if (g0 === 0x64 && g1 === 0xff9b) return g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 ? isPrivateIPv4(v4From(g6, g7)) : true; // NAT64
  if (g0 === 0x2002) return isPrivateIPv4(v4From(g1, g2)); // 6to4
  if (g0 === 0x2001 && g1 === 0) return true; // Teredo (embeds an obfuscated IPv4)
  if (g0 === 0x2001 && g1 === 0xdb8) return true; // documentation
  if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) return true; // discard-only
  return (g0 & 0xfe00) === 0xfc00 || (g0 & 0xffc0) === 0xfe80 || (g0 & 0xffc0) === 0xfec0 || (g0 & 0xff00) === 0xff00;
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
    allowsAddress(address) {
      return options.allowPrivateNetworks === true || !isPrivateAddress(address);
    },
  };
}

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** A dns.lookup that refuses addresses the policy does not allow; used for the actual socket connection. */
function guardedLookup(policy: EgressPolicy) {
  const allowed = (address: string): boolean => (policy.allowsAddress === undefined ? !isPrivateAddress(address) : policy.allowsAddress(address));
  return (hostname: string, options: LookupOptions, callback: LookupCallback): void => {
    dnsLookupCallback(hostname, { ...options, all: true }, (error, addresses) => {
      if (error !== null) return callback(error, []);
      const list = addresses as LookupAddress[];
      if (list.length === 0 || list.some((a) => !allowed(a.address))) {
        return callback(new PolicyViolationError(`Host '${hostname}' resolves to a private or reserved address`) as unknown as NodeJS.ErrnoException, []);
      }
      if (options.all === true) return callback(null, list);
      const first = list[0] as LookupAddress;
      callback(null, first.address, first.family);
    });
  };
}

const NULL_BODY = new Set([101, 204, 205, 304]);

/** Minimal fetch over node:http(s) whose sockets connect only to policy-approved addresses. */
function pinnedFetch(policy: EgressPolicy, maxBytes: number): typeof fetch {
  return (async (input: URL, init: RequestInit & { signal: AbortSignal }) => {
    const url = new URL(input);
    const request = url.protocol === "http:" ? httpRequest : httpsRequest;
    const headers = new Headers(init.headers);
    const body = init.body === undefined || init.body === null ? undefined : typeof init.body === "string" ? init.body : String(init.body);
    return await new Promise<Response>((resolvePromise, reject) => {
      const req = request(
        url,
        { method: init.method ?? "GET", headers: Object.fromEntries(headers), lookup: guardedLookup(policy) as never, signal: init.signal },
        (res: IncomingMessage) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > maxBytes) {
              res.destroy();
              reject(new ToolError(`Response larger than ${maxBytes} bytes`));
            } else chunks.push(chunk);
          });
          res.on("error", reject);
          res.on("end", () => {
            const out = new Headers();
            for (const [key, value] of Object.entries(res.headers)) {
              for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) out.append(key, v);
            }
            const status = res.statusCode ?? 502;
            resolvePromise(new Response(NULL_BODY.has(status) ? null : Buffer.concat(chunks), { status, headers: out }));
          });
        },
      );
      req.on("error", reject);
      req.end(body);
    });
  }) as unknown as typeof fetch;
}

export interface SafeFetchOptions {
  policy: EgressPolicy;
  maxRedirects?: number;
  /** Response bodies larger than this are rejected. Default 1 MB. */
  maxBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Custom transport. It bypasses connect-time address pinning; use only in tests or behind an egress proxy. */
  fetchImpl?: typeof fetch;
}

/** fetch() with the egress policy applied to the URL and to every redirect hop, plus size and time limits. */
export async function safeFetch(url: string, init: RequestInit, options: SafeFetchOptions): Promise<{ status: number; headers: Headers; body: string }> {
  const maxBytes = options.maxBytes ?? 1_000_000;
  // Default transport pins each connection to an address the policy approved at connect time.
  const fetchImpl = options.fetchImpl ?? pinnedFetch(options.policy, maxBytes);
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
