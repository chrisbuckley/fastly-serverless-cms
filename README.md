# Fastly Code Examples

Standalone, self-contained examples demonstrating Fastly's platform capabilities — VCL, Compute, API integrations, Terraform, and edge use cases. Each subdirectory is an independent project with its own README, dependencies, and deployment instructions.

Maintained by a Principal Sales Engineer for demos, POCs, and customer-facing technical content.

## Examples

| Project | Description |
|---------|-------------|
| [**edge-cms**](edge-cms/) | A fully-functional CMS running entirely on Fastly — no origin servers. Rust and Go Compute implementations with shared Handlebars templates, KV Store for content, Object Storage for images, Config Store for cache TTLs, VCL CDN layer with Image Optimizer, surrogate-key purging, rate limiting, and brotli compression. Live at [serverless-cms.chrisbuckley.dev](https://serverless-cms.chrisbuckley.dev). |

## Structure

Each example is its own directory — no shared dependencies or build system across examples.

```
fastly-code-examples/
├── <example-name>/
│   ├── README.md          # What it does, how to deploy, prerequisites
│   ├── fastly.toml        # For Compute examples
│   └── ...
```

## Getting Started

1. Pick an example directory
2. Read its README
3. Follow the setup instructions (Fastly CLI or Terraform)

Most examples require a [Fastly account](https://www.fastly.com/signup/) and the [Fastly CLI](https://github.com/fastly/cli):

```bash
brew install fastly/tap/fastly
fastly profile create
```

Compute examples can run locally with [Viceroy](https://github.com/fastly/Viceroy) — no account required for development:

```bash
cd <example>/rust/
fastly compute serve
```

## CI

Pull requests run automated checks via GitHub Actions — see each project's README for details on what's tested.

## License

MIT
