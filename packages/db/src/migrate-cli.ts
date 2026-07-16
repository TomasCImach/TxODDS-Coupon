import { migrate } from "./migrate.js";
import { createPool } from "./pool.js";

const pool = createPool();
try {
  const applied = await migrate(pool);
  process.stdout.write(
    applied.length === 0
      ? "Database already current.\n"
      : `Applied: ${applied.join(", ")}\n`,
  );
} finally {
  await pool.end();
}
