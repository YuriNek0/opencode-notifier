import { afterAll, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

const directory = mkdtempSync(join(tmpdir(), "notifier-kde-test-"))
const activePath = join(directory, "active")
const callsPath = join(directory, "calls")
const windowID = "{47b505c0-e34e-4b21-a243-0ae74fe9a10e}"
const otherID = "{6a2e1acf-895f-476b-9cbe-974698a67235}"
const modulePath = join(import.meta.dir, "focus.ts")
afterAll(() => rmSync(directory, { recursive: true, force: true }))

writeFileSync(join(directory, "kdotool"), `#!${process.execPath}
import { appendFileSync, readFileSync } from "fs"
const args = process.argv.slice(2)
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + "\\n")
if (args[0] === "getactivewindow") console.log(readFileSync(${JSON.stringify(activePath)}, "utf8"))
if (args[0] === "getwindowname") console.log("Obsidian — vault")
`)
chmodSync(join(directory, "kdotool"), 0o755)

async function run(script: string, pinned?: string) {
  writeFileSync(callsPath, "")
  writeFileSync(activePath, windowID)
  const child = Bun.spawn([process.execPath, "--eval", script], {
    env: {
      ...process.env, PATH: directory, WAYLAND_DISPLAY: "fixture", KDE_SESSION_VERSION: "6",
      HYPRLAND_INSTANCE_SIGNATURE: undefined, SWAYSOCK: undefined, NIRI_SOCKET: undefined,
      TMUX: undefined, WEZTERM_PANE: undefined, ZELLIJ_SESSION_NAME: undefined, ZELLIJ_PANE_ID: undefined,
      TERM_PROGRAM: undefined, OPENCODE_NOTIFIER_WINDOW_ID: pinned,
      DBUS_SESSION_BUS_ADDRESS: "fixture",
    }, stdout: "pipe", stderr: "pipe",
  })
  const output = await new Response(child.stdout).text()
  const error = await new Response(child.stderr).text()
  expect(await child.exited, error).toBe(0)
  return { output: output.trim(), calls: readFileSync(callsPath, "utf8").trim().split("\n").map(line => JSON.parse(line)) }
}

test.skipIf(process.platform !== "linux")("KDE UUID identifies an embedded terminal without TERM_PROGRAM or process ancestry", async () => {
  const result = await run(`
    import { writeFileSync } from "fs"
    const focus = await import(${JSON.stringify(modulePath)})
    focus.captureStartupWindowId()
    console.log(process.env.OPENCODE_NOTIFIER_WINDOW_ID)
    console.log(focus.isTerminalFocused(), focus.getCachedWindowTitle())
    writeFileSync(${JSON.stringify(activePath)}, ${JSON.stringify(otherID)})
    console.log(focus.isTerminalFocused())
    await focus.focusTerminal()
  `)
  expect(result.output).toBe(`${windowID}\ntrue Obsidian — vault\nfalse`)
  expect(result.calls).toContainEqual(["getwindowname", windowID])
  expect(result.calls).toContainEqual(["windowactivate", windowID])
})

test.skipIf(process.platform !== "linux")("an explicit embedded host window is used for suppression and activation", async () => {
  const result = await run(`
    import { writeFileSync } from "fs"
    const focus = await import(${JSON.stringify(modulePath)})
    focus.captureStartupWindowId()
    console.log(focus.isTerminalFocused())
    writeFileSync(${JSON.stringify(activePath)}, ${JSON.stringify(otherID)})
    console.log(focus.isTerminalFocused(), focus.getCachedWindowTitle())
    await focus.focusTerminal()
  `, otherID)
  expect(result.output).toBe("false\ntrue Obsidian — vault")
  expect(result.calls).toContainEqual(["getwindowname", otherID])
  expect(result.calls).toContainEqual(["windowactivate", otherID])
})

test("KDE IDs retain numeric compatibility and reject malformed or executable values", async () => {
  const { isKDEWindowId } = await import("./focus")
  for (const value of [windowID, windowID.toUpperCase(), "12345"]) expect(isKDEWindowId(value)).toBe(true)
  for (const value of ["", "-1", "--help", "{bad-id}", `${windowID}; touch /tmp/marker`, "$(id)", "123 456"]) {
    expect(isKDEWindowId(value)).toBe(false)
  }
})
