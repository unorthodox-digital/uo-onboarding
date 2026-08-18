# Netlify Doc Uploader

Client onboarding pages for https://unorthodoxonboarding.com. Netlify serves the
site directly from this repo. Tracked in Linear **UNO-570**.

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
- No build step. Netlify serves these files as-is; do not add a build command.
- The site is currently **public** — any client page is reachable by guessing its
  slug. Assume anything committed here is world-readable.
