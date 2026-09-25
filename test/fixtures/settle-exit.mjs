// Child process for the exit test: one write, one settle, then nothing.
// Node must exit on its own as soon as the handlers are done.
import { fakeCtx, fakePi } from "./harness.mjs";

const repo = process.argv[2];
const { default: extension } = await import("../../extensions/graft.ts");
const pi = fakePi();
extension(pi);
const ctx = fakeCtx(repo);
await pi.fire("tool_result", { toolName: "write", input: { path: "src/a.ts" }, content: [] }, ctx);
await pi.fire("agent_settled", {}, ctx);
console.log("handlers done");
