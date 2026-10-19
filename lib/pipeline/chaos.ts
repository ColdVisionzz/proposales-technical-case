import { readChaos } from "../db/settings";
import { GatewayError } from "../proposales/errors";
import type { ProposalesGateway } from "../proposales/gateway";

// The chaos switch: when it is on, every Proposales call fails with a retryable error, so the retry, recovery and health
// paths can be shown live on the deployed system. It affects Proposales only, not the model.
// The switch lives in the settings table because the demo flips it live and function instances share no memory.
// If it cannot be read (a database blip) it counts as OFF: a blip must not fake an outage.
async function chaosIsOn(): Promise<boolean> {
  try {
    return await readChaos();
  } catch (err) {
    console.error("chaos: could not read the switch, treating it as off", { message: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

export function withChaos(gateway: ProposalesGateway, isOn: () => Promise<boolean> = chaosIsOn): ProposalesGateway {
  const guard = async () => {
    if (await isOn()) throw new GatewayError({ kind: "retryable", reason: "chaos" });
  };
  return {
    getCatalog: async () => {
      await guard();
      return gateway.getCatalog();
    },
    findExistingDraft: async (enquiryKey, recipientEmail) => {
      await guard();
      return gateway.findExistingDraft(enquiryKey, recipientEmail);
    },
    createDraft: async (input) => {
      await guard();
      return gateway.createDraft(input);
    },
  };
}
