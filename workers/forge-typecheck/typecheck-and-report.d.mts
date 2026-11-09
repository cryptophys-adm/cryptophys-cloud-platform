export function parseDiagnostics(output: string): string[];
export function summarize(status: number, output: string, toolchain: Record<string, string>): { conclusion: "success" | "failure"; errors: number; diagnostics: string[]; toolchain: Record<string, string> };
export function resolveCommit(envSha: unknown, gitHead: unknown): { commit: string; source: string } | null;
export function cleanCredential(value: unknown, headerName: string): string;
export function postReport(fetchImpl: (input: URL, init: RequestInit) => Promise<Response>, forgeUrl: string, clientId: string, clientSecret: string, body: { commit: string } & Record<string, unknown>): Promise<{ commit: string; conclusion: string; applied_to_run: boolean }>;
export function summarizeConsoleBuild(status: number, output: string, bytes?: number): { conclusion: "success" | "failure"; errors: number; diagnostics: string[]; bytes?: number };
