import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { createWorker, HttpError, parseRoute } from "../src/index.js";

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

describe("parseRoute", () => {
  it("maps the API path to a fixed GitHub remote", () => {
    expect(parseRoute(new URL("https://example.com/CocoaPods/Specs/Specs/0/3/5/"))).toEqual({
      owner: "CocoaPods",
      repo: "Specs",
      path: ["Specs", "0", "3", "5"],
      remoteUrl: "https://github.com/CocoaPods/Specs.git",
    });
  });

  it("rejects traversal components", () => {
    expect(() => parseRoute(new URL("https://example.com/owner/repo/%2E%2E/")))
      .toThrow(HttpError);
  });
});

describe("worker API", () => {
  it("returns newline-separated item names", async () => {
    const listDirectory = vi.fn(async () => ["Alpha", "Beta", "Gamma"]);
    const worker = createWorker(listDirectory);
    const response = await call(worker, "/example/project/some/folder/");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=300, stale-while-revalidate=3600",
    );
    expect(await response.text()).toBe("Alpha\nBeta\nGamma\n");
    expect(listDirectory).toHaveBeenCalledWith({
      owner: "example",
      repo: "project",
      path: ["some", "folder"],
      remoteUrl: "https://github.com/example/project.git",
    });
  });

  it("redirects folder paths to their trailing-slash form", async () => {
    const response = await call(createWorker(vi.fn()), "/owner/repo/folder");
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("https://gh-cdn.example/owner/repo/folder/");
  });

  it("rejects unsupported methods", async () => {
    const response = await call(createWorker(vi.fn()), "/owner/repo/", {
      method: "POST",
    });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });

  it("maps missing directories to 404", async () => {
    const worker = createWorker(async () => {
      throw new HttpError(404, "Directory not found");
    });
    const response = await call(worker, "/owner/repo/missing/");

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Directory not found\n");
  });

  it("returns no body for HEAD", async () => {
    const response = await call(createWorker(async () => ["Alpha"]), "/owner/repo/head-test/", {
      method: "HEAD",
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });
});
