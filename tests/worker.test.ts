import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("worker route", () => {
  test("rejects a missing or wrong secret", async () => {
    expect((await worker(call({ id: ID }))).status).toBe(401);
    expect((await worker(call({ id: ID }, "Bearer nope"))).status).toBe(401);
    expect((await worker(call({ id: ID }, "worker-secret"))).status).toBe(401);
  });

  test("rejects everyone when no secret is configured", async () => {
    delete process.env.WORKER_SECRET;
    expect((await worker(call({ id: ID }, "Bearer undefined"))).status).toBe(401);
    expect((await worker(call({ id: ID }, "Bearer "))).status).toBe(401);
    expect((await worker(call({ id: ID }))).status).toBe(401);
  });

  test("with the right secret it logs the id and returns 200", async () => {
    const res = await worker(call({ id: ID }, "Bearer worker-secret"));
    expect(res.status).toBe(200);
    expect(console.log).toHaveBeenCalledWith("worker: received", { id: ID });
  });

  test("rejects a bad id or body with 400", async () => {
    const auth = "Bearer worker-secret";
    expect((await worker(call({ id: "not-a-uuid" }, auth))).status).toBe(400);
    expect((await worker(call({}, auth))).status).toBe(400);
    expect((await worker(call("not json", auth))).status).toBe(400);
  });
});
