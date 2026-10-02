# AGENT_SETUP.md — protocol for a user's AI agent

Use this when a person asks their AI agent to "make my splat scan fit SuperSplat", "build LODs for my PLY" or "self-host the SOG LOD converter".

## A. Just convert a file (no install)

1. Tell the user to open <https://sog.flyreelstudio.eu> in desktop Chrome or Edge and drop the `.ply`.
2. Defaults match SuperSplat (levels halve until ≤ 1M splats; chunks 512K / 16 m / 8K). Change settings only for a reason the user gives (see README → Settings).
3. When it finishes, the page shows "Checked: lod-meta.json at the root, N levels…". If it shows problems or an error, the page has already sent an anonymous report (if allowed); copy the details for the user.
4. Upload the `.zip` at superspl.at → Upload.

## B. Verify an existing Streamed SOG zip

```bash
git clone https://github.com/AndriiShramko/shramko-sog-lod-converter && cd shramko-sog-lod-converter
npm install                                    # Node.js 22+
npx tsx tools/verify-zip.ts /path/to/scene.zip  # exit 0 = OK; prints levels, counts, problems
```

A `lodLevels` of 1 on a scene over 1M splats means the archive has no real LODs.

## C. Convert headless (scripts, servers, batch)

```bash
npx tsx tools/node-convert.ts input.ply output.zip --memory-gb 16
```

Same engine as the web page, CPU only (no WebGPU under Node) — about 4× slower decimation. For GPU speed use the web page or the e2e driver: `node tools/e2e.mjs input.ply output.zip --mem 12` (needs Chrome).

## D. Self-host the site

```bash
npm install && npm run build        # static site in dist/
```

Serve `dist/` with any static server that sends `.wasm` as `application/wasm`. For the full setup (nginx with CSP, the feedback API, Docker limits, staging certificate, rollback) follow [`deploy/README.md`](deploy/README.md). Put your own server details in `deploy/hub.env` (copy `deploy/hub.env.example`; never commit it).

## Update

```bash
git pull && npm install && npx tsc -p . && python -m unittest discover -s api/tests && npm run build
```

Read [`CHANGELOG.md`](CHANGELOG.md) for behaviour changes.

## Uninstall

Delete the folder. The web page stores only settings and language in the browser (`localStorage` keys `sog_*`); clear site data to remove them.

## Safety

Never upload the user's scan anywhere while "converting" — the tool is local by design. Never commit secrets. See [`SECURITY.md`](SECURITY.md) and [`docs/warnings.md`](docs/warnings.md).
