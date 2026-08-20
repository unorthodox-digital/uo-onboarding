import { getDeployStore, getStore } from "@netlify/blobs";
import type { Config } from "@netlify/functions";

/**
 * Shared checklist progress for one client onboarding page.
 *
 * The page bundles ship with their progress in localStorage, which means only
 * the person who ticked a box can see it. This endpoint moves that state to
 * Netlify Blobs so the client and the team see the same checklist.
 *
 *   GET  /api/state/<slug>  -> { done: {...}, fields: {...} }
 *   PUT  /api/state/<slug>  <- { done: {...}, fields: {...} }
 *
 * It lives at the repo root, OUTSIDE the publish directory, so it is deployed
 * once and serves every client page — including pages published later, whose
 * exports know nothing about it. /newpage only ever writes under
 * deploy/uo-onboarding/<slug>/, so a publish can never overwrite it.
 *
 * The slug in the URL is the storage key. It is unique by construction: a page
 * is only served at /<slug>/ because a folder of that name exists in the
 * publish directory, and /newpage refuses to publish over one.
 *
 * There is no auth here, deliberately — it matches how the pages already work.
 * Anyone with a client's link can tick their boxes. What IS enforced is the
 * shape and size of what can be stored, so the endpoint cannot be used as
 * free file hosting.
 */

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const KEY_RE = /^[A-Za-z0-9_-]{1,40}$/;

const MAX_BODY_BYTES = 64 * 1024;
const MAX_DONE_KEYS = 200;
const MAX_FIELD_KEYS = 100;
const MAX_FIELD_CHARS = 4000;

interface PageState {
  done: Record<string, true>;
  fields: Record<string, string>;
}

const EMPTY: PageState = { done: {}, fields: {} };

/**
 * Deploy previews and branch deploys must never read or write live client
 * progress, so only production gets the global store. CONTEXT is set by
 * Netlify on every deploy.
 *
 * Strong consistency, not the default eventual: an account manager refreshing
 * right after a client ticks a box would otherwise be served up to 60 seconds
 * of stale state, which reads as "it didn't save".
 */
function store() {
  const opts = { name: "page-state", consistency: "strong" } as const;
  return Netlify.env.get("CONTEXT") === "production"
    ? getStore(opts)
    : getDeployStore(opts);
}

/** Keep only the shape the page actually uses, within fixed bounds. */
function sanitise(input: unknown): PageState {
  const src = (input ?? {}) as Record<string, unknown>;
  const state: PageState = { done: {}, fields: {} };

  const done = (src.done ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(done).slice(0, MAX_DONE_KEYS)) {
    // Only ticked boxes are stored; an untick removes the key entirely.
    if (KEY_RE.test(key) && done[key] === true) state.done[key] = true;
  }

  const fields = (src.fields ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(fields).slice(0, MAX_FIELD_KEYS)) {
    const value = fields[key];
    if (KEY_RE.test(key) && typeof value === "string") {
      state.fields[key] = value.slice(0, MAX_FIELD_CHARS);
    }
  }

  return state;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // Progress must never be served from a CDN or browser cache; a stale
      // read here is indistinguishable from lost work.
      "cache-control": "no-store",
    },
  });
}

export default async (req: Request): Promise<Response> => {
  const slug = new URL(req.url).pathname.split("/").filter(Boolean).pop() ?? "";
  if (!SLUG_RE.test(slug)) return json({ error: "invalid slug" }, 400);

  const blobs = store();

  if (req.method === "GET") {
    const saved = (await blobs.get(slug, { type: "json" })) as PageState | null;
    return json(saved ?? EMPTY);
  }

  if (req.method === "PUT") {
    const raw = await req.text();
    // Byte length, not string length — multi-byte characters count fully.
    if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) {
      return json({ error: "state too large" }, 413);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return json({ error: "invalid json" }, 400);
    }

    const state = sanitise(parsed);
    await blobs.setJSON(slug, state);
    return json(state);
  }

  return json({ error: "method not allowed" }, 405);
};

export const config: Config = {
  path: "/api/state/:slug",
  // Never shadow a real file if one ever lands at this path.
  preferStatic: true,
};
