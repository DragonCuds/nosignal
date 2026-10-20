# Third-party notices

NoSignal itself is MIT licensed (see `LICENSE`). It bundles or depends on the following third-party material.

## Fonts (self-hosted, SIL Open Font License 1.1)

- **Inter** (`apps/web/public/fonts/inter-*.woff2`), Copyright (c) 2016 The Inter Project Authors. License text: `apps/web/public/fonts/OFL-Inter.txt`.
- **Vazirmatn** (`apps/web/public/fonts/vazirmatn-*.woff2`), Copyright (c) 2015 The Vazirmatn Project Authors. License text: `apps/web/public/fonts/OFL-Vazirmatn.txt`.

The fonts are subsets distributed unmodified in name and licence; they are not sold on their own.

## Emoji images: Noto Emoji (Apache-2.0)

The emoji images in `apps/web/public/emoji/` are Google Noto Emoji
(https://github.com/googlefonts/noto-emoji), Copyright Google LLC, licensed under the
Apache License, Version 2.0. The full license text and attribution are in
`apps/web/public/emoji/LICENSE` and `apps/web/public/emoji/NOTICE.txt`.
Country flags come from the region-flags project (public domain / CC0 where applicable).
The images were obtained from the npm package `emoji-datasource-google` (MIT) and palette-compressed
with pngquant; they are self-hosted (no runtime network access). Regenerate with `scripts/gen-emoji.mjs`.

## Runtime npm dependencies

Generated offline from `node_modules` with `node scripts/licenses.mjs --markdown` (production dependencies of every workspace, including transitive ones; regenerate after changing dependencies). Each package keeps its own licence file inside its npm tarball.

| Package | Version | License |
| --- | --- | --- |
| @babel/code-frame | 7.29.7 | MIT |
| @babel/compat-data | 7.29.7 | MIT |
| @babel/core | 7.29.7 | MIT |
| @babel/generator | 7.29.8 | MIT |
| @babel/helper-compilation-targets | 7.29.7 | MIT |
| @babel/helper-globals | 7.29.7 | MIT |
| @babel/helper-module-imports | 7.29.7 | MIT |
| @babel/helper-module-transforms | 7.29.7 | MIT |
| @babel/helper-plugin-utils | 7.29.7 | MIT |
| @babel/helper-string-parser | 7.29.7 | MIT |
| @babel/helper-validator-identifier | 7.29.7 | MIT |
| @babel/helper-validator-option | 7.29.7 | MIT |
| @babel/helpers | 7.29.10 | MIT |
| @babel/parser | 7.29.9 | MIT |
| @babel/plugin-transform-react-jsx-self | 7.29.7 | MIT |
| @babel/plugin-transform-react-jsx-source | 7.29.7 | MIT |
| @babel/template | 7.29.7 | MIT |
| @babel/traverse | 7.29.10 | MIT |
| @babel/types | 7.29.8 | MIT |
| @epic-web/invariant | 1.0.0 | MIT |
| @esbuild/linux-x64 | 0.28.2 | MIT |
| @fastify/accept-negotiator | 2.1.1 | MIT |
| @fastify/ajv-compiler | 4.0.6 | MIT |
| @fastify/busboy | 3.2.2 | MIT |
| @fastify/compress | 9.2.2 | MIT |
| @fastify/cookie | 11.1.3 | MIT |
| @fastify/deepmerge | 3.2.2 | MIT |
| @fastify/error | 4.2.0 | MIT |
| @fastify/fast-json-stringify-compiler | 5.1.0 | MIT |
| @fastify/forwarded | 3.0.2 | MIT |
| @fastify/helmet | 13.2.0 | MIT |
| @fastify/merge-json-schemas | 0.2.1 | MIT |
| @fastify/multipart | 10.1.3 | MIT |
| @fastify/proxy-addr | 5.1.1 | MIT |
| @fastify/rate-limit | 10.3.0 | MIT |
| @fastify/send | 4.1.2 | MIT |
| @fastify/static | 10.1.6 | MIT |
| @hexagon/base64 | 1.1.28 | MIT |
| @jridgewell/gen-mapping | 0.3.13 | MIT |
| @jridgewell/remapping | 2.3.5 | MIT |
| @jridgewell/resolve-uri | 3.1.2 | MIT |
| @jridgewell/sourcemap-codec | 1.6.0 | MIT |
| @jridgewell/trace-mapping | 0.3.31 | MIT |
| @levischuck/tiny-cbor | 0.2.11 | MIT |
| @lukeed/ms | 2.0.2 | MIT |
| @napi-rs/lzma-linux-x64-gnu | 1.5.1 | MIT |
| @peculiar/asn1-android | 2.11.0 | MIT |
| @peculiar/asn1-asym-key | 2.11.0 | MIT |
| @peculiar/asn1-cms | 2.11.0 | MIT |
| @peculiar/asn1-csr | 2.11.0 | MIT |
| @peculiar/asn1-ecc | 2.11.0 | MIT |
| @peculiar/asn1-pfx | 2.11.0 | MIT |
| @peculiar/asn1-pkcs8 | 2.11.0 | MIT |
| @peculiar/asn1-pkcs9 | 2.11.0 | MIT |
| @peculiar/asn1-rsa | 2.11.0 | MIT |
| @peculiar/asn1-schema | 2.11.0 | MIT |
| @peculiar/asn1-x509 | 2.11.0 | MIT |
| @peculiar/asn1-x509-attr | 2.11.0 | MIT |
| @peculiar/asn1-x509-post-quantum | 2.11.0 | MIT |
| @peculiar/utils | 2.0.3 | MIT |
| @peculiar/x509 | 2.1.0 | MIT |
| @phc/format | 1.0.0 | MIT |
| @pinojs/redact | 0.4.0 | MIT |
| @rolldown/pluginutils | 1.0.0-rc.3 | MIT |
| @rollup/rollup-linux-x64-gnu | 4.64.3 | MIT |
| @simplewebauthn/browser | 14.0.0 | MIT |
| @simplewebauthn/server | 14.0.3 | MIT |
| @types/babel__core | 7.20.5 | MIT |
| @types/estree | 1.0.9 | MIT |
| @vitejs/plugin-react | 5.2.0 | MIT |
| abstract-logging | 2.0.1 | MIT |
| ajv | 8.20.0 | MIT |
| ajv-formats | 3.0.1 | MIT |
| argon2 | 0.44.0 | MIT |
| asn1js | 3.0.10 | BSD-3-Clause |
| atomic-sleep | 1.0.0 | MIT |
| avvio | 9.3.0 | MIT |
| balanced-match | 4.0.4 | MIT |
| baseline-browser-mapping | 2.11.28 | Apache-2.0 |
| better-sqlite3 | 13.0.3 | MIT |
| brace-expansion | 5.0.12 | MIT |
| browserslist | 4.29.3 | MIT |
| caniuse-lite | 1.0.30001815 | CC-BY-4.0 |
| content-disposition | 3.0.0 | MIT |
| convert-source-map | 2.0.0 | MIT |
| cookie | 2.0.1 | MIT |
| cookie | 1.1.1 | MIT |
| cross-env | 10.1.0 | MIT |
| cross-spawn | 7.0.6 | MIT |
| debug | 4.4.3 | MIT |
| depd | 2.0.0 | MIT |
| dequal | 2.0.3 | MIT |
| dexie | 4.4.6 | Apache-2.0 |
| electron-to-chromium | 1.5.451 | ISC |
| esbuild | 0.28.2 | MIT |
| escalade | 3.2.0 | MIT |
| escape-html | 1.0.3 | MIT |
| fast-decode-uri-component | 1.0.1 | MIT |
| fast-deep-equal | 3.1.3 | MIT |
| fast-json-stringify | 7.0.1 | MIT |
| fast-querystring | 1.1.2 | MIT |
| fast-uri | 3.1.8 | BSD-3-Clause |
| fast-uri | 4.2.2 | BSD-3-Clause |
| fastify | 5.12.5 | MIT |
| fastify-plugin | 6.0.1 | MIT |
| fastify-plugin | 5.1.0 | MIT |
| fastq | 1.20.3 | ISC |
| fdir | 6.5.0 | MIT |
| find-my-way | 9.9.0 | MIT |
| gensync | 1.0.0-beta.2 | MIT |
| glob | 13.0.6 | BlueOak-1.0.0 |
| helmet | 8.3.0 | MIT |
| http-errors | 2.0.1 | MIT |
| inherits | 2.0.4 | ISC |
| ipaddr.js | 2.5.0 | MIT |
| isexe | 2.0.0 | ISC |
| js-tokens | 4.0.0 | MIT |
| jsesc | 3.1.0 | MIT |
| json-schema-ref-resolver | 3.0.0 | MIT |
| json-schema-traverse | 1.0.0 | MIT |
| json5 | 2.2.3 | MIT |
| light-my-request | 6.6.0 | BSD-3-Clause |
| lottie-web | 5.13.0 | MIT |
| lru-cache | 11.5.3 | BlueOak-1.0.0 |
| lru-cache | 5.1.1 | ISC |
| mime | 3.0.0 | MIT |
| mime-db | 1.54.0 | MIT |
| minimatch | 10.2.6 | BlueOak-1.0.0 |
| minipass | 7.1.3 | BlueOak-1.0.0 |
| ms | 2.1.3 | MIT |
| nanoid | 3.3.20 | MIT |
| node-addon-api | 8.9.2 | MIT |
| node-gyp-build | 4.8.4 | MIT |
| node-releases | 2.0.58 | MIT |
| on-exit-leak-free | 2.1.2 | MIT |
| pako | 2.2.0 | (MIT AND Zlib) |
| path-key | 3.1.1 | MIT |
| path-scurry | 2.0.2 | BlueOak-1.0.0 |
| picocolors | 1.1.1 | ISC |
| picomatch | 4.0.7 | MIT |
| pino | 10.4.0 | MIT |
| pino-abstract-transport | 3.0.0 | MIT |
| pino-std-serializers | 7.1.0 | MIT |
| postcss | 8.5.29 | MIT |
| process-warning | 4.0.1 | MIT |
| process-warning | 5.1.1 | MIT |
| pvtsutils | 1.3.6 | MIT |
| pvutils | 1.2.0 | MIT |
| quick-format-unescaped | 4.0.4 | MIT |
| react | 19.3.0 | MIT |
| react-dom | 19.3.0 | MIT |
| react-refresh | 0.18.0 | MIT |
| real-require | 1.0.0 | MIT |
| reflect-metadata | 0.2.2 | Apache-2.0 |
| require-from-string | 2.0.2 | MIT |
| ret | 0.5.0 | MIT |
| reusify | 1.1.0 | MIT |
| rfdc | 1.4.1 | MIT |
| rollup | 4.64.3 | MIT |
| safe-regex2 | 5.1.1 | MIT |
| safe-stable-stringify | 2.5.0 | MIT |
| scheduler | 0.28.0 | MIT |
| secure-json-parse | 4.1.0 | BSD-3-Clause |
| semver | 7.8.5 | ISC |
| semver | 6.3.1 | ISC |
| set-cookie-parser | 2.7.2 | MIT |
| setprototypeof | 1.2.0 | ISC |
| shebang-command | 2.0.0 | MIT |
| shebang-regex | 3.0.0 | MIT |
| sonic-boom | 4.2.1 | MIT |
| source-map-js | 1.2.2 | BSD-3-Clause |
| split2 | 4.2.0 | ISC |
| statuses | 2.0.2 | MIT |
| thread-stream | 4.2.0 | MIT |
| thumbhash | 0.1.1 | MIT |
| tinyglobby | 0.2.17 | MIT |
| toad-cache | 3.7.4 | MIT |
| toidentifier | 1.0.1 | MIT |
| tslib | 2.8.1 | 0BSD |
| tslib | 1.14.1 | 0BSD |
| tsyringe | 4.10.0 | MIT |
| update-browserslist-db | 1.3.4 | MIT |
| vite | 7.3.7 | MIT |
| which | 2.0.2 | ISC |
| ws | 8.22.0 | MIT |
| yallist | 3.1.1 | ISC |
