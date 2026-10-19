// Fault injection for tests. A test cannot kill a process, so it throws SimulatedCrash from a hook and
// processEnquiry lets it through its catch untouched: nothing after the hook runs and nothing is saved, as in a real crash.
// Off by default and off in production by construction: productionDeps() never sets `faults`, and there is no
// environment variable or request that could. A test asserts it.
export class SimulatedCrash extends Error {
  constructor(where: string) {
    super(`simulated crash ${where}`);
    this.name = "SimulatedCrash";
  }
}

export type Faults = {
  // Runs right after Proposales has created the draft and before our row learns about it: the one window where
  // Proposales and our database disagree.
  afterCreate?: () => void | Promise<void>;
};
