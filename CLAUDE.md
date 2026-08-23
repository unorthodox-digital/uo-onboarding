# uo-onboarding

Client onboarding pages for https://unorthodoxonboarding.com, served directly
from this repo. Tracked in Linear **UNO-570**.

Hosted on **Vercel** (project `uo-onboarding`, team `team-9698s-projects`).

**The repo is private.** It was briefly public; the client bundles carry named
contacts, direct emails, phone numbers and per-client Drive links, so keep it
private.

## URL layout — read before adding pages

- Pages live at `deploy/uo-onboarding/<client-slug>/index.html`.
- The publish directory is **`deploy/uo-onboarding`** (`vercel.json` -> `outputDirectory`),
  so a page is served at
  `https://unorthodoxonboarding.com/<client-slug>/`. The `deploy/uo-onboarding/`
  prefix is **not** part of the public URL.
- Changing the publish directory relocates every existing client page and breaks
  links already sent to clients. Don't.

## Rules

- Each page is a self-contained Claude artifact bundled export (~464 KB, zero
  external requests). Never prettify, reformat, minify, or run a bundler over
  these files — they must stay byte-identical to what was exported.
- Never remove `.gitattributes` (`* -text`). It stops Windows checkouts from
  rewriting line endings and silently changing every deployed byte.
- No build step for the pages. Vercel serves everything under the publish
  directory as-is; do not add a build command. `package.json` exists only so
  Vercel installs the dependencies the functions need — it never runs over the
  client pages. Keep `package-lock.json` committed: `vercel.json` runs `npm ci`, which requires it.
- The site is currently **public** — any client page is reachable by guessing its
  slug. Assume anything committed here is world-readable.

## Functions

They live OUTSIDE the publish directory, so they deploy once and apply to every
client page - including pages published later. `/newpage` only ever writes under
`deploy/uo-onboarding/<slug>/`, so a publish cannot touch them.

Two differences that matter:

- **Preview isolation is done by pathname, not by store.** Netlify gave a
  deploy-scoped store; Vercel Blob has one store per project, so state is
  written to `state/<production|preview>/<slug>.json`. `api/remove-page.ts`
  must build that path the same way or it deletes nothing.
- **Strong consistency is `useCache: false`** on `get()`. Without it a read
  right after a tick can be up to a minute stale, which reads as a failed save.

Env vars needed on Vercel: `LIBRARY_PASSWORD`, `GITHUB_TOKEN`, plus the Blob
store connected to the project (which injects `BLOB_STORE_ID` automatically).
