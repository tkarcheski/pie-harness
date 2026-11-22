# Contributing

Use the issue forms for reproducible, sanitized reports. Include fixture-backed validation and update documentation when contracts change. Run the standalone tests from the repository root. Discuss versioning before introducing breaking contract changes.

## Distribution review

This repository has independent Git history. Prepare a release from a clean branch based on its previous reviewed commit. Copy the reviewed distribution files into that checkout. Compare every addition, modification and removal with the previous public tree. Review workflow permissions, action revisions, dependency changes and generated output alongside the code.

Run `node --test tests/*.test.mjs` from a fresh checkout with an empty runtime state directory. The tests use synthetic fixtures and local transports. Hosted checks run on public runners from this repository's workflow. Record the full commit ID and the passing run URL in the release review. Verify the merged commit's entire file tree against the reviewed candidate, including file modes and contents.
