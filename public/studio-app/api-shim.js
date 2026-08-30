/**
 * Makes Studio run without its local server.
 *
 * `kernic studio` normally talks to a Node server on 127.0.0.1. Here the same
 * client runs against kernic's real logic compiled to a browser bundle, with
 * fetch intercepted for /api/* so app.js needs no knowledge that it is on the
 * web.
 *
 * This build hands over no files. Tuning a system here is a demo; the tokens
 * are the product, so saving, reopening and exporting stay in the CLI. The
 * save route acknowledges the click and the client prompts for the install.
 *
 * Generated alongside this file by scripts/build-studio-embed.mjs.
 */
import { apiFonts, apiLooks, apiMeta, apiRandom, buildPalette, rankFonts } from './kernic-core.js';

const FONTS_URL = new URL('./fonts.json', import.meta.url);

/** Baked at build time: Google's metadata endpoint sends no CORS headers. */
let catalogPromise = null;
function getFontCatalog() {
  catalogPromise ??= fetch(FONTS_URL)
    .then((r) => (r.ok ? r.json() : []))
    .then((fonts) => ({ fonts, live: Array.isArray(fonts) && fonts.length > 50 }))
    .catch(() => ({ fonts: [], live: false }));
  return catalogPromise;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function route(url, init) {
  const path = url.pathname;
  const method = (init?.method ?? 'GET').toUpperCase();
  const body = init?.body ? JSON.parse(init.body) : {};

  if (method === 'GET' && path === '/api/meta') return json(apiMeta());
  if (method === 'GET' && path === '/api/looks') return json(await apiLooks());
  if (method === 'GET' && path === '/api/random') return json(apiRandom());

  if (method === 'POST' && path === '/api/palette') return json(buildPalette(body));

  if (method === 'GET' && path.startsWith('/api/fonts')) {
    const q = url.searchParams.get('q') ?? '';
    const limit = Number(url.searchParams.get('limit')) || undefined;
    return json(await apiFonts(q, limit, { getFontCatalog, rankFonts }));
  }

  // Deliberately writes nothing and returns no tokens. The client turns this
  // into the install prompt; a system is kept by running kernic locally.
  if (method === 'POST' && path === '/api/save') {
    return json({ name: body?.name || 'your system' });
  }

  // Loading a saved system means reading your machine. Say so plainly rather
  // than failing in a way the client would report as a server error.
  if (method === 'GET' && path.startsWith('/api/load/')) {
    return json({ error: 'Opening a saved system needs the kernic CLI on your own machine.' }, 404);
  }

  return json({ error: `Unknown endpoint: ${path}` }, 404);
}

const nativeFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  const raw = typeof input === 'string' ? input : input?.url ?? String(input);
  const url = new URL(raw, location.href);
  if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) {
    return nativeFetch(input, init);
  }
  return route(url, init).catch((err) =>
    json({ error: err?.message ?? 'Something went wrong generating that palette.' }, 500)
  );
};

// app.js reads ?load=<name> to open an existing system. There is nothing to
// open on the web, so drop the parameter before it asks and gets a 404.
if (new URLSearchParams(location.search).has('load')) {
  const clean = new URL(location.href);
  clean.searchParams.delete('load');
  history.replaceState(null, '', clean);
}
