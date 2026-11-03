# Self-hosted Web and relay

The default configuration enables the hosted Relay at `relay.paseo.sh:443` with TLS. Self-hosted deployments can replace that endpoint and do not otherwise depend on a hosted Paseo service.

All commands below run from the repository root. For SSH-managed daemon installation, see [remote hosts](remote-hosts.md); for native application installers, see [packaging](packaging.md).

## Build the Web client and backend

```bash
npm install
npm run build:server
npm run build --workspace=@omp-desktop/cli
npm run build:web --workspace=@omp-desktop/app
```

The Web export is `packages/app/dist`. These commands build artifacts; they do not start the daemon. The [development guide](development.md#workspace-packages) describes the workspace packages.

## Deploy the Web export

### Cloudflare Pages

```bash
npm run deploy:web
```

[`scripts/deploy-webui.sh`](../scripts/deploy-webui.sh) builds the Web export and runs `wrangler pages deploy` against project `omp-desktop` on branch `main`. Authenticate Wrangler to the account that owns the Pages project before deploying; merging the fork does not update the hosted mobile site. Override with `CF_PAGES_PROJECT` / `CF_PAGES_BRANCH` if needed. SPA routes fall back through [`packages/app/public/_redirects`](../packages/app/public/_redirects). Pairing links should use the Pages origin as `app.baseUrl`.

### Self-hosted relay and Web domains

Deploy the `paseo-relay` repository using its `deployment/self-hosted/compose.yaml`, `Caddyfile`, and `.env.example`. That deployment serves both your WSS relay and the Web export on your own domains, with automatic HTTPS and SPA route fallback. The relay machine does not need OMP or access to the daemon's private listening port.

## Configure the machine running OMP

Merge this configuration into `~/.omp-desktop/config.json`, retaining your other settings. Replace the example domains with those in the relay deployment:

```json
{
  "version": 1,
  "daemon": {
    "listen": "127.0.0.1:6770",
    "relay": {
      "enabled": true,
      "endpoint": "relay.example.com:443",
      "useTls": true
    }
  },
  "app": {
    "baseUrl": "https://omp.example.com"
  }
}
```

Start the backend, then obtain a pairing link in another terminal:

```bash
node packages/cli/bin/omp-desktop daemon start --foreground --no-web-ui
node packages/cli/bin/omp-desktop daemon pair --json
```

In the Web app, open **Settings → Connections → Relay server address**. It defaults to `wss://relay.paseo.sh:443`; replace it with `wss://relay.example.com` for a self-hosted deployment. Leave the setting empty only when the browser should use the relay address advertised by each pairing link. An already connected host can generate another link from **Settings → Host → Pair device**.

In Desktop, **Settings → Connections → Relay server address** reads the local daemon's configuration, regardless of the selected Host. Saving a non-empty address enables Relay and persists both the outbound and advertised public endpoint/TLS settings to that daemon home's `config.json` (`~/.omp-desktop/config.json` by default). The running daemon applies the change immediately; no restart is needed. Saving is unavailable while the local daemon is loading or disconnected.

The Web/mobile setting changes only that client's pairing address; it does not reconfigure the daemon. Configure the daemon on the OMP machine as shown above, or use Desktop's setting. After switching relays, pair with a newly generated offer and remove the old relay connection from that Host's settings; already saved Host connections retain their original addresses.

Desktop may generate an offer URL using its loopback Web shell. Do not open that `127.0.0.1` URL on a phone: paste the offer into the hosted Web client's pairing dialog, or use the same `#offer=...` fragment with your hosted Web origin.

**Treat pairing links like passwords: anyone holding one can access that daemon.** Legacy placeholder identities require re-pairing after upgrading.

The daemon initiates the outbound connection; **do not expose port `6770` to the Internet**. Keep `PASEO_APP_BASE_URL` / `app.baseUrl` pointed at your own Web deployment so generated links open the right client.

## Environment overrides and reverse proxies

These overrides are useful when the daemon and browser reach different sides of a reverse proxy:

| Environment variable          | Config field                  | Purpose                                                         |
| ----------------------------- | ----------------------------- | --------------------------------------------------------------- |
| `PASEO_RELAY_ENABLED`         | `daemon.relay.enabled`        | Enable or disable Relay access                                  |
| `PASEO_RELAY_ENDPOINT`        | `daemon.relay.endpoint`       | Relay `host:port` dialed by the daemon                          |
| `PASEO_RELAY_USE_TLS`         | `daemon.relay.useTls`         | Outbound daemon TLS                                             |
| `PASEO_RELAY_PUBLIC_ENDPOINT` | `daemon.relay.publicEndpoint` | Browser-facing relay `host:port`; defaults to outbound endpoint |
| `PASEO_RELAY_PUBLIC_USE_TLS`  | `daemon.relay.publicUseTls`   | Browser-facing TLS; defaults to outbound TLS                    |
| `PASEO_APP_BASE_URL`          | `app.baseUrl`                 | Your Web origin in pairing links                                |

Use `true` / `false` for boolean overrides. Relay endpoints are authorities such as `relay.example.com:443`, without a scheme or `/ws` path. Public HTTPS Web deployments need WSS. Disabling TLS for a trusted local development relay does not disable E2EE.

The relay carries daemon WebSocket traffic, including workspace, agent, and terminal control. It does not tunnel arbitrary HTTP endpoints: file downloads and HTTP service previews still need their own reachable address.
