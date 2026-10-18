import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// after() only works inside a real request: here it collects the callbacks so a test can run them by hand.
const afterCallbacks = vi.hoisted(() => [] as Array<() => unknown>);
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (fn: () => unknown) => void afterCallbacks.push(fn),
}));
const runAfter = () => Promise.all(afterCallbacks.splice(0).map((fn) => fn()));

const processEnquiry = vi.hoisted(() => vi.fn());
vi.mock("../lib/pipeline/process", () => ({ processEnquiry }));
vi.mock("../lib/pipeline/deps", () => ({ productionDeps: () => ({ marker: "deps" }) }));

import { POST as worker } from "../app/api/worker/route";

const ID = "0b9f4c2e-6d1a-4f4e-9a52-3c1d2e7a8b90";

const call = (body: unknown, authorization?: string) =>
  new Request("http://test/api/worker", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: authorization ? { authorization } : {},
  });

beforeEach(() => {
  process.env.WORKER_SECRET = "worker-secret";
  afterCallbacks.length = 0;
  processEnquiry.mockReset().mockResolvedValue("draft_created");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("worker route", () => {
  test("rejects a missing or wrong secret, and runs nothing", async () => {
    expect((await worker(call({ id: ID }))).status).toBe(401);
    expect((await worker(call({ id: ID }, "Bearer nope"))).status).toBe(401);
    expect((await worker(call({ id: ID }, "worker-secret"))).status).toBe(401);
    await runAfter();
    expect(processEnquiry).not.toHaveBeenCalled();
  });

  test("rejects everyone when no secret is configured", async () => {
    delete process.env.WORKER_SECRET;
    expect((await worker(call({ id: ID }, "Bearer undefined"))).status).toBe(401);
    expect((await worker(call({ id: ID }, "Bearer "))).status).toBe(401);
    expect((await worker(call({ id: ID }))).status).toBe(401);
  });

  test("with the right secret it answers 202 first and processes the enquiry only after the response", async () => {
    const res = await worker(call({ id: ID }, "Bearer worker-secret"));
    expect(res.status).toBe(202);
    expect(processEnquiry).not.toHaveBeenCalled(); // the work waits in after()
    await runAfter();
    expect(processEnquiry).toHaveBeenCalledWith(ID, { marker: "deps" });
  });

  test("a failure inside the job is logged, never thrown", async () => {
    processEnquiry.mockRejectedValue(new Error("database is down"));
    await worker(call({ id: ID }, "Bearer worker-secret"));
    await expect(runAfter()).resolves.toBeDefined();
    expect(console.error).toHaveBeenCalledWith("worker: failed", { id: ID, message: "database is down" });
  });

  test("rejects a bad id or body with 400", async () => {
    const auth = "Bearer worker-secret";
    expect((await worker(call({ id: "not-a-uuid" }, auth))).status).toBe(400);
    expect((await worker(call({}, auth))).status).toBe(400);
    expect((await worker(call("not json", auth))).status).toBe(400);
    await runAfter();
    expect(processEnquiry).not.toHaveBeenCalled();
  });
});
