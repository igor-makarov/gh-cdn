import { RemoteGit } from "git-remote-ops";

const GITHUB_NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const COCOAPODS_VERSION_INDEX = /^all_pods_versions_([0-9a-f])_([0-9a-f])_([0-9a-f])\.txt$/;
const COCOAPODS_POD_PREFIX_INDEX = /^all_pods_prefix_([0-9a-f])\.txt$/;
const COCOAPODS_SHARDS = "0123456789abcdef";
const TREE_MODE = "40000";
const GITLINK_MODE = "160000";
const CACHE_FRESH_SECONDS = 300;
const CACHE_STALE_SECONDS = 3600;
const CACHE_CONTROL =
  `public, max-age=${CACHE_FRESH_SECONDS}, ` +
  `stale-while-revalidate=${CACHE_STALE_SECONDS}`;

const CONTENT_TYPES = new Map([
  ["css", "text/css; charset=utf-8"],
  ["gif", "image/gif"],
  ["htm", "text/html; charset=utf-8"],
  ["html", "text/html; charset=utf-8"],
  ["jpeg", "image/jpeg"],
  ["jpg", "image/jpeg"],
  ["js", "text/javascript; charset=utf-8"],
  ["json", "application/json; charset=utf-8"],
  ["md", "text/markdown; charset=utf-8"],
  ["mjs", "text/javascript; charset=utf-8"],
  ["png", "image/png"],
  ["svg", "image/svg+xml; charset=utf-8"],
  ["txt", "text/plain; charset=utf-8"],
  ["webp", "image/webp"],
  ["xml", "application/xml; charset=utf-8"],
]);

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function unwrap(result) {
  if (result.isErr()) throw result.error;
  return result.value;
}

function decodeSegment(segment) {
  let decoded;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    throw new HttpError(400, "Malformed URL encoding");
  }

  if (!decoded || decoded === "." || decoded === ".." || /[\0/]/.test(decoded)) {
    throw new HttpError(400, "Invalid path component");
  }
  return decoded;
}

/** Parse /owner/repo/path into a fixed GitHub remote and repository path. */
export function parseRoute(url) {
  const segments = url.pathname.split("/").filter(Boolean).map(decodeSegment);
  if (segments.length < 2) {
    throw new HttpError(400, "Expected /owner/repo/path");
  }
  if (segments.length > 32) {
    throw new HttpError(400, "Path is too deep");
  }

  const [owner, rawRepo, ...path] = segments;
  const repo = rawRepo.replace(/\.git$/i, "");
  if (!GITHUB_NAME.test(owner) || !GITHUB_NAME.test(repo)) {
    throw new HttpError(400, "Invalid GitHub owner or repository name");
  }

  return {
    owner,
    repo,
    path,
    trailingSlash: url.pathname.endsWith("/"),
    origin: url.origin,
    remoteUrl: `https://github.com/${owner}/${repo}.git`,
  };
}

/** Open one request-scoped smart HTTP session at the remote HEAD commit. */
async function openRepository(remoteUrl) {
  const git = new RemoteGit(remoteUrl, { storeDir: "/tmp/gh-cdn" });
  const commitSha = unwrap(await git.resolveRef("HEAD"));
  const fetchedCommit = unwrap(await git.fetchCommit(commitSha, {
    depth: 1,
    filter: "tree:0",
  }));
  const options = { shallowCommit: commitSha };

  return {
    rootTreeSha: fetchedCommit.commit.tree,
    fetchTree: async sha => unwrap(await git.fetchTree(sha, options)),
    fetchTrees: async shas => unwrap(await git.fetchTrees(shas, options)),
    fetchTreeNames: async shas => unwrap(await git.fetchTreeNames(shas, options)),
    fetchBlob: async sha => unwrap(await git.fetchBlob(sha, options)),
  };
}

async function findEntry(repository, path) {
  if (path.length === 0) {
    return { mode: TREE_MODE, name: "", sha: repository.rootTreeSha };
  }

  let treeSha = repository.rootTreeSha;
  for (let index = 0; index < path.length; index++) {
    const entries = await repository.fetchTree(treeSha);
    const entry = entries.find(candidate => candidate.name === path[index]);
    if (!entry) throw new HttpError(404, "Path not found");
    if (index === path.length - 1) return entry;
    if (entry.mode !== TREE_MODE) throw new HttpError(404, "Path not found");
    treeSha = entry.sha;
  }
}

async function findDirectorySha(repository, path) {
  const entry = await findEntry(repository, path);
  if (entry.mode !== TREE_MODE) throw new HttpError(404, "Directory not found");
  return entry.sha;
}

