import { writeFile } from "node:fs/promises";
import { CONTROL_PLANE_VNEXT_JS } from "../../worker/control-plane-vnext-source.mjs";
await writeFile("worker/live-recovered/control-plane-vnext.js", CONTROL_PLANE_VNEXT_JS, "utf8");
await writeFile("public/control-plane-vnext.js", CONTROL_PLANE_VNEXT_JS, "utf8");
