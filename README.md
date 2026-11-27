# PIE Harness — Personal Income Engine

PIE assigns work to specialist agents. A local SQLite queue keeps their tasks, attempts and receipts through a restart. This distribution includes a digital-product studio, an owned-item resale desk and a channel research desk.

## Run the first check

Install Node.js 22.13 or later. Open a terminal in the directory that contains this README and the `apps` and `tests` directories. Run these commands there.

```sh
node apps/control-plane/local.mjs
node --test "tests/*.test.mjs"
```

The first command runs one fixture task and reports its verified checkpoint. The second runs the standalone tests.

## Try a digital-product sale

Choose a new directory outside Git. Replace the example path with that directory.

```sh
node apps/studio/cli.mjs /path/to/new/studio-state demo
```

Inspect the brand, approved product, local story and ad. Follow a comment and an email through support. Compare the delivered edition with the synthetic payment record. The demo uses fixture text. For your own studio, you can select an installed Ollama model and run its worker on your VM. [Studio guide](docs/local-operations.md) · [Account and budget controls](docs/local-core.md) · [Agent text and Discord](docs/agent-communications.md)

## Choose a workflow

| Task | Command or guide |
| --- | --- |
| Sell an owned item and reconcile the payout | `node apps/resale/rehearsal.mjs` · [Resale desk](docs/resale.md) |
| Research a channel and measure a reviewed edition | `node apps/channel-ops/cli.mjs /path/to/new-state rehearse` · [Channel operations](docs/channel-ops.md) |
| Test specialist handoffs and recipient receipts | `node apps/connectors/conformance.mjs` · [Teams and connectors](docs/connectors-team-sdk.md) |
| Set up model or media work | [Hosted accounts](docs/connectors-hosted.md) · [Media jobs](docs/connectors-media.md) · [Hardware qualification](docs/connectors-profiles.md) |
| Restore a worker or an account | [Recovery drill](docs/recovery-drill.md) · [Account recovery](docs/connection-recovery.md) |

Use the release checklist to verify the environment, access controls and hardware qualification before deployment. [Release checklist](docs/release-readiness.md)
