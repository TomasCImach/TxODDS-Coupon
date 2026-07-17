import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

const path = fileURLToPath(new URL("../.env", import.meta.url));
try {
  loadEnvFile(path);
} catch (error) {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  ) {
    throw new Error(
      "Missing repository-root .env. Copy .env.example to .env and fill the required Devnet values.",
      { cause: error },
    );
  }
  throw error;
}
