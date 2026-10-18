import { fetchEmailBody } from "../email/body";
import { extract } from "../extraction/extract";
import { getGateway } from "./gateway";
import type { Deps } from "./process";

// The real dependencies, built per call so a missing key shows up as an error on that call, not at import time.
export function productionDeps(): Deps {
  return {
    fetchBody: fetchEmailBody,
    extract,
    gateway: getGateway(),
    companyId: Number(process.env.PROPOSALES_COMPANY_ID) || 1, // 1 is only ever used with the fake gateway
    today: () => new Date().toISOString().slice(0, 10),
  };
}
