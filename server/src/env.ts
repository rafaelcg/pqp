import { config } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Prefer repo root .env; also accept server/.env and client/.env for shared flags
config({ path: resolve(__dirname, "../../.env") });
config({ path: resolve(__dirname, "../.env") });
config({ path: resolve(__dirname, "../../client/.env") });
