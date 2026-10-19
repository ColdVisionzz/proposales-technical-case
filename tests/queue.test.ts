import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const send = vi.hoisted(() => vi.fn<(topic: string, payload: unknown, options?: { delaySeconds?: number }) => Promise<unknown>>());
vi.mock("@vercel/queue", () => ({ send }));

import { RETRY_TOPIC, schedule } from "../lib/queue";
import { wake } from "../lib/pipeline/wake";

const ID = "0b9f4c2e-6d1a-4f4e-9a52-3c1d2e7a8b90";

beforeEach(() => {
  send.mockReset().mockResolvedValue({ messageId: "m1" });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("schedule", () => {
  test("sends the id to the retry topic with the delay rounded up to whole seconds", async () => {
    await schedule(ID, 31.2);
    expect(send).toHaveBeenCalledWith(RETRY_TOPIC, { id: ID }, { delaySeconds: 32 });
  });

  test("a send that fails is logged and never thrown: the row is already parked and the sweeper recovers it", async () => {
    send.mockRejectedValue(new Error("queue unavailable"));
    await expect(schedule(ID, 30)).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith("schedule: failed", { id: ID, message: "queue unavailable" });
  });
});

describe("wake (the queue consumer's handler)", () => {
  test("runs the pipeline for the enquiry in the message", async () => {
    const run = vi.fn(async () => "draft_created");
    await wake({ id: ID }, run);
    expect(run).toHaveBeenCalledWith(ID);
  });

  test.each([[null], [undefined], ["text"], [{}], [{ id: 5 }], [{ id: "not-a-uuid" }]])(
    "a message without a valid id (%j) is dropped quietly, so it is not redelivered",
    async (message) => {
      const run = vi.fn(async () => "x");
      await expect(wake(message, run)).resolves.toBeUndefined();
      expect(run).not.toHaveBeenCalled();
    },
  );

  test("a failure of the pipeline itself is not swallowed: the queue redelivers", async () => {
    await expect(wake({ id: ID }, async () => { throw new Error("database down"); })).rejects.toThrow("database down");
  });
});
