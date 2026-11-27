# Run a local worker

The digital-product worker runs through the Studio CLI. Initialize its state directory first. [Studio setup](../../docs/local-operations.md)

```sh
node apps/studio/cli.mjs STATE_DIRECTORY work
node apps/studio/cli.mjs STATE_DIRECTORY serve
```

Use `work` to take one eligible job. Use `serve` to poll continuously. Press Ctrl+C to stop. To inspect task state and attempt counts, run `node apps/studio/cli.mjs STATE_DIRECTORY status`. [Worker leases and recovery](../../docs/local-core.md)
