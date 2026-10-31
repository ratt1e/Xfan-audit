import fs from "fs";
import path from "path";
import {createRequire} from "module";
import {fileURLToPath} from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
require(path.join(root, "engine/fan_audit_engine.js"));
const FanAudit = globalThis.FanAudit;

const spec = JSON.parse(fs.readFileSync(0, "utf8"));
const out = FanAudit.reciprocity(spec.rows || [], spec.config || null);
process.stdout.write(JSON.stringify(out));
