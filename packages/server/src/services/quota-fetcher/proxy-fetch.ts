import { Agent, ProxyAgent, type Dispatcher } from "undici";
import type { ProxyPolicy } from "@omp-desktop/protocol/provider-config";

interface ProxyFetchOptions {
  getProxyPolicy(): ProxyPolicy | undefined;
  provider?: string;
  fetch?: typeof fetch;
}

/** Every request resolves the current policy; direct routing never inherits proxy environment variables. */
export function createProxyFetch(options: ProxyFetchOptions): typeof fetch {
  const fetchApi = options.fetch ?? fetch;
  const dispatchers = new Map<string, Dispatcher>();

  return (input, init) => {
    const policy = options.getProxyPolicy();
    const route = policy?.providers?.[options.provider ?? ""] ?? policy?.default;
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const bypass = isLocalHost(url.hostname) || matchesNoProxy(url, policy?.noProxy ?? []);
    const proxyUrl = policy?.enabled && route?.mode === "proxy" && !bypass ? route.url : "";
    let dispatcher = dispatchers.get(proxyUrl);
    if (!dispatcher) {
      dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : new Agent();
      dispatchers.set(proxyUrl, dispatcher);
    }
    return fetchApi(input, { ...init, dispatcher } as RequestInit);
  };
}

function isLocalHost(host: string): boolean {
  const ip = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (ip === "localhost" || ip.endsWith(".localhost") || ip === "metadata.google.internal") return true;
  if (ip === "::" || ip === "::1" || /^fe[89ab][0-9a-f]:|^f[cd][0-9a-f]{2}:/u.test(ip)) return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/u.exec(ip);
  if (!ipv4) return false;
  const a = Number(ipv4[1]);
  const b = Number(ipv4[2]);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
    (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

function matchesNoProxy(url: URL, rules: readonly string[]): boolean {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return rules.some((rule) => {
    const value = rule.trim().toLowerCase();
    if (value === "*") return true;
    const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/u.exec(value);
    if (!match || (match[2] && match[2] !== port)) return false;
    const target = match[1].replace(/^\[|\]$/g, "").replace(/^\./u, "");
    return host === target || host.endsWith(`.${target}`);
  });
}
