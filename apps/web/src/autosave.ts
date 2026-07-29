export type AutosaveState = "saved" | "saving" | "unsaved" | "conflict";

export interface AutosaveOptions {
  readonly initialText: string;
  readonly save: (text: string) => Promise<void>;
  readonly isConflict: (error: unknown) => boolean;
  readonly onConflict: (error: unknown, localText: string) => Promise<void> | void;
  readonly onState: (state: AutosaveState) => void;
}

export class AutosaveCoordinator {
  readonly #options: AutosaveOptions;
  #savedText: string;
  #queuedText: string | null = null;
  #drain: Promise<void> | null = null;
  #conflicted = false;

  constructor(options: AutosaveOptions) {
    this.#options = options;
    this.#savedText = options.initialText;
  }

  get busy(): boolean {
    return this.#drain !== null;
  }

  get conflicted(): boolean {
    return this.#conflicted;
  }

  setSavedText(text: string): void {
    if (this.busy || this.#conflicted) return;
    this.#savedText = text;
    this.#options.onState("saved");
  }

  resolveConflict(serverText: string): void {
    this.#conflicted = false;
    this.#queuedText = null;
    this.#savedText = serverText;
    this.#options.onState("saved");
  }

  submit(text: string): Promise<void> {
    if (this.#conflicted || text === this.#savedText) return this.#drain ?? Promise.resolve();
    this.#queuedText = text;
    if (this.#drain) {
      this.#options.onState("unsaved");
      return this.#drain;
    }
    const drain = this.#run().finally(() => {
      if (this.#drain === drain) this.#drain = null;
    });
    this.#drain = drain;
    return drain;
  }

  async #run(): Promise<void> {
    while (this.#queuedText !== null && !this.#conflicted) {
      const text = this.#queuedText;
      this.#queuedText = null;
      this.#options.onState("saving");
      try {
        await this.#options.save(text);
        this.#savedText = text;
        this.#options.onState(this.#queuedText === null ? "saved" : "unsaved");
      } catch (error) {
        if (this.#options.isConflict(error)) {
          this.#conflicted = true;
          const latestLocalText = this.#queuedText ?? text;
          this.#queuedText = null;
          this.#options.onState("conflict");
          await this.#options.onConflict(error, latestLocalText);
        } else {
          this.#options.onState("unsaved");
        }
        return;
      }
    }
  }
}
