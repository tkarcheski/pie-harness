# PIE Harness — Personal Income Engine

PIE coordinates work across specialist agents using a durable SQLite queue. This distribution includes a digital-product studio, an owned-item resale desk, and tools for researching and reviewing business channels.

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

Use the [studio guide](docs/local-operations.md) to operate the queue and the [policy guide](docs/local-core.md) to scope accounts and budgets. The studio exercises its social, advertising, mail and payment workflows with local transports.

See [agent text communications and private Discord setup](docs/agent-communications.md) for the local operations transcript and optional bot bridge.

| To exercise | Run or read |
| --- | --- |
| An owned sale from intake through settlement | `node apps/resale/rehearsal.mjs` · [Resale desk and eBay Sandbox setup](docs/resale.md) |
| A researched, rights-reviewed edition with a measured outcome | `node apps/channel-ops/cli.mjs /path/to/new-state rehearse` · [Channel operations](docs/channel-ops.md) |
| Multi-agent handoffs and recipient reconciliation | `node apps/connectors/conformance.mjs` · [Teams and connector SDK](docs/connectors-team-sdk.md) |
| Hosted model jobs, media and hardware qualification | [Hosted accounts](docs/connectors-hosted.md) · [Artifact jobs](docs/connectors-media.md) · [Runtime profiles](docs/connectors-profiles.md) |
| Restart, restore and scoped incident recovery | [Recovery drill](docs/recovery-drill.md) · [Account recovery](docs/connection-recovery.md) |

The [release checklist](docs/release-readiness.md) describes the supported environment, trust boundaries, acceptance evidence and remaining hardware qualification work.
