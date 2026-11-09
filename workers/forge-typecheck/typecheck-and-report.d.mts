export function parseDiagnostics(output: string): string[];
export function summarize(status: number, output: string, toolchain: Record<string, string>): { conclusion: "success" | "failure"; errors: number; diagnostics: string[]; toolchain: Record<string, string> };
export function resolveCommit(envSha: unknown, gitHead: unknown): { commit: string; source: string } | null;
