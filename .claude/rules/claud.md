# Secrets & Service IDs

Never commit secrets (API tokens, passwords, private keys, etc.) or Fastly service IDs to code.

## Environment Files

- Every example that requires credentials or service IDs MUST use a `.env` file (or language-appropriate equivalent) for runtime config.
- Each example MUST include a `.env.example` file checked into the repo showing the required variables with placeholder values. This is how people and agents know what's needed to deploy.
- `.env` files (containing real values) MUST be in `.gitignore` — never checked in.
- Fastly service IDs go in `.env`, not in `fastly.toml`, unless the toml file strictly requires it (e.g., `fastly compute serve` needs a service ID in `fastly.toml`). When a service ID must be in `fastly.toml`, use a placeholder value in the committed file and document the override in the example's README.

Example `.env.example`:
```
FASTLY_API_TOKEN=your-api-token-here
FASTLY_SERVICE_ID=your-service-id-here
```

## Branch Workflow for Testing

- Always use a feature branch when building and testing demos — never work directly on main.
- Before merging back to main, strip all service-specific version information (service version numbers, active version references, deployment artifacts).
- The main branch should contain clean, portable examples that anyone can deploy to their own service.
