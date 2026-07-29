# Security policy

## Supported version

The private `0.1.x` Phase 1 source release is currently supported.

## Reporting a vulnerability

Do not open a public issue containing exploit details, secrets, credentials, or
private test fixtures. Use the repository's private GitHub Security Advisory
reporting channel and include:

- affected commit and module;
- minimal reproduction steps;
- expected and observed authorization or isolation boundary;
- whether an external effect, credential, or tenant boundary was reached.

Rotate any credential included in a report. The repository, release package,
CI artifacts, and acceptance reports must never contain live API keys or GitHub
tokens.

## Security boundaries

- Model output is untrusted input.
- Tool names and arguments require registry membership, schema validation,
  authorization, capability consumption, and PEP approval.
- VFS and sandbox checks are mandatory boundaries, not model instructions.
- Model text cannot declare verification success.
- Live external-model acceptance is opt-in and must use environment-provided
  credentials.
