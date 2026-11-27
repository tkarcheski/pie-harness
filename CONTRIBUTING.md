# Contribute a change

Use the issue form to describe a problem. Include steps that reproduce it with sanitized data. Add a fixture that verifies the fix. Update the guide if an interface changes. Discuss the version before changing an interface that existing callers use.

## Review a distribution release

1. Create a clean branch from the last reviewed public commit. The distribution has independent Git history.
2. Copy the reviewed files into that checkout. Compare every addition, change and removal with the previous public tree.
3. Inspect workflow permissions, action revisions, dependencies and generated output.
4. Use a fresh checkout and an empty runtime state directory. Run `node --test "tests/*.test.mjs"` from its root. The suite uses synthetic fixtures and local transports.
5. Check the public-runner results for this repository. Record the complete commit ID and the passing run URL.
6. After merge, compare every file's contents and mode with the reviewed candidate.
