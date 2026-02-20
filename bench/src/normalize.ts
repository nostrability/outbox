import type { FilterProfile, FilteredUrlReport, RelayUrl } from "./types.ts";

const KNOWN_BAD_RELAYS = new Set([
  "wss://feeds.nostr.band",
  "wss://filter.nostr.wine",
  "wss://nwc.primal.net",
  "wss://relay.getalby.com",
  "wss://nostr.mutinywallet.com",
]);

const LOCALHOST_PATTERNS = ["localhost", "127.0.0.1", "::1"];

function removeTrailingSlash(pathname: string): string {
  if (!pathname || pathname === "/") return "";
  let output = pathname;
  while (output.length > 1 && output.endsWith("/")) {
    output = output.slice(0, -1);
  }
  return output;
}

/**
 * Normalize relay URLs to a stable `wss://host[:port][/path]` form.
 * Returns null for invalid or unsupported URLs.
 */
export function normalizeRelayUrl(input: string): RelayUrl | null {
  if (!input) return null;

  let value = input.trim();
  if (!value) return null;

  if (!value.includes("://")) {
    value = `wss://${value}`;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  const protocol = url.protocol.toLowerCase();
  if (protocol === "http:" || protocol === "https:" || protocol === "ws:") {
    url.protocol = "wss:";
  } else if (protocol !== "wss:") {
    return null;
  }

  if (!url.hostname) return null;

  url.username = "";
  url.password = "";
  url.hash = "";
  url.search = "";

  const host = url.hostname.toLowerCase();
  const defaultPort = "443";
  const port = url.port && url.port !== defaultPort ? `:${url.port}` : "";
  const pathname = removeTrailingSlash(url.pathname);

  return `wss://${host}${port}${pathname}`;
}

export interface FilterResult {
  url: RelayUrl;
  accepted: boolean;
  reason?: "localhost" | "ipAddress" | "insecureWs" | "knownBad" | "malformed";
  originalUrl: string;
}

function isIpAddress(hostname: string): boolean {
  // IPv4
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return true;
  // IPv6 (bracketed or raw)
  if (hostname.startsWith("[") || hostname.includes(":")) return true;
  return false;
}

function isOnionAddress(hostname: string): boolean {
  return hostname.endsWith(".onion");
}

export function filterRelayUrl(
  originalUrl: string,
  profile: FilterProfile,
): FilterResult {
  const normalized = normalizeRelayUrl(originalUrl);
  if (!normalized) {
    return {
      url: originalUrl,
      accepted: false,
      reason: "malformed",
      originalUrl,
    };
  }

  if (profile === "neutral") {
    return { url: normalized, accepted: true, originalUrl };
  }

  // Strict profile checks
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    return {
      url: normalized,
      accepted: false,
      reason: "malformed",
      originalUrl,
    };
  }

  const hostname = url.hostname.toLowerCase();

  // Check localhost
  if (LOCALHOST_PATTERNS.some((p) => hostname === p)) {
    return {
      url: normalized,
      accepted: false,
      reason: "localhost",
      originalUrl,
    };
  }

  // Check IP-only (non-onion)
  if (isIpAddress(hostname) && !isOnionAddress(hostname)) {
    return {
      url: normalized,
      accepted: false,
      reason: "ipAddress",
      originalUrl,
    };
  }

  // Check ws:// non-onion (original URL was ws:// before normalization)
  const origLower = originalUrl.trim().toLowerCase();
  if (
    origLower.startsWith("ws://") &&
    !isOnionAddress(hostname)
  ) {
    return {
      url: normalized,
      accepted: false,
      reason: "insecureWs",
      originalUrl,
    };
  }

  // Check known-bad relays
  if (KNOWN_BAD_RELAYS.has(normalized)) {
    return {
      url: normalized,
      accepted: false,
      reason: "knownBad",
      originalUrl,
    };
  }

  return { url: normalized, accepted: true, originalUrl };
}

export function filterRelayUrls(
  urls: string[],
  profile: FilterProfile,
): { accepted: RelayUrl[]; report: FilteredUrlReport } {
  const report: FilteredUrlReport = {
    localhost: [],
    ipAddress: [],
    insecureWs: [],
    knownBad: [],
    malformed: [],
    totalRemoved: 0,
  };

  const accepted = new Set<RelayUrl>();

  for (const url of urls) {
    const result = filterRelayUrl(url, profile);
    if (result.accepted) {
      accepted.add(result.url);
    } else {
      report.totalRemoved++;
      switch (result.reason) {
        case "localhost":
          report.localhost.push(result.originalUrl);
          break;
        case "ipAddress":
          report.ipAddress.push(result.originalUrl);
          break;
        case "insecureWs":
          report.insecureWs.push(result.originalUrl);
          break;
        case "knownBad":
          report.knownBad.push(result.originalUrl);
          break;
        case "malformed":
          report.malformed.push(result.originalUrl);
          break;
      }
    }
  }

  return { accepted: [...accepted].sort(), report };
}

export function dedupeAndNormalizeRelays(urls: Iterable<string>): RelayUrl[] {
  const set = new Set<RelayUrl>();
  for (const url of urls) {
    const normalized = normalizeRelayUrl(url);
    if (normalized) set.add(normalized);
  }
  return [...set].sort();
}
