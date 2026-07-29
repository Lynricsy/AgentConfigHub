import { describe, expect, it, vi } from "vitest";

import { AutosaveCoordinator, type AutosaveState } from "./autosave.js";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("AutosaveCoordinator", () => {
  it("transitions a changed value through saving to saved", async () => {
    const request = deferred();
    const states: AutosaveState[] = [];
    const save = vi.fn(() => request.promise);
    const coordinator = new AutosaveCoordinator({
      initialText: "old",
      save,
      isConflict: () => false,
      onConflict: () => {},
      onState: (state) => states.push(state),
    });
    const completion = coordinator.submit("new");
    expect(save).toHaveBeenCalledWith("new");
    expect(states).toEqual(["saving"]);
    request.resolve();
    await completion;
    expect(states).toEqual(["saving", "saved"]);
  });

  it("drains the latest input submitted while a request is in flight", async () => {
    const requests = [deferred(), deferred()];
    const calls: string[] = [];
    const coordinator = new AutosaveCoordinator({
      initialText: "old",
      save: (text) => {
        calls.push(text);
        return requests[calls.length - 1]!.promise;
      },
      isConflict: () => false,
      onConflict: () => {},
      onState: () => {},
    });
    const completion = coordinator.submit("first");
    coordinator.submit("latest");
    expect(calls).toEqual(["first"]);
    requests[0]!.resolve();
    await Promise.resolve();
    expect(calls).toEqual(["first", "latest"]);
    requests[1]!.resolve();
    await completion;
  });

  it("clears queued input on conflict until the user resolves it", async () => {
    const first = deferred();
    const resumed = deferred();
    const calls: string[] = [];
    const conflict = new Error("conflict");
    const onConflict = vi.fn();
    const coordinator = new AutosaveCoordinator({
      initialText: "old",
      save: (text) => {
        calls.push(text);
        return calls.length === 1 ? first.promise : resumed.promise;
      },
      isConflict: (error) => error === conflict,
      onConflict,
      onState: () => {},
    });
    const completion = coordinator.submit("first");
    coordinator.submit("must-not-drain");
    first.reject(conflict);
    await completion;
    expect(calls).toEqual(["first"]);
    expect(onConflict).toHaveBeenCalledWith(conflict, "must-not-drain");
    await coordinator.submit("also-blocked");
    expect(calls).toEqual(["first"]);
    coordinator.resolveConflict("server");
    const resumedCompletion = coordinator.submit("explicitly-resumed");
    expect(calls).toEqual(["first", "explicitly-resumed"]);
    resumed.resolve();
    await resumedCompletion;
  });
});
