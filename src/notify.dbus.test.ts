import { afterAll, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import isWsl from "is-wsl"

// WSL reports linux but delivers through WindowsToaster, which would pop real toasts.
const linuxDesktop = process.platform === "linux" && !isWsl

const directory = mkdtempSync(join(tmpdir(), "notifier-dbus-failure-"))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

test.skipIf(!linuxDesktop)("a broken D-Bus connection fails open with a plain popup", async () => {
  const log = join(directory, "notify-args")
  const executable = join(directory, "notify-send")
  writeFileSync(executable, `#!${process.execPath}\nimport { writeFileSync } from "fs"\nwriteFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)))\nconsole.log("1")\n`)
  chmodSync(executable, 0o755)
  const modulePath = join(import.meta.dir, "notify.ts")
  const child = Bun.spawn([process.execPath, "--eval", `
    const { sendNotification, disposeLinuxNotifications } = await import(${JSON.stringify(modulePath)})
    await sendNotification("fixture", "fallback", 1, undefined, "osascript", false, () => { throw Error("no click") })
    disposeLinuxNotifications()
    console.log("done")
  `], {
    env: { ...process.env, PATH: directory, DBUS_SESSION_BUS_ADDRESS: "unix:path=/does-not-exist/notifier-fixture" },
    stdout: "pipe", stderr: "pipe",
  })
  const output = await new Response(child.stdout).text()
  const error = await new Response(child.stderr).text()
  expect(await child.exited, error).toBe(0)
  expect(output.trim()).toBe("done")
  const args = JSON.parse(readFileSync(log, "utf8"))
  expect(args).toContain("fallback")
  expect(args).not.toContain("--action")
})


test.skipIf(!linuxDesktop)("a hung daemon is bounded and a disposed delivery cannot create a late popup", async () => {
  const log = join(directory, "hung-notify-args")
  const executable = join(directory, "notify-send")
  writeFileSync(executable, `#!${process.execPath}\nimport { appendFileSync } from "fs"\nappendFileSync(${JSON.stringify(log)}, "plain\\n")\nconsole.log("1")\n`)
  chmodSync(executable, 0o755)
  const fixture = join(import.meta.dir, "../test/fixtures/notification-daemon.ts")
  const modulePath = join(import.meta.dir, "notify.ts")
  const child = Bun.spawn(["dbus-run-session", "--", process.execPath, "--eval", `
    const daemon = await import(${JSON.stringify(fixture)})
    const channel = await import(${JSON.stringify(modulePath)})
    const start = Date.now()
    await channel.sendNotification("fixture", "hang", 1, undefined, "osascript", false, () => {})
    console.log(Date.now() - start < 3000)
    await Bun.sleep(1100)
    const sending = channel.sendNotification("fixture", "hang", 1, undefined, "osascript", false, () => {})
    await Bun.sleep(50)
    channel.disposeLinuxNotifications()
    await sending
    daemon.stopDaemon()
  `], {
    env: { ...process.env, PATH: directory + ":" + process.env.PATH }, stdout: "pipe", stderr: "pipe",
  })
  const output = await new Response(child.stdout).text()
  const error = await new Response(child.stderr).text()
  expect(await child.exited, error).toBe(0)
  expect(output.trim()).toBe("true")
  expect(readFileSync(log, "utf8")).toBe("plain\n")
}, 10000)

test.skipIf(!linuxDesktop)("a broken D-Bus connection with grouping still pops on notify-send older than 0.8", async () => {
  const log = join(directory, "old-notify-args")
  const executable = join(directory, "notify-send")
  // 0.7 has no --print-id or --replace-id and rejects unknown flags.
  writeFileSync(executable, `#!${process.execPath}\nimport { writeFileSync } from "fs"\nconst args = process.argv.slice(2)\nif (args[0] === "--version") { console.log("notify-send 0.7.9"); process.exit(0) }\nif (args.some(arg => arg === "--print-id" || arg === "--replace-id")) process.exit(1)\nwriteFileSync(${JSON.stringify(log)}, JSON.stringify(args))\n`)
  chmodSync(executable, 0o755)
  const modulePath = join(import.meta.dir, "notify.ts")
  const child = Bun.spawn([process.execPath, "--eval", `
    const { sendNotification, disposeLinuxNotifications } = await import(${JSON.stringify(modulePath)})
    await sendNotification("fixture", "old fallback", 1, undefined, "osascript", true, () => {})
    disposeLinuxNotifications()
  `], {
    env: { ...process.env, PATH: directory + ":" + process.env.PATH, DBUS_SESSION_BUS_ADDRESS: "unix:path=/does-not-exist/notifier-fixture" },
    stdout: "pipe", stderr: "pipe",
  })
  const error = await new Response(child.stderr).text()
  expect(await child.exited, error).toBe(0)
  expect(JSON.parse(readFileSync(log, "utf8"))).toContain("old fallback")
})

test.skipIf(!linuxDesktop)("node-notifier fallback passes --app-name so daemons show opencode", async () => {
  // With grouping off and no click handler, sendNotification falls through to
  // node-notifier's NotifySend, which only maps the kebab-case "app-name" key.
  const log = join(directory, "app-name-args")
  const executable = join(directory, "notify-send")
  writeFileSync(executable, `#!${process.execPath}\nimport { writeFileSync } from "fs"\nwriteFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)))\n`)
  chmodSync(executable, 0o755)
  const modulePath = join(import.meta.dir, "notify.ts")
  const child = Bun.spawn([process.execPath, "--eval", `
    const { sendNotification } = await import(${JSON.stringify(modulePath)})
    await sendNotification("OpenCode", "app-name test", 1, undefined, "osascript", false)
  `], {
    env: { ...process.env, PATH: directory + ":" + process.env.PATH, DBUS_SESSION_BUS_ADDRESS: "fixture" },
    stdout: "pipe", stderr: "pipe",
  })
  const error = await new Response(child.stderr).text()
  expect(await child.exited, error).toBe(0)
  const args: string[] = JSON.parse(readFileSync(log, "utf8"))
  expect(args[args.indexOf("--app-name") + 1]).toBe("opencode")
})
