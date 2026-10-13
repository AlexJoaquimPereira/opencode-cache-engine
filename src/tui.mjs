const plugin = {
  id: "opencode-cache-engine",

  // OpenCode V2 (verified on 2.0.26) validates a package TUI entry as
  // `{ id: string, setup: function }` and rejects anything else with
  // "Invalid V2 TUI plugin module". CacheEngine's TUI target has no UI of its
  // own, so this is an asynchronous no-op that satisfies that contract while
  // keeping the `tui()` hook below for V1 dual-runtime loading.
  async setup() {
    // No TUI UI to install; present only to satisfy the V2 module contract.
  },

  async tui() {
    // CacheEngine has no TUI UI of its own.
    // This target exists so the npm package can be registered,
    // displayed, and enabled/disabled by the OpenCode plugin manager.
  },
}

export default plugin
