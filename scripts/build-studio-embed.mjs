/**
 * Builds the embeddable web version of kernic Studio into public/studio-app/.
 *
 * Studio is normally a local app: `kernic studio` runs a Node server on
 * 127.0.0.1 that generates palettes, searches fonts, and reads and writes
 * ~/.config/kernic. None of that exists on a static site.
 *
 * Rather than rebuild Studio for the web (which would immediately drift from
 * the real product), this bundles the *actual* kernic source and shims the
 * browser's fetch for /api/* routes. studio/app.js therefore runs unmodified
 * apart from two asserted, documented string patches on the save path, where
 * the web version genuinely behaves differently: it downloads a file instead
 * of writing to your home directory.
 *
 * The bundle imports src/studio/server.ts directly, with Node builtins
 * stubbed. Only the pure functions are ever called (buildPalette, apiMeta,
 * apiLooks, apiFonts, apiRandom); the HTTP and filesystem paths in that module
 * are never reached in a browser. path and url get real (tiny) implementations
 * because server.ts evaluates a path at module load.
 *
 * Output is committed, matching how src/styles/tokens.css is already handled,
 * so Vercel does not need a kernic checkout to build the site.
 */
import { build } from 'esbuild';
import { mkdir, readFile, writeFile, rm, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const siteRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const kernicRoot = process.env.KERNIC_SRC ?? resolve(siteRoot, '..', 'kernic');
const outDir = join(siteRoot, 'public', 'studio-app');

if (!existsSync(join(kernicRoot, 'src', 'studio', 'server.ts'))) {
  console.error(
    `Cannot find the kernic source at ${kernicRoot}.\n` +
      `Clone it beside this repo, or set KERNIC_SRC=/path/to/kernic.\n` +
      `The committed output in public/studio-app/ stays valid meanwhile, so ` +
      `this only blocks regenerating the embed.`
  );
  process.exit(1);
}

/** Replace exactly once, and fail loudly if the source moved out from under us. */
function patch(source, from, to, label) {
  if (!source.includes(from)) {
    throw new Error(
      `Studio embed: could not find ${label} in the kernic source. ` +
        `studio/app.js has changed; update scripts/build-studio-embed.mjs to match.`
    );
  }
  return source.replace(from, to);
}

/**
 * Google's font metadata endpoint has no CORS headers, so the browser cannot
 * call it. Bake the catalog in at build time instead; that also removes a
 * runtime dependency on an undocumented endpoint. Falls back to whatever
 * kernic ships bundled if the fetch fails.
 */
async function fontCatalog() {
  try {
    const res = await fetch('https://fonts.google.com/metadata/fonts', {
      headers: { 'User-Agent': 'kernic-site build' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    let text = await res.text();
    if (text.startsWith(")]}'")) text = text.slice(text.indexOf('\n') + 1);
    const json = JSON.parse(text);
    const fonts = json.familyMetadataList.map((f) => ({
      family: f.family,
      category: String(f.category).toLowerCase(),
    }));
    if (fonts.length < 50) throw new Error('unexpected payload');
    console.log(`  fonts: baked ${fonts.length} families from Google`);
    return { fonts, live: true };
  } catch (err) {
    // Shipping Studio with an empty font picker is worse than not rebuilding.
    // The committed output from the last good build stays in place.
    console.error(
      `  fonts: could not fetch the Google catalog (${err.message}).\n` +
        `  Refusing to build an embed with no fonts. Try again when online.`
    );
    process.exit(1);
  }
}

/** Tiny real implementations for the two builtins server.ts touches at load. */
const NODE_SHIMS = {
  'node:path': `
    export const sep = "/";
    export function join(...p){return p.filter(Boolean).join("/").replace(/\\/+/g,"/");}
    export function dirname(p){const i=String(p).lastIndexOf("/");return i<=0?".":p.slice(0,i);}
    export function resolve(...p){return join(...p);}
    export function normalize(p){return String(p).replace(/\\/+/g,"/");}
    export function basename(p){return String(p).split("/").pop();}
    export function parse(p){return {root:"",dir:dirname(p),base:basename(p)};}
    export default {sep,join,dirname,resolve,normalize,basename,parse};
  `,
  'node:url': `
    export function fileURLToPath(u){return String(u).replace(/^file:\\/\\//,"");}
    export default {fileURLToPath};
  `,
};

/**
 * Everything else is only reachable through Studio's HTTP and filesystem
 * paths, which a browser never runs. Throw rather than return undefined so a
 * future refactor that *does* reach them fails loudly instead of silently.
 */
const NODE_STUBS = [
  'node:fs',
  'node:fs/promises',
  'node:os',
  'node:http',
  'node:child_process',
  'node:readline',
  'node:crypto',
];

const stubPlugin = {
  name: 'node-stubs',
  setup(b) {
    const filter = new RegExp(`^(${[...Object.keys(NODE_SHIMS), ...NODE_STUBS].join('|')})$`);
    b.onResolve({ filter }, (args) => ({ path: args.path, namespace: 'node-stub' }));
    b.onLoad({ filter: /.*/, namespace: 'node-stub' }, (args) => {
      if (NODE_SHIMS[args.path]) return { contents: NODE_SHIMS[args.path], loader: 'js' };
      const name = args.path.replace(/[^a-z]/gi, '_');
      return {
        loader: 'js',
        contents:
          `const nope=(fn)=>()=>{throw new Error("kernic web Studio: ${args.path}."+fn+" is not available in a browser");};\n` +
          `export const ${name}=new Proxy({},{get:(_,k)=>nope(String(k))});\n` +
          `export default ${name};\n` +
          // Named imports server.ts / storage.ts / fonts.ts actually write.
          [
            'readFile','writeFile','stat','access','mkdir','readdir','rename','rm','unlink',
            'createServer','spawn','homedir','createInterface','readFileSync','createHash',
          ].map((n) => `export const ${n}=nope("${n}");`).join('\n'),
      };
    });
  },
};

const entry = `
  export { buildPalette, apiMeta, apiLooks, apiFonts, apiRandom } from ${JSON.stringify(
    join(kernicRoot, 'src', 'studio', 'server.ts')
  )};
  export { rankFonts } from ${JSON.stringify(join(kernicRoot, 'src', 'fonts.ts'))};
  export { normalizeName } from ${JSON.stringify(join(kernicRoot, 'src', 'storage.ts'))};
`;

console.log(`Building Studio embed from ${kernicRoot}`);
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

// 1. The real kernic logic, bundled for the browser.
await build({
  stdin: { contents: entry, resolveDir: kernicRoot, sourcefile: 'kernic-core.ts', loader: 'ts' },
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  outfile: join(outDir, 'kernic-core.js'),
  plugins: [stubPlugin],
  logLevel: 'warning',
});
console.log('  bundled kernic-core.js');

// 2. The font catalog, baked in.
const { fonts } = await fontCatalog();
await writeFile(join(outDir, 'fonts.json'), JSON.stringify(fonts), 'utf8');

// 3. Studio's stylesheet, verbatim.
await cp(join(kernicRoot, 'studio', 'app.css'), join(outDir, 'app.css'));

// 4. Studio's client, with the save path adapted for the web.
let appJs = await readFile(join(kernicRoot, 'studio', 'app.js'), 'utf8');
appJs = patch(
  appJs,
  'setStatus(`Saved "${name}" ✓ — visible in \\`kernic list\\``, "ok");',
  'setStatus(`Downloaded "${name}.json" ✓ — open it with \\`kernic\\``, "ok");',
  'the save status line'
);
appJs = patch(
  appJs,
  'toast(`Saved "${name}"`);',
  'toast(`Downloaded "${name}.json"`);',
  'the save toast'
);
await writeFile(join(outDir, 'app.js'), appJs, 'utf8');
console.log('  copied app.js (save path adapted for the web)');

// 5. Studio's markup, with the shim loaded before the client.
let html = await readFile(join(kernicRoot, 'studio', 'index.html'), 'utf8');
html = patch(
  html,
  '<script src="/app.js"></script>',
  '<script type="module" src="./api-shim.js"></script>\n<script defer src="./app.js"></script>',
  'the app.js script tag'
);
html = patch(html, 'href="/app.css"', 'href="./app.css"', 'the stylesheet link');
html = patch(
  html,
  '<button id="save" class="btn primary wide">Save system</button>',
  '<button id="save" class="btn primary wide">Download system</button>',
  'the save button'
);
await writeFile(join(outDir, 'index.html'), html, 'utf8');
console.log('  copied index.html');

// 6. The fetch shim that stands in for Studio's local server.
await cp(join(siteRoot, 'scripts', 'studio-api-shim.js'), join(outDir, 'api-shim.js'));
console.log('  copied api-shim.js');

console.log(`Studio embed written to public/studio-app/`);
