# Remote access

Use this page to reach a cockpit running on another machine. Choose a deployment option, put authentication in front of the server, and understand which local-machine actions are unavailable in hosted mode. The linked installation guides contain the platform-specific setup steps.

## To choose local or hosted mode

A normal `xezar` launch binds to `127.0.0.1`, starting at port `4321`. Local mode reports `capabilities.localHandoff: true`. Setting `XEZ_REMOTE=1` or choosing a non-loopback `--bind-host` changes that capability to `false` and enables hosted mode. `XEZ_REMOTE` does not itself change the listening address.

For example, when an authenticated reverse proxy runs on the same host, keep the server on loopback:

```sh
XEZ_REMOTE=1 xezar serve --no-open
```

Use `--bind-host` only when the proxy needs another reachable interface, and restrict access to that address and port. The [external-proxy instructions](../server-install/ubuntu-vps.md#the-box-already-has-a-reverse-proxy-dokploy-coolify-caddy) explain the container-proxy case.

In hosted mode, the API refuses local-machine operations with HTTP `409`, including opening a task in a terminal or editor, editing agent configuration files, changing agent accounts, and attaching a local leader session. Home-directory agent configuration files are not served. For these operations, work from the machine that owns the checkout; a remote browser cannot open your laptop's editor through the server.

The remote cockpit uses authenticated HTTP and server-sent events (SSE) for updates. It does not open the browser WebSocket subscription connection in remote mode: that transport cannot explicitly carry the reverse proxy's credentials.

## To protect the public endpoint

**xezar has no built-in authentication.** Hosted mode disables specific local-machine routes; it does not add a login. Anyone who can reach an unprotected cockpit can request agent work on its host. Put HTTPS and authentication on the proxy or tunnel, and keep direct access to the cockpit port private. This is one user's workspace, not a multi-tenant service.

The server's [request-origin guard](../../packages/xezar/src/server/server.ts) provides additional browser protections:

- In local mode, `/api/*` requests need a loopback `Host` header, including health requests. This protects against DNS rebinding.
- Mutating requests with an `Origin` header must pass the host-and-port comparison, with a specific exception for the local development proxy. Explicit cross-site requests are rejected.
- `/api/v1/health` is the CORS-open discovery endpoint. Requests without an `Origin` header can still reach the API; these guards are not authentication.

Read the [security policy](../../SECURITY.md) before exposing a host that can run coding agents.

## To choose an installation option

There are **two installer providers**, with an external-proxy mode for Ubuntu. These give three deployment choices:

| Choose this when… | Command | Public front and guide |
| --- | --- | --- |
| You have an Ubuntu/Debian VPS and want the installer to manage the front | `xezar server-install --platform ubuntu-vps` | nginx with Basic Auth, optional Let's Encrypt HTTPS, and a systemd service. Follow the [Ubuntu guide](../server-install/ubuntu-vps.md); enable HTTPS for public access. |
| Your Ubuntu host already has a reverse proxy | `xezar server-install --platform ubuntu-vps --external-proxy` | Installs the service without nginx or certbot. Configure TLS and authentication in your existing proxy using the [external-proxy guide](../server-install/ubuntu-vps.md#the-box-already-has-a-reverse-proxy-dokploy-coolify-caddy). |
| You want a tunnel to a Mac | `xezar server-install --platform macosx-ngrok` | ngrok HTTPS and Basic Auth, with launchd agents for the cockpit and tunnel. Follow the [macOS guide](../server-install/macosx-ngrok.md). |

The [installation overview](../server-install/README.md) compares the providers. Install and sign in to an agent CLI on the host under the user running the service; having a CLI binary installed is not the same as having a usable login.

## To redeploy

Use the same platform and, for a named Ubuntu instance, the same `--domain` you installed with:

```sh
xezar server-deploy --platform ubuntu-vps
# Or, for the Mac setup:
xezar server-deploy --platform macosx-ngrok
```

Ubuntu redeploy restarts the service and verifies it. A checkout-based service needs its new build prepared first; an npx-based Ubuntu service has its cached xezar package cleared before restart so it can resolve the published package again. macOS redeploy restarts both launchd agents and verifies that the tunnel is up; it does not probe the public Basic Auth gate. See each provider's **Updating / redeploying** section for the details.

If you need to rewrite the service definition, use `server-install --reconfigure autostart`; restarting alone does not rewrite that definition.

## To uninstall a hosted instance

```sh
xezar server-uninstall --platform ubuntu-vps
# Or:
xezar server-uninstall --platform macosx-ngrok
```

For a named Ubuntu instance, include its `--domain`. Uninstall reverses the instance's owned setup; shared tools are listed for manual removal. External-proxy mode leaves your proxy alone. The Mac uninstall removes both owned launchd agents, but leaves the ngrok authtoken in ngrok's configuration. Follow the provider's uninstall section to see exactly what is removed.

## Related settings / env / config

- `--bind-host`, `--port`, `--no-open`: listening address, starting port and browser opening.
- `XEZ_REMOTE=1`: hosted-mode restrictions even with a loopback bind.
- `--platform`, `--external-proxy`, `--domain`, `--reconfigure`: installer choices; see the [installation overview](../server-install/README.md).
- `XEZ_HOME`: workspace-state location for the service user. See the [environment contract](../../.env.example).

Next: [Project kit](15-project-kit.md)

Describes xezar 0.15.0.
