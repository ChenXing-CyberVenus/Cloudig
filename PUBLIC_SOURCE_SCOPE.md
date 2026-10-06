# Cloudig 1.0.5 public source snapshot

This directory is a local, reviewable candidate for a future public source snapshot. It is not an upload and does not contain the repository's Git history.

Included:

- current V1 source for the desktop shell, Manager, Parser, Reader, Library and Content Time;
- public schemas, contracts, build scripts, stable bookmark outputs and V1 tests;
- `LICENSE`, `NOTICE.md`, package manifests and vendored runtime dependencies needed to understand the build.

Intentionally omitted:

- private conversations, user libraries, Organized exports and full platform examples;
- internal history manuscripts and artwork provenance;
- dated/private regression scripts and fixtures that require local private paths;
- generated `manager/web` output, caches, installers, releases, signatures and test payloads;
- legacy, candidate and test bookmark collections.

The candidate also carries only the 32 current bookmark artifacts referenced by the bookmark package. Their manifest paths are resolved relative to the Manager-owned `manager/bookmarks/artifacts/` root; the local verifier confirms all 32 files and their hashes.

The omitted product examples and public documents are served separately by the Cloudig documentation site. Before publication, the snapshot still needs a final license/inventory review, a clean build from this tree, and a decision on whether the current README download links should be updated from V1.0.4 to the release being published.
