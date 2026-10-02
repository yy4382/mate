import { accessSync, constants, lstatSync } from "node:fs";
import { isAbsolute } from "node:path";

try {
  const uid = process.getuid(),
    gid = process.getgid();
  if (uid === 0 || gid === 0) throw new Error("Mate requires a nonzero owner UID and GID");
  const dataPath = process.env.MATE_CONTROL_PLANE_DATA_DIR;
  if (!dataPath || !isAbsolute(dataPath))
    throw new Error("MATE_CONTROL_PLANE_DATA_DIR must be an absolute path");
  const data = lstatSync(dataPath);
  if (!data.isDirectory() || data.uid !== uid || data.gid !== gid || (data.mode & 0o077) !== 0)
    throw new Error(
      "Control-plane data must be a private directory owned by the process UID/GID; prepare it as the host owner before starting Compose",
    );
  accessSync(dataPath, constants.R_OK | constants.W_OK | constants.X_OK);
  if (process.env.MATE_OWNER_PASSWORD_FILE) {
    const passwordPath = process.env.MATE_OWNER_PASSWORD_FILE;
    if (!isAbsolute(passwordPath))
      throw new Error("MATE_OWNER_PASSWORD_FILE must be an absolute path");
    const password = lstatSync(passwordPath);
    if (
      !password.isFile() ||
      password.uid !== uid ||
      password.gid !== gid ||
      (password.mode & 0o077) !== 0
    )
      throw new Error(
        `Initial password must be a private regular file owned by the process UID/GID (found ${password.uid}:${password.gid}, mode ${(password.mode & 0o777).toString(8)}; expected ${uid}:${gid})`,
      );
    accessSync(passwordPath, constants.R_OK);
  }
  await import("./dist/main.js").then(({ startControlPlane }) => startControlPlane());
} catch (error) {
  process.stderr.write(
    `Mate control-plane startup failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
