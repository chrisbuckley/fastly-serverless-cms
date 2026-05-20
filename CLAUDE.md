# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Purpose

Collection of standalone Fastly code examples — each subdirectory is an independent, self-contained example demonstrating a specific Fastly feature or pattern. Examples span VCL snippets, Compute applications (Rust, Go, JavaScript/TypeScript), API scripts, Terraform configs, and edge use cases.

This repo is maintained by a Principal Sales Engineer for demos, POCs, and customer-facing technical content.

## Repository Structure

```
fastly-code-examples/
├── <example-name>/        # Each example is its own directory
│   ├── README.md          # What it does, how to use it, prerequisites
│   ├── fastly.toml        # For Compute examples
│   └── ...                # Example-specific files
```

Each example directory is independent — no shared dependencies or build system across examples.

## Conventions

### Naming
- Directory names: lowercase kebab-case describing the feature (e.g., `vcl-geo-blocking`, `compute-kv-store`, `api-purge-surrogate-key`)
- Prefix with the Fastly domain: `vcl-`, `compute-`, `api-`, `terraform-`, `edge-`

### Example Structure
- Every example MUST have a README.md explaining what it demonstrates and how to run it
- Compute examples use `fastly.toml` and should be deployable with `fastly compute deploy`
- VCL examples should be usable via `fastly vcl custom create` or copy-paste into the Fastly UI
- API examples should use environment variables for credentials (`FASTLY_API_TOKEN`, `FASTLY_SERVICE_ID`)

### Languages
- Compute: Rust is primary, JavaScript/TypeScript secondary, Go tertiary
- Scripts/automation: bash first, Python for anything complex
- IaC: Terraform with the Fastly provider

## Common Commands

These apply per-example, not repo-wide:

```bash
# Compute (Rust)
cd <example>/
fastly compute build
fastly compute serve          # local dev via Viceroy
fastly compute deploy

# Compute (JS/TS)
cd <example>/
npm install
fastly compute build
fastly compute serve

# VCL
fastly vcl custom create --name=<name> --version=latest --autoclone --content=<file>.vcl

# API scripts
export FASTLY_API_TOKEN=<token>
export FASTLY_SERVICE_ID=<sid>
./<script>.sh
```

## Key Fastly Context

- Fastly CLI (`fastly`) is the primary interface — prefer it over raw API calls in examples
- Viceroy (`fastly compute serve`) runs Compute apps locally — use it for dev/test
- VCL examples should note which subroutine they belong in (`vcl_recv`, `vcl_deliver`, etc.)
- Examples targeting specific Fastly products should note any product enablement prerequisites
