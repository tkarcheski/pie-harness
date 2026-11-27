# Distribution instructions

Keep this distribution usable on its own.

- Use synthetic data in examples and tests. Disable external connectors or run them in simulation.
- Keep production credentials and private imports outside this tree.
- Run hosted CI against this distribution on public runners. Keep private sources and home nodes outside that workflow.
- Run the standalone tests. Document which features work, which tests passed and which features still require implementation or verification.
