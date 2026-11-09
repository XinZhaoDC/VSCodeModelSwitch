# Licenses and third-party notices

The explicit HTTP CONNECT/fetch transport uses `undici` 7.25.0 (MIT), maintained
by the Node.js Undici project. Its upstream license is included at
`node_modules/undici/LICENSE` in the VSIX. It is used without modifying its
implementation and does not replace the API compatibility modules below.

The speed measurement code uses [js-tiktoken](https://www.npmjs.com/package/js-tiktoken)
1.0.21 under MIT. Its upstream license is retained in
[licenses/js-tiktoken-LICENSE.txt](licenses/js-tiktoken-LICENSE.txt), since its npm
archive omits the license file. The base64-js runtime dependency license remains
in the packaged node_modules. It provides local token
estimates; no provider's private tokenizer is claimed. Codex probing uses the
documented app-server protocol; the separately installed token-speed-tester is
kept as independent validation tooling and is not a runtime dependency.

The existing VSCodeModelSwitch application and the new configuration, lifecycle,
transport and UI integration are licensed under the MIT license in [LICENSE](LICENSE).

The relay compatibility behavior in `src/proxy/protocol.ts` and the server-side
web-tool implementation in `src/proxy/webTools.ts` are adapted from
[justdowork-proxy](https://github.com/abdurrehmandaudi/justdowork-proxy). Those
modules, including their compiled JavaScript in the VSIX, remain licensed under
the **PolyForm Noncommercial License 1.0.0**, not MIT. The complete license is
distributed in [licenses/justdowork-proxy-LICENSE.md](licenses/justdowork-proxy-LICENSE.md).

Required Notice: Copyright (c) 2026 abdurrehmandaudi — justdowork-proxy — https://github.com/abdurrehmandaudi/justdowork-proxy

Personal/noncommercial and the organizational uses permitted by that license
are covered by its terms. Commercial use of the adapted modules requires a
separate license from their upstream author. Installing a TypeScript build does
not remove those license conditions.
