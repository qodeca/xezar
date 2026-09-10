# Remote access — macOS + ngrok

Expose a xezar cockpit running on your **Mac** to the internet through an
[ngrok](https://ngrok.com) tunnel — no ports to open, no TLS to manage.

**How it's wired:** xezar runs locally on the Mac. **ngrok** is the public
front (in place of nginx+certbot): it provides the public HTTPS URL, and its
built-in `--basic-auth` is the identity gate (the htpasswd equivalent). A
**launchd** agent keeps the tunnel up and restarts it on login (the systemd
equivalent).

```
  internet ──HTTPS──► ngrok tunnel ──►  xezar (localhost:4321)
                      --basic-auth              launchd agent
```

---

## Prerequisites

- macOS with [Homebrew](https://brew.sh).
- An [ngrok account](https://dashboard.ngrok.com) and its **authtoken**.
- A **reserved domain** on ngrok (recommended, so the URL is stable) — optional;
  without one you get an ephemeral URL.
- At least one logged-in agent CLI — `claude`, `codex`, `pi`, or OpenCode (experimental).

---

## Install

```bash
xezar server-install --platform macosx-ngrok
```

### What each step does

| Step | What happens |
|------|--------------|
| **Dependencies** | Detects the agent CLIs / `gh` / `git`; offers to `brew install` the missing ones. |
| **Autostart** | Installs a **launchd** agent (`~/Library/LaunchAgents/ai.xezar.cockpit.plist`, written `0600`) with `RunAtLoad` + `KeepAlive` that runs the cockpit itself, so xezar comes back at login. The tunnel has its own agent, installed by the next step. |
| **ngrok tunnel** | Installs ngrok if needed, saves your **authtoken** (passed via the environment, never on a command line `ps` could read), and configures the tunnel to the cockpit port with **`--basic-auth`** (username + password) and, if provided, your **reserved domain**. It installs a second launchd agent, `ai.xezar.ngrok`, whose plist embeds those credentials and is written `0600`. |
| **Verify** | Confirms the tunnel came up — the installer polls ngrok's local API at `localhost:4040` for a public URL. Basic-auth is enforced by ngrok at its edge; the installer sends no request through the tunnel to test the gate. |

The **username + password** you set become the ngrok `--basic-auth`
credentials — what you type in the browser to reach the cockpit over the public
HTTPS URL.

---

## Updating / redeploying

Reload the public tunnel with the standardized command:

```bash
xezar server-deploy --platform macosx-ngrok
```

`server-deploy` restarts **both** launchd agents — the xezar cockpit and the
ngrok tunnel — and then re-verifies the tunnel. You no longer restart xezar by
hand.

To change the setup itself, the installer is idempotent:

```bash
xezar server-install --platform macosx-ngrok --reconfigure autostart
xezar server-install --platform macosx-ngrok --reinstall   # redo everything
```

The step ids are `deps`, `autostart`, `ngrok` and `identity`. `--reconfigure
autostart` re-runs the **cockpit** agent; to change the authtoken, the reserved
domain or the basic-auth login, use `--reconfigure ngrok`.

---

## Uninstall

```bash
xezar server-uninstall --platform macosx-ngrok
```

Removes **both** launchd plists xezar **owns** (`ai.xezar.cockpit`,
`ai.xezar.ngrok`) and the tunnel config. The ngrok **authtoken** stays in
ngrok's own config, and shared tools (ngrok, the agent CLIs, `gh`) are *listed*
for manual removal, not deleted.

---

← Back to [Remote access overview](./README.md)
