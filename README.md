# gh-cdn

A Cloudflare Worker that lists a folder in a public GitHub repository using Git smart HTTP — not the GitHub API and not a `git` subprocess.

## API

```http
GET /owner/repo/path/to/folder/
```

Returns item names separated by newlines:

```text
Alpha
Beta
Gamma
```

Examples:

```text
/CocoaPods/Specs/Specs/0/3/5/
/owner/repo/                 # repository root
```

Folder URLs are canonicalized with a trailing slash. Only public GitHub repositories are supported. The Worker resolves the repository's `HEAD` ref.

Cloudflare Workers Cache sits in front of the Worker. Successful listings stay fresh for five minutes and may be served stale for up to one hour while Cloudflare refreshes them in the background; cache hits do not invoke the Worker.

## How it works

1. Resolve `HEAD` with Git's smart HTTP protocol.
2. Fetch the commit at depth 1 with `filter tree:0`.
3. Traverse the requested folder one tree object at a time.
4. Return names from the final tree.

GitHub requires lazy tree backfills to include the shallow commit boundary:

```text
shallow <commit-sha>
filter blob:none
want <tree-sha>
```

`git-remote-ops@0.2.0` does not expose this boundary, so `patches/git-remote-ops+0.2.0.patch` adds `fetchTree(sha, { shallowCommit })`. `patch-package` reapplies it after installs.

## Development

Requires Node 24 (configured in `mise.toml`).

```bash
npm install
npm test
npm run check
npm run dev
```

Deploy with:

```bash
npm run deploy
```

Wrangler enables `nodejs_compat` with compatibility date `2026-07-18`, giving `git-remote-ops` access to Workers' request-scoped `/tmp` virtual filesystem and Node compatibility APIs. It also enables the new Workers Cache with `"cache": { "enabled": true }`; caching is controlled by the Worker's `Cache-Control` response header and needs no binding.

## Runtime limits

`/tmp` is memory-backed and request-scoped. Large repositories can require large packfiles while resolving high-level trees. Cloudflare limits individual VFS files to 128 MB, and all VFS data counts toward Worker memory. CocoaPods/Specs currently produces an approximately 81 MB root-tree upload-pack response, so it fits the per-file limit but is close enough to memory limits to warrant production testing.
