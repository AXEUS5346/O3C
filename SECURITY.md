# Security

O3C is a local-only bridge. It binds its HTTP server to `127.0.0.1` and never
listens on a public interface.

## Secrets and state

- The bridge copies `auth.json` and `account.json` from
  `~/.local/share/opencode/` into a dedicated OpenCode home under
  `~/.local/share/opencode-free-bridge/opencode-home/` at runtime.
- Copied credential files are created with mode `0600`; the dedicated home
  should stay private to the user.
- Service passwords, usage state, catalog snapshots and logs live under
  `~/.local/state/opencode-free-bridge/` and are not part of this repository.
- No API keys, tokens, session data, or credentials belong in the repository.
  `.gitignore` excludes the runtime state and credential filenames.

## Threat model

- The bridge is a developer tool, not a hardened multi-user service.
- Any local process that can read the bridge port or the state directory can
  use the configured OpenCode account. Use OS file permissions and a trusted
  machine.
- The free-tier gate is enforced by OpenCode's own service; this project does
  not bypass quotas. The local daily request budget is a guard against runaway
  test/agent loops, not a security boundary.
- OpenCode's terms and free-model limits still apply.

## Reporting

Report a vulnerability privately to the repository owner. Do not open a public
issue containing credentials, tokens, session data, or account identifiers.
