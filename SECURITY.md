# Security and data handling

This is a paper-trading research snapshot, not a production security certification.

- Never commit `.env`, keys, account responses, database dumps or execution logs.
- Use a dedicated MySQL schema and least-privilege account. Keep credentials outside Git.
- Bind the dashboard to loopback; use authenticated SSH forwarding to view it remotely.
- Restrict Telegram control to explicitly allowed chat IDs and one receiver per token.
- Keep `LIVE_ENABLED=false`. There is no live execution adapter in this project.
- Rotate any credential accidentally disclosed; deleting a file does not remove Git history.
- Do not include credentials or personal trading records in public issues.
