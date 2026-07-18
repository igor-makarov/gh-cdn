import { RemoteGit } from "git-remote-ops";

const GITHUB_NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const TREE_MODE = "40000";
const CACHE_FRESH_SECONDS = 300;
const CACHE_STALE_SECONDS = 3600;

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

/** Parse /owner/repo/path/to/folder/ into a fixed GitHub remote and tree path. */
export function parseRoute(url) {
  if (!url.pathname.endsWith("/")) {
    const redirect = new URL(url);
    redirect.pathname += "/";
    throw new HttpError(308, redirect.toString());
  }

  const segments = url.pathname.split("/").filter(Boolean).map(decodeSegment);
  if (segments.length < 2) {
    throw new HttpError(400, "Expected /owner/repo/path/to/folder/");
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
    remoteUrl: `https://github.com/${owner}/${repo}.git`,
  };
}

/**
 * Traverse one Git tree at a time using smart HTTP.
 *
 * /tmp is request-scoped in Workers. git-remote-ops uses it for transient
 * loose objects and packfiles; nothing persists into another request.
 */
export async function listRemoteDirectory({ remoteUrl, path }) {
  const git = new RemoteGit(remoteUrl, { storeDir: "/tmp/gh-cdn" });
  const commitSha = unwrap(await git.resolveRef("HEAD"));
  const fetchedCommit = unwrap(await git.fetchCommit(commitSha, {
    depth: 1,
    filter: "tree:0",
  }));

  let treeSha = fetchedCommit.commit.tree;

  for (const component of path) {
    const entries = unwrap(await git.fetchTree(treeSha, {
      shallowCommit: commitSha,
    }));
    const entry = entries.find(candidate => candidate.name === component);
    if (!entry || entry.mode !== TREE_MODE) {
      throw new HttpError(404, "Directory not found");
    }
    treeSha = entry.sha;
  }

  const entries = unwrap(await git.fetchTree(treeSha, {
    shallowCommit: commitSha,
  }));
  return entries.map(entry => entry.name);
}

function textResponse(body, status = 200, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
      ...extraHeaders,
    },
  });
}

/** Dependency injection keeps routing tests offline. */
export function createWorker(listDirectory = listRemoteDirectory) {
  return {
    async fetch(request) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return textResponse("Method not allowed\n", 405, { allow: "GET, HEAD" });
      }

      const url = new URL(request.url);
      let route;
      try {
        route = parseRoute(url);
      } catch (error) {
        if (error instanceof HttpError && error.status === 308) {
          return Response.redirect(error.message, 308);
        }
        const status = error instanceof HttpError ? error.status : 400;
        return textResponse(`${error.message}\n`, status);
      }

      try {
        const names = await listDirectory(route);
        const body = names.length === 0 ? "" : `${names.join("\n")}\n`;
        const response = textResponse(body, 200, {
          "cache-control":
            `public, max-age=${CACHE_FRESH_SECONDS}, ` +
            `stale-while-revalidate=${CACHE_STALE_SECONDS}`,
        });

        return request.method === "HEAD" ? new Response(null, response) : response;
      } catch (error) {
        console.error(error);
        const status = error instanceof HttpError ? error.status : 502;
        const message = status === 404 ? error.message : "Git upstream request failed";
        return textResponse(`${message}\n`, status);
      }
    },
  };
}

export default createWorker();
