// Names and paths that `chromex setup` writes and the MCP server reads. Browser-safe: no Node APIs.

/** Folder under the config home that holds the bridge config. */
export const CONFIG_DIRECTORY = "chromex"
export const CONFIG_FILE = "config.json"
/** Setup snapshot of the graphical session, next to the installed server. */
export const MANAGED_ENVIRONMENT_FILE = "managed-environment.json"
export const MANAGED_ENVIRONMENT_KEYS = [
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
] as const

/** The XDG config home: `XDG_CONFIG_HOME`, else `<home>/.config`. Callers join further segments. */
export function configHome(env: Readonly<Record<string, string | undefined>>, home: string): string {
  return env.XDG_CONFIG_HOME || `${home}/.config`
}

/** True when the environment names an X11 or Wayland display. */
export function hasDisplayEnv(env: Readonly<Record<string, string | undefined>>): boolean {
  return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY)
}
