// Side-effect import: MUST be the first import in every server test file so
// that DB_PATH is set to a throwaway location BEFORE server/storage.ts is
// evaluated (its module top-level opens the database and runs bootstrap).
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

process.env.DB_PATH = path.join(os.tmpdir(), `mcq-site-test-${randomUUID()}.db`);
process.env.NODE_ENV = "test";
