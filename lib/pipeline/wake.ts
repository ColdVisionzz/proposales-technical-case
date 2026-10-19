const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// What the queue consumer does with a delayed message: run the pipeline for that enquiry. The route supplies `run`.
// A message that does not carry a uuid is dropped quietly: redelivering it cannot fix it, and it would only cost
// function time. A thrown error from `run` is NOT caught: it means the database itself failed, which is transient, so the
// queue redelivers (the trigger caps deliveries). Duplicate and stale messages are harmless: the claim decides.
export async function wake(message: unknown, run: (id: string) => Promise<unknown>): Promise<void> {
  const id = typeof message === "object" && message !== null ? (message as { id?: unknown }).id : undefined;
  if (typeof id !== "string" || !UUID.test(id)) {
    console.error("retry consumer: dropped a message without a valid id");
    return;
  }
  const result = await run(id);
  console.log("retry consumer: done", { id, result });
}
