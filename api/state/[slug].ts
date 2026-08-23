import { get, put } from "@vercel/blob";

/**
 * Shared checklist progress for one client onboarding page.
 *
 * Vercel port of netlify/functions/state.mts.
 *
 *   GET  /api/state/<slug>  -> { done: {...}, fields: {...} }
 *   PUT  /api/state/<slug>  <- { done: {...}, fields: {...} }
 *
 * The page bundles ship with their progress in localStorage, which means only
 * the person who ticked a box can see it. This moves that state to Vercel Blob
 * so the client and the team see the same checklist.
 *
 * It lives OUTSIDE the publish directory, so it is deployed once and serves
 * every client page — including pages published later, whose exports know
 * nothing about it. /newpage only ever writes under
 * deploy/uo-onboarding/<slug>/, so a publish can never overwrite it.
 *
 * There is no auth here, deliberately — it matches how the pages already work.
 * Anyone with a client's link can tick their boxes. What IS enforced is the
 * shape and size of what can be stored, so the endpoint cannot be used as free
 * file hosting.
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
 * Preview and development deploys must never read or write live client
 * progress. Netlify gave us a deploy-scoped store for this; Vercel Blob has one
 * store per project, so the environment goes in the pathname instead. Same
 * guarantee, different mechanism.
 */
function pathFor(slug: string): string {
  const env = process.env.VERCEL_ENV === "production" ? "production" : "preview";
  return `state/${env}/${slug}.json`;
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
      // Progress must never be served from a CDN or browser cache; a stale read
      // here is indistinguishable from lost work.
      "cache-control": "no-store",
    },
  });
}

/**
 * Vercel routes a request to the named export matching its method. A default
 * export would get the Node (req, res) signature instead, and a returned
 * Response is silently discarded — the request then hangs until it times out.
 */
async function handler(req: Request): Promise<Response> {
  // req.url is a RELATIVE path on Vercel (it was absolute on Netlify), so a
  // bare new URL(req.url) throws. The base is only there to make it parse.
  const slug =
    new URL(req.url, "http://localhost").pathname.split("/").filter(Boolean).pop() ??
    "";
  if (!SLUG_RE.test(slug)) return json({ error: "invalid slug" }, 400);

  const pathname = pathFor(slug);

  if (req.method === "GET") {
    // useCache:false is what replaces Netlify's strong consistency. Without it
    // a read right after a tick can be up to a minute stale, which reads as
    // "it didn't save".
    const found = await get(pathname, { access: "private", useCache: false });
    if (!found?.stream) return json(EMPTY);
    try {
      return json(JSON.parse(await new Response(found.stream).text()));
    } catch {
      // Unreadable stored state is not worth failing a page load over.
      console.error(`state: stored blob for ${slug} is not valid JSON`);
      return json(EMPTY);
    }
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
    await put(pathname, JSON.stringify(state), {
      access: "private",
      allowOverwrite: true,
      addRandomSuffix: false,
      contentType: "application/json",
      // Lowest the platform allows. The value is read through useCache:false
      // anyway, but a long cache here would be actively misleading.
      cacheControlMaxAge: 60,
    });
    return json(state);
  }

  return json({ error: "method not allowed" }, 405);
}

export const GET = handler;
export const PUT = handler;
