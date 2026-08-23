# Netlify Doc Uploader

Client onboarding pages for https://unorthodoxonboarding.com, served directly
from this repo. Tracked in Linear **UNO-570**.

**Mid-migration from Netlify to Vercel.** Both sets of config are present on
purpose: Netlify's (`netlify.toml`, `netlify/`) is still what serves production
until DNS moves, and Vercel's (`vercel.json`, `middleware.ts`, `api/`) is the
replacement. Delete the Netlify half only once the cutover is proven.

**The repo is private.** It was briefly public; the client bundles carry named
contacts, direct emails, phone numbers and per-client Drive links, so keep it
private.

Netlify site ID: `8447ec80-b7d4-4ee0-9d60-5934901f08b3` (team plan `nf_team_dev`).

## URL layout — read before adding pages

- Pages live at `deploy/uo-onboarding/<client-slug>/index.html`.
- Netlify's publish directory is **`deploy/uo-onboarding`**, so a page is served at
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
- No build step for the pages. Netlify serves everything under the publish
  directory as-is; do not add a build command. `package.json` exists only so
  Netlify installs the dependencies the functions need — it never runs over the
  client pages. Keep `package-lock.json` committed: without it Netlify re-resolves
  versions against a cached npm index, which has already failed a deploy with
  `ETARGET ... @netlify/otel` for a version that does exist. With the lockfile it
  runs `npm ci` and fetches pinned tarballs instead.
- The site is currently **public** — any client page is reachable by guessing its
  slug. Assume anything committed here is world-readable.

## Functions

Live outside the publish directory, so they are deployed once and apply to every
client page — including pages published later. `/newpage` in DoxBot only ever
writes under `deploy/uo-onboarding/<slug>/`, so a publish cannot touch them.

| Path | Function | Purpose |
|---|---|---|
| `/`, `/pages.json` | `netlify/edge-functions/library-gate.ts` | Password gate for the team library. Fails closed without `LIBRARY_PASSWORD`. |
| `/api/state/<slug>` | `netlify/functions/state.mts` | Shared checklist progress, stored in Netlify Blobs. |
| `/api/remove-page` | `netlify/functions/remove-page.mts` | Removes a client page — files, manifest entry and blob state — in one commit. |

### Shared progress state (`/api/state/<slug>`)

The exported page bundles keep progress in `localStorage`, so only the person who
ticked a box can see it. `state.mts` moves that state server-side:

- `GET` returns `{ done, fields }` for the slug, `{}`-shaped if nothing is saved.
- `PUT` replaces it. Input is sanitised to that shape and bounded (64KB body),
  because the endpoint is public — as public as the pages themselves.
- Production uses the **global** blob store; previews and branch deploys use a
  **deploy-scoped** one, so test ticks never land on a real client's checklist.
- Reads are strongly consistent. Eventual consistency would serve up to 60s of
  stale state after a tick, which is indistinguishable from a failed save.

A page only uses this once its bundle calls it instead of `localStorage`. That
code lives inside each export, so it comes from the Claude Design template —
publishing this function does not change pages already deployed.

### Removing a page (`/api/remove-page`)

The X on each library card posts `{ slug }` here. It deletes the page's files
and its `pages.json` entry in **one** commit, the same way `/newpage` writes
them, so the library cannot disagree with what is deployed. Netlify then
rebuilds and the URL goes dead.

- **It re-checks the login cookie itself.** `library-gate` only covers `/` and
  `/pages.json`; it does not sit in front of `/api/*`. Without that check anyone
  who found the URL could take a client's page offline.
- **It also deletes the slug's Blobs state.** The slug is the storage key, so a
  page later published under the same slug would otherwise inherit the previous
  client's ticked boxes and typed answers.
- Needs `GITHUB_TOKEN` in Netlify's environment variables — a separate copy from
  DoxBot's, since Netlify cannot read Replit's secrets. Fails closed without it.
- The ref update is fast-forward only, so a `/newpage` publish landing mid-flight
  makes the removal fail rather than reverting it.

## Vercel port (migration in progress)

Same three behaviours, different platform primitives:

| Netlify | Vercel |
|---|---|
| `netlify/edge-functions/library-gate.ts` | `middleware.ts` (matcher: `/`, `/pages.json`) |
| `netlify/functions/state.mts` | `api/state/[slug].ts` |
| `netlify/functions/remove-page.mts` | `api/remove-page.ts` |
| `netlify.toml` → `publish` | `vercel.json` → `outputDirectory` |
| Netlify Blobs, `getStore` vs `getDeployStore` | Vercel Blob, environment in the pathname |

Two differences that matter:

- **Preview isolation is done by pathname, not by store.** Netlify gave a
  deploy-scoped store; Vercel Blob has one store per project, so state is
  written to `state/<production|preview>/<slug>.json`. `api/remove-page.ts`
  must build that path the same way or it deletes nothing.
- **Strong consistency is `useCache: false`** on `get()`. Without it a read
  right after a tick can be up to a minute stale, which reads as a failed save.

Env vars needed on Vercel: `LIBRARY_PASSWORD`, `GITHUB_TOKEN`, plus the Blob
store connected to the project (which injects `BLOB_STORE_ID` automatically).
