import {
  DEFAULT_RELAY_ENDPOINT,
  buildDaemonWebSocketUrl,
  buildRelayWebSocketUrl as buildSharedRelayWebSocketUrl,
  deriveLabelFromEndpoint,
  extractHostPortFromWebSocketUrl,
  normalizeHostPort,
  parseConnectionUri,
  parseHostPort,
  serializeConnectionUri,
  serializeConnectionUriForStorage,
  shouldUseTlsForDefaultHostedRelay,
  type HostPortParts,
} from "@omp-desktop/protocol/daemon-endpoints";
import { parseRelayAddress, type ConnectionOffer } from "@omp-desktop/protocol/connection-offer";

export { decodeOfferFragmentPayload } from "@omp-desktop/protocol/connection-offer";

export type { HostPortParts };

export {
  buildDaemonWebSocketUrl,
  deriveLabelFromEndpoint,
  extractHostPortFromWebSocketUrl,
  normalizeHostPort,
  parseConnectionUri,
  parseHostPort,
  serializeConnectionUri,
  serializeConnectionUriForStorage,
  shouldUseTlsForDefaultHostedRelay,
};

export interface RelayServerAddress {
  endpoint: string;
  useTls: boolean;
}
const configuredDefaultRelay = process.env.EXPO_PUBLIC_RELAY_SERVER_ADDRESS?.trim();
export const DEFAULT_RELAY_SERVER_ADDRESS = configuredDefaultRelay
  ? formatRelayServerAddress(parseRelayServerAddress(configuredDefaultRelay))
  : `wss://${DEFAULT_RELAY_ENDPOINT}`;

export function parseRelayServerAddress(input: string): RelayServerAddress {
  const address = input.trim();
  return parseRelayAddress(address, shouldUseTlsForDefaultHostedRelay(address));
}

export function formatRelayServerAddress(address: RelayServerAddress): string {
  return `${address.useTls ? "wss" : "ws"}://${address.endpoint}`;
}

export function applyConfiguredRelayToOffer(
  offer: ConnectionOffer,
  configuredAddress: string,
): ConnectionOffer {
  if (!configuredAddress.trim()) return offer;
  return {
    ...offer,
    relay: parseRelayServerAddress(configuredAddress),
  };
}

export function buildRelayWebSocketUrl(params: {
  endpoint: string;
  serverId: string;
  useTls: boolean;
}): string {
  return buildSharedRelayWebSocketUrl({ ...params, role: "client" });
}
