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

Deploy the [Paseo Relay OCI image](https://github.com/getpaseo/paseo-relay) pinned to a verified image digest, using Docker or Podman under a process supervisor. Serve the Web export as static files through your HTTPS reverse proxy. Forward `/ws` using HTTP/1.1 WebSocket upgrades with proxy buffering disabled. The relay machine does not need OMP or access to the daemon's private listening port.

For a standalone Podman service using host networking, set `RELEASE_DISTRIBUTION=none` so Erlang cluster listeners are not exposed. Configure the relay bind address and port with `PASEO_RELAY_HOST` and `PASEO_RELAY_PORT`; add a memory limit and a suitable `PASEO_RELAY_MEMORY_WATERMARK_BYTES` on small hosts. Verify `/ready` and a real encrypted WebSocket exchange before changing existing daemon connections.

#### Hangzhou Web and relay

Open `https://omp.myzhijieyun.cn` for the Web client. Its deployment defaults to `wss://omp.myzhijieyun.cn`; configure daemons with `omp.myzhijieyun.cn:443` and `useTls: true`. Set their `app.baseUrl` to `https://omp.myzhijieyun.cn` to generate pairing links for this Web deployment.

The build-time `EXPO_PUBLIC_RELAY_SERVER_ADDRESS` sets the default Relay for new client profiles. Saved client Relay settings continue to override that default; builds without this variable retain the hosted Relay default.

On `HZProxyServer` (`114.55.112.128`), `/etc/nginx/conf.d/omp-relay.conf` terminates TLS and serves `/var/www/omp-web/current`. `/ws`, `/health`, `/ready` and `/metrics` still forward to `127.0.0.1:4000`. Nginx falls back to `index.html` for application routes, returns `404` for missing exported assets, serves precompressed files, and revalidates HTML instead of caching an obsolete app shell.

The backend is managed by `/etc/systemd/system/omp-relay-hz.service`, enabled for `multi-user.target` to start at boot. It runs the pinned Podman image with environment from `/etc/omp-relay-hz.env`, retries failed starts with `Restart=on-failure`, and waits for `/ready` before completing startup. Its `podman run --replace --rm` command replaces stale `omp-relay-hz` containers so name collisions cannot block a restart.

Enable, start and check the relay independently of the Web export:

```bash
ssh HZProxyServer 'systemctl enable --now omp-relay-hz.service && systemctl is-active omp-relay-hz.service && systemctl is-enabled omp-relay-hz.service'
curl --fail https://omp.myzhijieyun.cn/health
curl --fail https://omp.myzhijieyun.cn/ready
```

Keep TCP `80` and `443` allowed in the cloud security group. Port `80` redirects to HTTPS except for the ACME challenge path. Clients using the old public `:4000` endpoint must switch to WSS if that port is no longer allowed.

Build and publish another version from the repository root:

```bash
npm run clean --workspace=@omp-desktop/app
EXPO_PUBLIC_RELAY_SERVER_ADDRESS=wss://omp.myzhijieyun.cn \
  npm run build:web --workspace=@omp-desktop/app -- --clear
gzip -9 -k packages/app/dist/_expo/static/js/web/*.js packages/app/dist/_expo/static/css/*.css packages/app/dist/index.html packages/app/dist/metadata.json packages/app/dist/manifest.json packages/app/dist/*.wasm packages/app/dist/*.js
RELEASE="$(date -u +%Y%m%dT%H%M%SZ)"
ssh HZProxyServer "install -d -m 0755 /var/www/omp-web/releases/$RELEASE"
rsync -az --chmod=D755,F644 packages/app/dist/ "HZProxyServer:/var/www/omp-web/releases/$RELEASE/"
ssh HZProxyServer "ln -s releases/$RELEASE /var/www/omp-web/.current-$RELEASE && mv -Tf /var/www/omp-web/.current-$RELEASE /var/www/omp-web/current"
curl --fail https://omp.myzhijieyun.cn/ready
```

Release directories remain under `/var/www/omp-web/releases`; switch `current` atomically to a retained release to roll back a later update. The initial relay-only Nginx configuration is retained at `/var/www/omp-web/nginx-before-20261112T120519Z.conf`. Restore that configuration and run `nginx -t && systemctl reload nginx` to undo the initial Web routing change.

Certbot uses `/var/lib/letsencrypt` for HTTP validation and `certbot.timer` for automatic renewal. The executable deploy hook `/etc/letsencrypt/renewal-hooks/deploy/omp-relay-nginx` checks the Nginx configuration and reloads the renewed certificate.

```bash
ssh HZProxyServer 'certbot renew --cert-name omp.myzhijieyun.cn --dry-run --run-deploy-hooks --no-random-sleep-on-renew'
```

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

In Desktop, **Settings → Connections → Relay server address** reads the local daemon's configuration, regardless of the selected Host. Open the arrow beside the address to choose a previous Relay; selecting an entry saves and applies it immediately. For a new address, type it and click **Save relay address**. Successfully saved addresses are retained in the client's settings, deduplicated, and ordered by most recent use; the current daemon address is also available in the dropdown. A non-empty selection enables Relay and persists both the outbound and advertised public endpoint/TLS settings to that daemon home's `config.json` (`~/.omp-desktop/config.json` by default). The running daemon switches without restarting, and new pairing links use the selected address. Saving and history selection are unavailable while the local daemon is loading or disconnected.

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
