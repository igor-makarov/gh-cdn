# gh-cdn

A Cloudflare Worker that serves folders and files from public GitHub repositories using Git smart HTTP — not the GitHub API and not a `git` subprocess.

## API

```http
GET /owner/repo/path/to/folder/
GET /owner/repo/path/to/file.json
```

Directories return item names separated by newlines. Files return their exact Git blob contents with a content type inferred from the extension.

Examples:

```text
/CocoaPods/Specs/Specs/0/3/5/
/CocoaPods/Specs/Specs/2/2/2/AppNetworkManager/1.0.0/AppNetworkManager.podspec.json
/owner/repo/                 # repository root
```

Folder URLs are canonicalized with a trailing slash. Only public GitHub repositories are supported. The Worker resolves the repository's `HEAD` ref.

For compatibility with the CocoaPods CDN, two virtual index forms are generated directly from the Specs repository's Git trees:

```text
/CocoaPods/Specs/all_pods.txt
/CocoaPods/Specs/all_pods_versions_2_2_2.txt
```

`all_pods.txt` concurrently aggregates 16 cached first-character shard indices so each shard gets its own Worker CPU budget. Within a shard, tree wants are batched by level. A versions index similarly batches all pod trees in its three-character shard. None of these operations downloads podspec blobs.

Cloudflare Workers Cache sits in front of the Worker. Successful directories, files, and generated indices stay fresh for five minutes and may be served stale for up to one hour while Cloudflare refreshes them in the background; cache hits do not invoke the Worker.

## How it works

1. Resolve `HEAD` with Git's smart HTTP protocol.
2. Fetch the commit at depth 1 with `filter tree:0`.
3. Traverse the requested path one tree object at a time.
4. Return a directory listing or lazily fetch the final blob. CocoaPods virtual indices batch their tree wants by shard level.

GitHub requires lazy tree backfills to include the shallow commit boundary:

```text
shallow <commit-sha>
filter tree:0
want <tree-sha>
```

`git-remote-ops@0.2.0` does not expose this boundary, so `patches/git-remote-ops+0.2.0.patch` adds shallow-aware blob/tree fetches and batched `fetchTrees`. `patch-package` reapplies it after installs.

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

`/tmp` is memory-backed and request-scoped. Cloudflare limits individual VFS files to 128 MB, and all VFS data counts toward Worker memory. Lazy tree fetches use `filter tree:0`, so GitHub returns only the explicitly requested tree rather than its full descendant tree graph. For example, a CocoaPods/Specs traversal that otherwise produces an approximately 81 MB root-tree pack transfers only a few kilobytes of pack data.