function sorted(values) {
  return values.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function treeChildren(entries) {
  return entries.filter(entry => entry.mode === TREE_MODE);
}

/** Generate CocoaPods' complete pod-name index with one batched fetch per shard level. */
export async function createAllPodsIndex(repository, prefix = []) {
  let level = [await findDirectorySha(repository, ["Specs", ...prefix])];

  for (let depth = prefix.length; depth < 3; depth++) {
    const trees = await repository.fetchTrees(level);
    const children = level.flatMap(sha => treeChildren(trees.get(sha) ?? []));
    level = children.map(entry => entry.sha);
  }

  const trees = await repository.fetchTreeNames(level);
  return sorted(level.flatMap(sha => trees.get(sha) ?? []));
}

/** Generate one all_pods_versions_a_b_c.txt shard. */
export async function createPodVersionsIndex(repository, prefix) {
  const shardSha = await findDirectorySha(repository, ["Specs", ...prefix]);
  const pods = treeChildren(await repository.fetchTree(shardSha));
  const trees = await repository.fetchTrees(pods.map(pod => pod.sha));

  return sorted(pods.map(pod => {
    const versions = sorted(treeChildren(trees.get(pod.sha) ?? []).map(entry => entry.name));
    return [pod.name, ...versions].join("/");
  }));
}

function contentTypeFor(path) {
  const name = path.at(-1) ?? "";
  const extension = name.includes(".") ? name.split(".").at(-1).toLowerCase() : "";
  return CONTENT_TYPES.get(extension) ?? "application/octet-stream";
}

async function readRepositoryPath(repository, path) {
  const entry = await findEntry(repository, path);
  if (entry.mode === TREE_MODE) {
    const entries = await repository.fetchTree(entry.sha);
    return { kind: "directory", names: entries.map(candidate => candidate.name) };
  }
  if (entry.mode === GITLINK_MODE) {
    throw new HttpError(400, "Git submodules cannot be served as files");
  }

  return {
    kind: "file",
    body: await repository.fetchBlob(entry.sha),
    contentType: contentTypeFor(path),
  };
}

function isCocoaPodsSpecs(route) {
  return route.owner.toLowerCase() === "cocoapods" && route.repo.toLowerCase() === "specs";
}

/** Aggregate cached first-character pod indices without sharing their CPU budget. */
export async function fetchAllPodsIndex(origin, fetcher = fetch) {
  const responses = await Promise.all([...COCOAPODS_SHARDS].map(prefix =>
    fetcher(`${origin}/CocoaPods/Specs/all_pods_prefix_${prefix}.txt`),
  ));
  const failed = responses.find(response => !response.ok);
  if (failed) throw new Error(`CocoaPods prefix index failed: ${failed.status}`);

  const bodies = await Promise.all(responses.map(response => response.text()));
  return sorted(bodies.flatMap(body => body.split("\n").filter(Boolean)));
}

/** Resolve virtual CocoaPods indices or a normal repository directory/file. */
export async function resolveRemoteRoute(route) {
  if (
    isCocoaPodsSpecs(route) &&
    route.path.length === 1 &&
    route.path[0] === "all_pods.txt"
  ) {
    return { kind: "index", lines: await fetchAllPodsIndex(route.origin) };
  }

  const repository = await openRepository(route.remoteUrl);

  if (isCocoaPodsSpecs(route) && route.path.length === 1) {
    const prefixMatch = COCOAPODS_POD_PREFIX_INDEX.exec(route.path[0]);
    if (prefixMatch) {
      return { kind: "index", lines: await createAllPodsIndex(repository, prefixMatch.slice(1)) };
    }

    const versionMatch = COCOAPODS_VERSION_INDEX.exec(route.path[0]);
    if (versionMatch) {
      return {
        kind: "index",
        lines: await createPodVersionsIndex(repository, versionMatch.slice(1)),
      };
    }
  }

  return readRepositoryPath(repository, route.path);
}

function response(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });
}

function successfulResponse(result) {
  if (result.kind === "file") {
    return response(result.body, 200, {
      "cache-control": CACHE_CONTROL,
      "content-type": result.contentType,
    });
  }

  const lines = result.kind === "directory" ? result.names : result.lines;
  const body = lines.length === 0 ? "" : `${lines.join("\n")}\n`;
  return response(body, 200, { "cache-control": CACHE_CONTROL });
}

/** Dependency injection keeps routing tests offline. */
export function createWorker(resolveRoute = resolveRemoteRoute) {
  return {
    async fetch(request) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return response("Method not allowed\n", 405, { allow: "GET, HEAD" });
      }

      const url = new URL(request.url);
      let route;
      try {
        route = parseRoute(url);
      } catch (error) {
        const status = error instanceof HttpError ? error.status : 400;
        return response(`${error.message}\n`, status);
      }

      try {
        const result = await resolveRoute(route);
        if (result.kind === "directory" && !route.trailingSlash) {
          const redirect = new URL(url);
          redirect.pathname += "/";
          return Response.redirect(redirect.toString(), 308);
        }
        if (result.kind !== "directory" && route.trailingSlash) {
          throw new HttpError(404, "File not found");
        }

        const resolvedResponse = successfulResponse(result);
        return request.method === "HEAD"
          ? new Response(null, resolvedResponse)
          : resolvedResponse;
      } catch (error) {
        if (!(error instanceof HttpError) || error.status >= 500) console.error(error);
        const status = error instanceof HttpError ? error.status : 502;
        const message = status === 404 || status === 400
          ? error.message
          : "Git upstream request failed";
        return response(`${message}\n`, status);
      }
    },
  };
}

export default createWorker();
