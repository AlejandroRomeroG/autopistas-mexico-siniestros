# Project instructions

- Publish this project through its GitHub repository and GitHub Pages, `main:/docs`. Do not create or publish OpenAI Sites.
- Preserve the requested full-screen map, road selector and circular hour filter.
- Real source snapshots are in `data/source`. Never invent or silently correct source dates, times, kilometre values or coordinates.
- Label time as approximate and preserve the documented source limitations, exclusions and potential duplicates.
- Use `npm test` and `npm run build` after source changes. `docs/` is generated; edit `src/` and scripts instead.
- Do not refresh frozen source data during ordinary builds. Explicit refreshes require reviewing and realigning the new snapshot.
- Keep credentials, private data and machine-local paths out of the repository and published files.
