# Chat network proxy

The sidebar's **通过 VPN 联网 / Network proxy** panel routes Claude Code,
Codex and VSCodeModelSwitch's outgoing HTTP(S) requests through an existing
HTTP proxy. For the current host-network Docker setup, the tested address is
`http://127.0.0.1:12000`. This feature is off until **Enable / Apply** is clicked.
It does not start a VPN, change Docker networking, or proxy arbitrary container
applications.

## Apply and verify

1. Keep the host VPN in its currently working mode while installing the VSIX.
2. Open the panel. Enter the HTTP proxy URL and select the client launch settings
   to manage (Claude Code, Codex, or both). URLs containing credentials are not
   supported by this feature. Loopback bypass is always retained.
3. **Test connection** makes unauthenticated HTTPS requests to the selected
   clients' service origins through the entered proxy, without changing settings.
   Any HTTP status, including 401/403, proves transport reachability only. It does
   not verify account access, model streaming, WebSocket behavior or chat.
4. **Enable / Apply** merges the proxy fields into client launch settings. Keep
   TUN on, restart the existing clients or reload the VS Code window, and verify
   a real conversation before changing the host VPN mode.
5. With the host VPN in system-proxy mode and TUN off, verify a new real
   conversation in each selected client. Restore the known-working host mode
   first if connectivity is lost. This final acceptance is separate from local
   automated tests.

An HTTP URL is also correct for HTTPS requests: the client uses CONNECT to carry
the TLS connection through the HTTP proxy. Claude Code does not support SOCKS
proxy configuration, so the shared UI uses the tested HTTP entry.

## Apply error in v0.6.0

Version 0.6.0 can falsely report “A workspace or policy overrides HTTP proxy”
after writing settings, because it checks an old VS Code configuration snapshot.
The failed Apply rolls settings back and leaves the panel Off. Install 0.6.1 or
later and reload the window to load the fix, then Apply again while TUN is still
on. A successful Apply requires another client restart/window reload before
checking chat. Version 0.6.1 reads fresh configuration snapshots for both clients;
actual workspace/policy conflicts still reject Apply and roll back.

## State and actions (v0.6.2)

The panel starts with a text badge: **已启用 / Enabled** (green) or
**已停用 / Disabled**. The badge reflects confirmed configuration, not whether
a connection test or chat has succeeded.

- Off: **启用代理 / Enable** is available; **已停用 / Disabled** cannot be clicked.
- On with unchanged settings: **✓ 已启用 / Enabled** has a green check and is
  disabled; **停用并恢复 / Disable** is available.
- On with edited settings: the active badge remains Enabled, the description
  says changes are not applied, and **应用更改 / Apply changes** is available.
  Reverting the edits disables redundant Apply again. Trailing URL slashes and
  bypass ordering/duplicates do not count as changes.
- Submitting Enable, Apply, Disable or Test locks the proxy controls immediately
  and shows progress. The existing badge remains until the host confirms the
  result. Failures keep the draft and unlock retry without claiming success.

This update does not change proxy routing, settings storage or API compatibility
behavior. Install the new VSIX and reload the window to load the UI; an existing
Enabled configuration does not need another Apply.

## What changes

- Codex IDE: VS Code's global `http.proxy`, read by the installed Codex launcher
  and forwarded as `HTTP_PROXY`/`HTTPS_PROXY` to its new child process. Other
  extensions honoring this editor setting may also be affected.
- Claude Code IDE: only the six proxy variables in
  `claudeCode.environmentVariables`; other entries remain intact.
- Terminals opened by VSModelSwitch: explicit proxy environment for the selected
  tool. Existing terminals and independent CLI launches are not rewritten.
- The extension host's `NO_PROXY`/`no_proxy` environment is set while enabled so
  new Codex child processes inherit local bypass. The installed Codex launcher
  does not forward VS Code's separate bypass settings. Prior environment values
  are restored when the feature is disabled or this extension is disposed.
- Plugin model lists, network/usage queries, verification, speed tests, relay
  calls and proxy web tools use the same network setting. The official Codex
  speed-test child receives the proxy environment explicitly.

Applying a Provider, switching Codex official/API mode or starting/stopping an
API compatibility route does not reset the network proxy. API URLs, keys,
protocol translation, thinking settings and tool mappings retain their original
meaning. Local `/providers/...` calls bypass the network proxy; the relay's
outgoing upstream call uses it.

The saved network configuration is local to the extension's editor environment,
not part of portable Provider exports. Original managed settings are retained in
SecretStorage, including any original authenticated proxy URL; account files and
unrelated environment variables are not copied. Only explicit Apply/Restore
writes editor settings; activation restores the saved transport selection
without rewriting client settings.

## Restore and limits

**Disable / Restore** restores the original managed fields, preserves unrelated
Claude environment entries added later, and removes this feature's launch
environment. Restart existing clients afterward. Restore reports a conflict
instead of overwriting proxy settings changed outside VSModelSwitch. Use Restore
before uninstalling or downgrading this extension.

Localhost, `.localhost`, IPv4 loopback and `::1` always bypass the explicit
transport. Additional bypass entries accept exact hosts, `host:port`, domain
suffixes such as `.example.org`, and `*`; CIDR ranges are not supported here.
Redirects re-evaluate bypass and remove authentication on an origin change.
TLS validation stays enabled in the explicit transport. A failed proxy request
does not silently fall back to a direct connection.

Changing network settings clears in-memory connection diagnostics and changes
the speed result identity, so previous-route measurements are not labelled as
the current route. Network settings cannot change during an active speed batch.

The transport uses pinned runtime dependency `undici` 7.25.0 (MIT), already
available in the development dependency tree and now included in the VSIX.
Its runtime requires Node >=20.18.1. This implementation was built/tested with
the existing Node 22 development environment; actual installed-client visual
and host-system-proxy acceptance remain separate checks.

## Local validation

```bash
npm run check
npm run test:network
npm run test:proxy
npm run test:codex-proxy
npm run test:codex-modes
npm run test:speed
```

Tests use synthetic settings, generated fixture certificates and loopback
CONNECT/HTTP(S) servers, without real credentials or model calls. They establish
transport/configuration behavior and regression coverage, not real account or
VPN stability.
