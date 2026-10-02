import dbus from "dbus-native";
import { z } from "zod";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const propertyName = z.enum(["Version", "ExecStartEx"]);
const execStartProperty = z.object({
  signature: z.literal("a(sasasttttuii)"),
  value: z.array(
    z.tuple([
      z.string(),
      z.array(z.string()),
      z.array(z.string()),
      z.bigint(),
      z.bigint(),
      z.bigint(),
      z.bigint(),
      z.number().int().nonnegative(),
      z.number().int(),
      z.number().int(),
    ]),
  ),
});

/** Validate the library's decoded wire value before dropping unused execution timestamps. */
export function readExecStartProperty(property: unknown) {
  const parsed = execStartProperty.safeParse(property);
  if (!parsed.success)
    throw new Error("User manager returned unrecognized effective command facts");
  return parsed.data.value.map(([path, argv, flags]) => ({ path, argv, flags }));
}

/** Short-lived peer connection to the existing user manager, with no bus daemon or Hello. */
export async function readPrivateProperty(property: z.infer<typeof propertyName>, socket: string) {
  if (!isAbsolute(socket)) throw new Error("User manager socket must be absolute");
  const bus = dbus.createClient({
    socket,
    direct: true,
    authMethods: ["EXTERNAL"],
    variants: "wrap",
    timeout: 5000,
    maxMessageSize: 1024 * 1024,
  });
  // Transport failures also reject pending calls. Handle the event without exposing reply data.
  bus.connection.on("error", () => {});
  try {
    const manager = property === "Version";
    const reply = await bus.invoke<unknown>({
      destination: "org.freedesktop.systemd1",
      path: manager
        ? "/org/freedesktop/systemd1"
        : "/org/freedesktop/systemd1/unit/mate_2dnode_2eservice",
      interface: "org.freedesktop.DBus.Properties",
      member: "Get",
      signature: "ss",
      body: [`org.freedesktop.systemd1.${manager ? "Manager" : "Service"}`, property],
    });
    return manager
      ? z.object({ signature: z.literal("s"), value: z.string().min(1) }).parse(reply).value
      : readExecStartProperty(reply);
  } finally {
    await bus.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const property = propertyName.parse(process.argv[2]);
    const runtime = process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.()}`;
    process.stdout.write(
      `${JSON.stringify(await readPrivateProperty(property, join(runtime, "systemd/private")))}\n`,
    );
  } catch {
    process.stderr.write("Could not inspect the existing user manager's typed property\n");
    process.exitCode = 1;
  }
}
