# PIE Harness — Personal Income Engine

PIE coordinates local work for operating business channels. This distribution includes a durable single-host queue and a runnable digital-product studio.

## Start here

With Node.js 22.13 or later, run a standalone fixture:

```sh
node apps/control-plane/local.mjs
node --test tests/*.test.mjs
```

Run the complete studio demonstration with a fresh directory outside Git:

```sh
node apps/studio/cli.mjs /path/to/new/studio-state demo
```

The studio creates an original brand, drafts a product, records owner review, posts a story and ad to its local feed, handles a comment and email, delivers a digital edition and reconciles a synthetic payment. Choose a local Ollama model for AI writing or use the deterministic fixture. The worker can run continuously on an operator-provided VM.

See [studio commands and VM operations](docs/local-operations.md) and [execution, accounts and policy](docs/local-core.md). Social postings, ad placements, mailbox delivery and payment observations use local transports. Production marketplace connectors, paid advertising integration, hosted runtimes and bank access remain future work.

See [agent text communications and private Discord setup](docs/agent-communications.md) for the local operations transcript and optional bot bridge.
