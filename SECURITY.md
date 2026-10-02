# Security and privacy

## What leaves your computer

- **Your PLY file: never.** It is read by your browser (`File.slice`) and processed in a Web Worker on your CPU/GPU. The archive is written to the file you pick on your disk.
- **Feedback** (bug / idea / cooperation) — only when you send it: your text and, if you type one, a contact.
- **Anonymous error reports** — only if the checkbox next to *Convert* is ticked (it is by default and can be unticked): the error text, the conversion step, your settings, browser/GPU facts, the number of splats and file size, the last lines of the conversion log. Never the file, its name or path. The server additionally strips any key that could name a file or a person.
- **Cookieless counters** (page view, conversion started/finished/failed, input size bucket) — no IP addresses, no identifiers.
- **Google Analytics** — only after you accept it in the banner.

## Server side

The hosted site is two small containers: `nginx:alpine` serving static files and a stdlib-only Python API (`api/server.py`) that stores feedback/reports on disk and forwards a short note to the author's Telegram. No upload endpoint exists; request bodies are capped (8 KB, 512 KB for reports with diagnostics), rate-limited per client and globally, and the API container is read-only with a 64 MB memory cap. Content-Security-Policy forbids inline scripts and third-party scripts except Google Tag Manager.

## Reporting a vulnerability

Please email **zmei116@gmail.com** with "SECURITY" in the subject. Do not open a public issue for vulnerabilities. You will get an answer within a few days.

## Self-hosting

- Never commit `deploy/hub.env`, `config.env` or `tools/reports/inbox/` (all in `.gitignore`).
- Telegram credentials belong only in `config.env` on the server (mode 600).
- Run a secret scan before every push, e.g. `git grep -iE 'password|secret|token|api[_-]?key|BEGIN .*PRIVATE KEY|ghp_|github_pat_' $(git rev-list --all)`.

See also [`docs/warnings.md`](docs/warnings.md) for operational risks.
