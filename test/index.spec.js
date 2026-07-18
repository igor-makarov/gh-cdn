import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  createAllPodsIndex,
  createPodVersionsIndex,
  createWorker,
  HttpError,
  parseRoute,
} from "../src/index.js";

const TREE_MODE = "40000";

async function call(worker, path, init) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`https://gh-cdn.example${path}`, init),
    {},
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

function tree(name, sha) {
  return { mode: TREE_MODE, name, sha };
}

describe("parseRoute", () => {
  it("maps the API path to a fixed GitHub remote", () => {
    expect(parseRoute(new URL("https://example.com/CocoaPods/Specs/Specs/0/3/5/"))).toEqual({
      owner: "CocoaPods",
      repo: "Specs",
      path: ["Specs", "0", "3", "5"],
      trailingSlash: true,
      remoteUrl: "https://github.com/CocoaPods/Specs.git",
    });
  });

  it("accepts file paths without a trailing slash", () => {
    const route = parseRoute(new URL("https://example.com/owner/repo/file.json"));
    expect(route.path).toEqual(["file.json"]);
    expect(route.trailingSlash).toBe(false);
  });

  it("rejects traversal components", () => {
    expect(() => parseRoute(new URL("https://example.com/owner/repo/%2E%2E/")))
      .toThrow(HttpError);
  });
});

describe("CocoaPods indices", () => {
  const trees = new Map([
    ["root", [tree("Specs", "specs")]],
    ["specs", [tree("2", "two")]],
    ["two", [tree("2", "two-two")]],
    ["two-two", [tree("2", "shard")]],
    ["shard", [tree("ZuluPod", "zulu"), tree("AlphaPod", "alpha")]],
    ["zulu", [tree("2.0.0", "z2"), tree("1.0.0", "z1")]],
    ["alpha", [tree("0.2.0", "a2"), tree("0.1.0", "a1")]],
  ]);

  function repository() {
    return {
      rootTreeSha: "root",
      fetchTree: vi.fn(async sha => trees.get(sha) ?? []),
      fetchTrees: vi.fn(async shas => new Map(shas.map(sha => [sha, trees.get(sha) ?? []]))),
    };
  }

  it("builds a sorted all_pods.txt from four shard levels", async () => {
    await expect(createAllPodsIndex(repository())).resolves.toEqual([
      "AlphaPod",
      "ZuluPod",
    ]);
  });

  it("builds a sorted sharded pod/version index", async () => {
    await expect(createPodVersionsIndex(repository(), ["2", "2", "2"]))
      .resolves.toEqual([
        "AlphaPod/0.1.0/0.2.0",
        "ZuluPod/1.0.0/2.0.0",
      ]);
  });
});

describe("worker API", () => {
  it("returns newline-separated directory item names", async () => {
    const resolveRoute = vi.fn(async () => ({
      kind: "directory",
      names: ["Alpha", "Beta", "Gamma"],
    }));
    const response = await call(createWorker(resolveRoute), "/example/project/some/folder/");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=300, stale-while-revalidate=3600",
    );
    expect(await response.text()).toBe("Alpha\nBeta\nGamma\n");
    expect(resolveRoute).toHaveBeenCalledWith({
      owner: "example",
      repo: "project",
      path: ["some", "folder"],
      trailingSlash: true,
      remoteUrl: "https://github.com/example/project.git",
    });
  });

  it("redirects directory paths to their trailing-slash form", async () => {
    const resolveRoute = vi.fn(async () => ({ kind: "directory", names: [] }));
    const response = await call(createWorker(resolveRoute), "/owner/repo/folder");
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("https://gh-cdn.example/owner/repo/folder/");
  });

  it("serves and caches repository files", async () => {
    const resolveRoute = vi.fn(async () => ({
      kind: "file",
      body: new TextEncoder().encode('{"name":"Pod"}\n'),
      contentType: "application/json; charset=utf-8",
    }));
    const response = await call(
      createWorker(resolveRoute),
      "/CocoaPods/Specs/Specs/2/2/2/Pod/1.0.0/Pod.podspec.json",
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=300, stale-while-revalidate=3600",
    );
    expect(await response.text()).toBe('{"name":"Pod"}\n');
  });

  it("serves generated CocoaPods index responses", async () => {
    const resolveRoute = vi.fn(async () => ({
      kind: "index",
      lines: ["AlphaPod", "ZuluPod"],
    }));
    const response = await call(createWorker(resolveRoute), "/CocoaPods/Specs/all_pods.txt");

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("AlphaPod\nZuluPod\n");
  });

  it("rejects a trailing slash on files", async () => {
    const resolveRoute = vi.fn(async () => ({
      kind: "file",
      body: new Uint8Array(),
      contentType: "application/octet-stream",
    }));
    const response = await call(createWorker(resolveRoute), "/owner/repo/file.bin/");

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("File not found\n");
  });

  it("rejects unsupported methods", async () => {
    const response = await call(createWorker(vi.fn()), "/owner/repo/", {
      method: "POST",
    });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });

  it("maps missing paths to 404", async () => {
    const worker = createWorker(async () => {
      throw new HttpError(404, "Path not found");
    });
    const response = await call(worker, "/owner/repo/missing/");

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Path not found\n");
  });

  it("returns no body for HEAD", async () => {
    const worker = createWorker(async () => ({ kind: "directory", names: ["Alpha"] }));
    const response = await call(worker, "/owner/repo/head-test/", { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });
});
