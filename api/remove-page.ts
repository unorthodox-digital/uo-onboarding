import { del } from "@vercel/blob";

/**
 * Remove a client onboarding page: its files, its manifest entry, and its
 * saved checklist progress.
 *
 *   POST /api/remove-page  <- { slug }
 *
 * Vercel port of netlify/functions/remove-page.mts.
 *
 * Called by the X button on the library page. The library sits behind the
 * password middleware, but that middleware matches "/" and "/pages.json" only
 * — NOT this path — so the same cookie is verified here. Without that, anyone
 * who found this URL could take a client's page offline.
 *
 * Files and manifest go in ONE commit, the same way /newpage writes them, so
 * the library can never disagree with what is actually deployed.
 *
 * The blob state is deleted too. Leaving it would strand the data, and worse:
 * a page later published under the same slug would inherit the previous
 * client's ticked boxes and typed answers, because the slug IS the storage key.
 *
 * Needs LIBRARY_PASSWORD (shared with the middleware) and GITHUB_TOKEN (a
 * fine-grained PAT for this repo, Contents read+write). Fails closed without
 * either.
 */

const COOKIE = "uo_lib";
const PREFIX = "deploy/uo-onboarding";
const MANIFEST = `${PREFIX}/pages.json`;

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

interface ManifestEntry {
  slug?: string;
  clientName?: string;
  publishedAt?: string;
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Comparison that does not leak how much of the value matched, via timing. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function gh(
  method: string,
  path: string,
  token: string,
  payload?: unknown,
): Promise<any> {
  const resp = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(payload ? { "content-type": "application/json" } : {}),
    },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  if (!resp.ok) {
    // Logged server-side only; the body can carry repo detail.
    const detail = (await resp.text()).slice(0, 400);
    console.error(`GitHub ${method} ${path} -> ${resp.status}: ${detail}`);
    throw new Error(`GitHub returned ${resp.status}`);
  }
  return resp.status === 204 ? null : resp.json();
}

/**
 * Named export, not default — see the note in api/state/[slug].ts.
 */
async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const secret = process.env.LIBRARY_PASSWORD;
  const token = process.env.GITHUB_TOKEN;
  if (!secret || !token) {
    console.error(
      `remove-page not configured: LIBRARY_PASSWORD=${!!secret} GITHUB_TOKEN=${!!token}`,
    );
    return json({ error: "Removal is not configured on the server." }, 503);
  }

  // The middleware does not match /api/*, so the cookie is checked here.
  const cookie = readCookie(req.headers.get("cookie"), COOKIE);
  if (!cookie || !safeEqual(cookie, await sha256Hex(secret))) {
    return json({ error: "Not signed in. Reload the page and enter the code." }, 401);
  }

  let slug = "";
  try {
    const body = (await req.json()) as { slug?: unknown };
    slug = String(body?.slug ?? "");
  } catch {
    return json({ error: "Malformed request." }, 400);
  }
  // Matched strictly rather than sanitised: a slug that does not match exactly
  // is a bug or an attempt, and guessing what was meant is the wrong answer.
  if (!SLUG_RE.test(slug)) return json({ error: "That is not a valid page name." }, 400);

  const repo = process.env.UO_ONBOARDING_REPO ?? "unorthodox-digital/uo-onboarding";
  const branch = process.env.UO_ONBOARDING_BRANCH ?? "main";

  try {
    // Pin the head once and read everything at it, so a publish landing
    // mid-flight fails the fast-forward below instead of being reverted.
    const parentSha = (await gh("GET", `/repos/${repo}/git/ref/heads/${branch}`, token))
      .object.sha;
    const baseTree = (await gh("GET", `/repos/${repo}/git/commits/${parentSha}`, token))
      .tree.sha;
    const tree = await gh("GET", `/repos/${repo}/git/trees/${parentSha}?recursive=1`, token);

    if (tree.truncated) {
      // A partial listing cannot tell us what belongs to this page.
      return json({ error: "Repository listing was truncated; removal aborted." }, 503);
    }

    const pageDir = `${PREFIX}/${slug}/`;
    const pageFiles: string[] = (tree.tree ?? [])
      .filter((e: any) => e.type === "blob" && String(e.path).startsWith(pageDir))
      .map((e: any) => e.path as string);

    if (pageFiles.length === 0) return json({ error: `No page found at /${slug}/.` }, 404);

    const manifestNode = (tree.tree ?? []).find((e: any) => e.path === MANIFEST);
    let manifest: ManifestEntry[] = [];
    if (manifestNode) {
      const blob = await gh("GET", `/repos/${repo}/git/blobs/${manifestNode.sha}`, token);
      // GitHub wraps base64 across lines; strip the whitespace before decoding.
      // Decode through bytes rather than atob's latin1 string, or a client name
      // with an accent comes back mangled and gets written back that way.
      const bytes = Uint8Array.from(
        atob(String(blob.content).replace(/\s+/g, "")),
        (ch) => ch.charCodeAt(0),
      );
      const parsed = JSON.parse(new TextDecoder().decode(bytes));
      if (Array.isArray(parsed)) manifest = parsed;
    }
    const remaining = manifest.filter((entry) => entry?.slug !== slug);

    // sha: null removes a path the inherited base_tree still carries.
    const entries: any[] = pageFiles.map((path) => ({
      path,
      mode: "100644",
      type: "blob",
      sha: null,
    }));
    entries.push({
      path: MANIFEST,
      mode: "100644",
      type: "blob",
      content: `${JSON.stringify(remaining, null, 2)}\n`,
    });

    const newTree = await gh("POST", `/repos/${repo}/git/trees`, token, {
      base_tree: baseTree,
      tree: entries,
    });
    const commit = await gh("POST", `/repos/${repo}/git/commits`, token, {
      message:
        `Remove onboarding page: ${slug}\n\n` +
        `Removed from the library page. Deletes ${pageFiles.length} file(s) under ` +
        `${pageDir} and the pages.json entry.\n\nRefs UNO-570`,
      tree: newTree.sha,
      parents: [parentSha],
    });
    // Fast-forward only: if the branch moved since parentSha was read, this
    // fails rather than reverting whatever landed in between.
    await gh("PATCH", `/repos/${repo}/git/refs/heads/${branch}`, token, {
      sha: commit.sha,
    });

    // Only after the commit lands. Clearing first would orphan the progress of
    // a live page if the commit then failed. Must match the pathname scheme in
    // api/state/[slug].ts, or this deletes nothing.
    const env = process.env.VERCEL_ENV === "production" ? "production" : "preview";
    try {
      await del(`state/${env}/${slug}.json`);
    } catch (err) {
      // The page is already gone; a stale blob is untidy, not broken. Worth a
      // log, because republishing this slug would inherit it.
      console.error(`remove-page: page removed but blob state for ${slug} remains:`, err);
    }

    return json({ ok: true, slug, removed: pageFiles.length });
  } catch (err) {
    console.error("remove-page failed:", err);
    return json({ error: "Could not remove the page. Check the function logs." }, 502);
  }
}

export const POST = handler;
