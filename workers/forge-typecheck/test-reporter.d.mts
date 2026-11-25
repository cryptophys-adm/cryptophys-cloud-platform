export default function forgeTestReporter(source: AsyncIterable<{ type: string; data?: Record<string, unknown> }>): AsyncGenerator<string>;
