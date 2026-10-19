import { handleCallback } from "@vercel/queue";
import { productionDeps } from "@/lib/pipeline/deps";
import { processEnquiry } from "@/lib/pipeline/process";
import { wake } from "@/lib/pipeline/wake";

// The private consumer of the delayed retry messages (trigger in vercel.json). It has no public URL: only Vercel's queue
// can call it, so there is no secret to check. Same limit as the worker, just under the 2 minute lease.
export const maxDuration = 110;

export const POST = handleCallback(async (message) => {
  await wake(message, (id) => processEnquiry(id, productionDeps()));
});
