// CI-WB (2026-11-25): the node:test reporter of the Workers Builds test run (typecheck-and-report.mjs runTests). It writes
// one JSON line per finished test: its kind, file, name and outcome. Never a message, a stack or any output of the test,
// so nothing a test prints or throws reaches the report.
export default async function* forgeTestReporter(source) {
  for await (const event of source) {
    if (event.type !== "test:pass" && event.type !== "test:fail") continue;
    const d = event.data ?? {};
    yield JSON.stringify({
      event: event.type === "test:fail" ? "fail" : "pass",
      kind: d.details?.type === "suite" ? "suite" : "test",
      file: typeof d.file === "string" ? d.file : null,
      name: typeof d.name === "string" ? d.name : String(d.name ?? ""),
      nesting: Number.isInteger(d.nesting) ? d.nesting : 0,
      skip: d.skip !== undefined && d.skip !== false,
      todo: d.todo !== undefined && d.todo !== false,
    }) + "\n";
  }
}
