# Cloudig 1.0.5 source snapshot

This snapshot contains the current Cloudig V1 implementation without the local Git history, private libraries, platform example exports, legacy bookmark archive, build output, installers or signatures.

## Build locally

1. Install Node.js 20.19 or newer.
2. Run `npm ci`.
3. Run `npm run check:v1:types`.
4. Run `npm run build` to regenerate UI output and the Reader bundle.
5. Run the focused V1 tests listed in `package.json`.

The Windows desktop project also requires the .NET SDK and Microsoft WebView2 development/runtime components described by the desktop project files. The signed Windows installer is distributed separately through the GitHub release page.

## Scope

The public documentation site and platform examples are separate from this source snapshot. This tree keeps schemas, Parser/Reader/Library code, desktop code, tests, build scripts and stable bookmark outputs so another developer can inspect and rebuild the implementation without receiving user data or the historical construction archive.

The exact file list and SHA-256 values are in `public-source-manifest.json` beside this snapshot. `NOTICE.md` and `THIRD_PARTY_INVENTORY.md` identify bundled and runtime dependencies; publication must regenerate the inventory from the final clean source commit.

The bookmark package is included as the current accepted outputs only. Its `bookmarklets/...` paths are relative to the Manager-owned `manager/bookmarks/artifacts/` root, and the package verifier checks all 32 frozen artifacts and their hashes.
