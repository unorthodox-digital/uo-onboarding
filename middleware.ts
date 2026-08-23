import { next } from "@vercel/edge";

/**
 * Password gate for the team library.
 *
 * Vercel port of netlify/edge-functions/library-gate.ts. Guards "/" and
 * "/pages.json" only — client pages at /<slug>/ stay public, because clients
 * open those links directly and have no code.
 *
 * The password lives in LIBRARY_PASSWORD and never reaches the browser. A
 * successful login sets a cookie holding sha256(password), so the raw secret
 * is not stored client-side either.
 *
 * NOTE: this does NOT cover /api/*. Vercel matches middleware by path, and the
 * API routes are deliberately excluded — /api/state is public by design, and
 * /api/remove-page re-checks this same cookie itself.
 *
 * Fails CLOSED: with LIBRARY_PASSWORD unset, nothing is served.
 */

const COOKIE = "uo_lib";
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days

export const config = {
  matcher: ["/", "/pages.json"],
};

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

function loginPage(message: string, status: number): Response {
  return new Response(
    `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Client Library — Unorthodox</title>
<style>
  :root{--bg:#0a0e16;--panel:#131a25;--line:rgba(255,255,255,.09);
        --ink:#e9eff7;--muted:#8b97a8;--brand:#2f6bfa;--brand-hi:#4880ff}
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:var(--bg);color:var(--ink);min-height:100vh;padding:56px 24px;
       font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Helvetica,Arial,sans-serif;
       -webkit-font-smoothing:antialiased}
  .wrap{max-width:860px;margin:0 auto}
  header{display:flex;align-items:flex-start;gap:12px}
  .glyph{width:30px;height:30px;flex:0 0 30px;border-radius:8px;background:var(--brand);
         display:flex;align-items:center;justify-content:center;margin-top:3px;
         font-family:ui-monospace,monospace;font-size:13px;font-weight:700;color:#fff}
  h1{font-size:30px;line-height:1.15;letter-spacing:-.02em;font-weight:700}
  .sub{color:var(--muted);font-size:15px;line-height:1.5;margin:6px 0 0 42px}
  form{margin:36px 0 0 42px;max-width:340px}
  label{display:block;font-size:12px;letter-spacing:.12em;text-transform:uppercase;
        color:var(--muted);margin-bottom:8px;font-weight:600}
  input{width:100%;font:inherit;font-size:15px;padding:12px 14px;border:1px solid var(--line);
        border-radius:10px;background:var(--panel);color:var(--ink)}
  input::placeholder{color:var(--muted)}
  input:focus{outline:none;border-color:var(--brand);box-shadow:0 0 0 3px rgba(47,107,250,.22)}
  button{margin-top:12px;font:inherit;font-size:14px;font-weight:600;padding:11px 22px;
         border:0;border-radius:9px;background:var(--brand);color:#fff;cursor:pointer}
  button:hover{background:var(--brand-hi)}
  .msg{color:#f87171;font-size:13px;margin-top:10px;min-height:18px}
</style>
</head>
<body>
  <div class="wrap">
    <header><div class="glyph">UO</div><div><h1>Client Library</h1></div></header>
    <p class="sub">Team only. Client onboarding pages are at their own private links.</p>
    <form method="POST" autocomplete="off">
      <label for="p">Access code</label>
      <input id="p" name="password" type="password" placeholder="Enter the team code" autofocus>
      <button type="submit">Enter</button>
      <div class="msg">${message}</div>
    </form>
  </div>
</body>
</html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
}

export default async function middleware(request: Request): Promise<Response> {
  const secret = process.env.LIBRARY_PASSWORD;

  // Fail closed — never serve the library without a configured password.
  if (!secret) {
    return new Response("Library is not configured (LIBRARY_PASSWORD is unset).", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }

  const expected = await sha256Hex(secret);

  if (request.method === "POST") {
    const form = await request.formData();
    const supplied = String(form.get("password") ?? "");
    if (!safeEqual(await sha256Hex(supplied), expected)) {
      return loginPage("Not quite — check the code and try again.", 401);
    }
    return new Response(null, {
      status: 303,
      headers: {
        location: "/",
        "cache-control": "no-store",
        "set-cookie": `${COOKIE}=${expected}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; Secure; SameSite=Lax`,
      },
    });
  }

  const cookie = readCookie(request.headers.get("cookie"), COOKIE);
  if (cookie && safeEqual(cookie, expected)) {
    // Let the static file through, but never let it sit in a shared cache.
    return next({ headers: { "cache-control": "no-store" } });
  }

  return loginPage("", 401);
}
