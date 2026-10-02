# Warnings — what can go wrong

Honest list of things that can break a conversion or an upload, including ones nobody can predict.

## During conversion

- **Out of memory.** Browsers cap a tab at about 16 GB and a single buffer at about 2 GB. The *RAM to use* setting sizes the tiles; if the tab crashes ("Aw, Snap"), reopen the page — it detects the interrupted run, tells you at which step it stopped and (if allowed) reports it. Lower *RAM to use* and close other tabs.
- **GPU errors.** A lost GPU device or a GPU out-of-memory error stops the run on purpose: a corrupted GPU result must never be written. Turn off *Use the GPU* to run on the CPU (about 4× slower).
- **Sleep, closed tab, background throttling.** The page holds a screen wake lock, but OS power plans, laptop lids or closing the tab end the run. It cannot resume yet.
- **Disk space.** The archive streams straight to disk (about 5–10% of the PLY). Without the File System Access API (Firefox, Safari) it is first built in browser storage, whose quota may be smaller than the archive.
- **Input formats.** Only binary PLY (3DGS layout: x/y/z, f_dc_*, optional f_rest_*, opacity, scale_*, rot_*). ASCII PLY, compressed PLY and point clouds without splat properties are refused with a clear message.

## After conversion

- **superspl.at rules can change.** Today it accepts a `.zip` with `lod-meta.json` at the root and SOG units (`meta.json` + WebP files) in sub-folders, up to 10 GB. The verifier checks exactly this; if SuperSplat changes its rules, the archive may be refused until this tool is updated.
- **Format evolution.** The Streamed SOG writer comes from splat-transform 3.8.0 (pinned). Newer viewers read version-1 manifests today; a future format version could require a rebuild.
- **ZIP64.** Archives over 4 GB use ZIP64. superspl.at's own zip reader supports it (checked in its JavaScript bundle on 2026-10-02); other tools may not.
- **Very sparse scenes.** Sky and far background are kept in the LOD tree (no separate environment layer yet). Use *adaptive* simplification for mixed-scale content.

## Unpredictable

Browser updates (WebGPU, memory limits), GPU driver bugs, antivirus software scanning the growing archive, and changes on third-party platforms can all break a run that worked yesterday. If it happens, use the **Feedback** button — the error report carries what is needed to reproduce it.
