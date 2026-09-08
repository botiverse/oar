# Blog

Long-form posts about oar, kept in the repo so they are reviewed and versioned
like everything else. Drafts carry a status banner at the top; a post without
one is published.

| Post | Status |
|---|---|
| [introducing-oar.md](introducing-oar.md) | Draft — release post; motivation and shipped surface settled, v2 spec paragraphs marked **[not finalized]** |

## How to maintain these docs

- A post is a snapshot, not a contract. It states the release version and
  date it describes; do not edit old posts to track later changes — write a
  new one.
- Before publishing a draft, re-read every paragraph marked
  **[not finalized]** against [`../spec/README.md`](../spec/README.md) and
  either drop the marker or rewrite the paragraph. Remove the status banner
  in the same commit.
- Posts link to [`../design/`](../design/README.md) and
  [`../spec/`](../spec/README.md) for reasoning and contract; they never
  restate record shapes.
- Adding or removing a post means updating the table above and, if the blog
  gains or loses a public pointer, the root `README.md` in the same commit.
