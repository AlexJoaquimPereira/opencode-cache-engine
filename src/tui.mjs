const plugin = {
  id: "opencode-cache-engine",

  async tui() {
    // CacheEngine has no TUI UI of its own.
    // This target exists so the npm package can be registered,
    // displayed, and enabled/disabled by the OpenCode plugin manager.
  },
}

export default plugin
