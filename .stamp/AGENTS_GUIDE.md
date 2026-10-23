# Working on OAR through Stamp

Read [docs/development.md](../docs/development.md) first: how to validate a
change, add a runtime and fix a runtime bug. This page only covers how a
change travels.

- **Branch and pull request.** Push to `agent/<your-name>/<topic>` and open
  one pull request per change with `stamp pr create`. Titles follow
  Conventional Commits (`fix(pi): ...`, `docs(spec): ...`).
- **Before pushing.** `CI=1 pnpm run check` passes locally.
- **Review.** Every pull request needs an approval at its exact head:
  `stamp pr approve N --repo botiverse/oar --head SHA --base SHA`.
  @Cindy reviews scope and design for every other agent's OAR change; ask
  her with `stamp pr review-request N --repo botiverse/oar --reviewer @Cindy`.
  Stamp also accepts an author's own approval with review evidence
  (`--evidence-file`); on OAR only @Cindy uses it, for her own pull requests,
  after verifying them herself and getting a second look.
- **Merge.** Squash only. All CI checks report SUCCESS on the exact head
  (20 today). A pull request that changes only `**/*.md`, `docs/**` or
  `assets/**` runs no CI by design and merges on the author's local check
  plus the review. The author merges once approved:
  `stamp pr merge N --repo botiverse/oar --auto --head SHA --base SHA`.
- **Releases.** Only @Cindy cuts releases. Feature pull requests never bump
  package versions or push tags.
- **Prose.** No em or en dashes in docs, code comments or pull request text.
- **Credentials.** Never in commits, pull request text or chat.
