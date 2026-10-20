import { fetchEmailBody } from "../email/body";
import { extract } from "../extraction/extract";
import { schedule } from "../queue";
import { withChaos } from "./chaos";
import { getGateway } from "./proposales";
import type { Deps } from "./process";

// The real dependencies, built per call so a missing key shows up as an error on that call, not at import time.
export function productionDeps(): Deps {
  // With the real API a wrong company id would put drafts into the wrong account, so it must be set and valid.
  const companyId = Number(process.env.PROPOSALES_COMPANY_ID);
  if (process.env.PROPOSALES_API_KEY && !(Number.isInteger(companyId) && companyId > 0)) {
    throw new Error("PROPOSALES_API_KEY is set but PROPOSALES_COMPANY_ID is missing or not a positive integer");
  }
  return {
    fetchBody: fetchEmailBody,
    extract,
    gateway: withChaos(getGateway()), // the demo switch can make every Proposales call fail (lib/pipeline/chaos.ts)
    companyId: companyId || 1, // 1 is only ever used with the fake gateway
    today: () => new Date().toISOString().slice(0, 10),
    schedule,
  };
}
