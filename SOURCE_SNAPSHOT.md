# Cloudig 1.0.7 source snapshot

Production code is copied byte-for-byte from build commit `5b1479b04af473a8ec4abdcd5c699c8019495ffd`, the source of the signed 1.0.7 installer. README version links and this snapshot metadata are release documentation. The included bookmark package is the exact accepted set 2026.10.18.2 from that installer.

This is an inspectable source snapshot, without local development history, personal libraries, private test inputs, or platform examples. Public product documents and examples remain available at https://chenxing-cybervenus.github.io/Cloudig/.

## Development

Use Node.js 24 and run `npm ci`, then `npm run check:v1:types`. Reader and Engine components can be built and checked with the corresponding scripts in `scripts/`. Windows desktop source is in `src/desktop/` and targets .NET 10 / Windows x64 with WebView2.

The internal full-installer assembly scripts also depend on omitted document manuscripts, private acceptance evidence, artwork provenance, and locally provisioned runtimes. They are included for reference, not advertised as a one-command reproduction of the signed installer from this reduced snapshot. Signing keys and signatures are not source inputs.

`SOURCE_FILES.json` records the SHA-256 and origin of every included file except the manifest itself.
