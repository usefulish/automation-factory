/**
 * Tests for the `@usefulish/mintlify-summary` report.
 *
 * The report's job is to be readable when something went wrong, so most of
 * these cover the failure paths: a method that threw, artefacts that have to be
 * recovered from stored data, and malformed input.
 *
 * @module
 */

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { report } from "./mintlify_docs.ts";

interface StoredEntry {
  name: string;
  version?: number;
  createdAt?: string;
  tags?: Record<string, string>;
  content: unknown;
}

/** Build a report context over a set of stored data entries. */
function testContext(opts: {
  methodName?: string;
  executionStatus?: string;
  errorMessage?: string;
  /** Entries the method reported as its own output. */
  handles?: Array<{ name: string; specName?: string; version?: number }>;
  stored?: StoredEntry[];
  findAllThrows?: boolean;
}) {
  const stored = opts.stored ?? [];
  return {
    modelType: "@usefulish/mintlify",
    modelId: "model-1",
    methodName: opts.methodName ?? "validate",
    executionStatus: opts.executionStatus ?? "succeeded",
    errorMessage: opts.errorMessage,
    definition: { name: "mintlify-docs" },
    dataHandles: opts.handles ?? [],
    dataRepository: {
      getContent: (
        _type: string,
        _id: string,
        dataName: string,
      ): Promise<Uint8Array | null> => {
        const entry = stored.find((e) => e.name === dataName);
        if (entry === undefined) return Promise.resolve(null);
        const body = typeof entry.content === "string"
          ? entry.content
          : JSON.stringify(entry.content);
        return Promise.resolve(new TextEncoder().encode(body));
      },
      findAllForModel: () => {
        if (opts.findAllThrows === true) {
          return Promise.reject(new Error("datastore unavailable"));
        }
        return Promise.resolve(stored);
      },
    },
  };
}

const FAILING_VALIDATION = {
  name: "validation-acme-widget",
  version: 3,
  createdAt: "2026-09-20T00:00:00.000Z",
  tags: { specName: "validation" },
  content: {
    slug: "acme-widget",
    repo: "acme/widget",
    ok: false,
    errorCount: 2,
    warningCount: 1,
    pageCount: 12,
    configPath: "docs/docs.json",
    schemaOrigin: "remote",
    schemaNote: null,
    issues: [
      {
        severity: "error",
        kind: "broken-link",
        file: "docs/index.mdx",
        message: 'Link "/nope" does not resolve to a page in this docs set.',
      },
      {
        severity: "error",
        kind: "placeholder",
        file: "docs/quickstart.mdx",
        message: 'Contains unfinished placeholder text ("TODO").',
      },
      {
        severity: "warning",
        kind: "orphan-page",
        file: "docs/stray.mdx",
        message: '"stray" is not reachable from navigation.',
      },
    ],
    checkedAt: "2026-09-20T00:00:00.000Z",
  },
};

Deno.test("the report declares its name, scope, and labels", () => {
  assertEquals(report.name, "@usefulish/mintlify-summary");
  assertEquals(report.scope, "method");
  assertEquals(report.labels.includes("docs"), true);
});

Deno.test("validation findings render as a table with both markdown and json", async () => {
  const result = await report.execute(testContext({
    handles: [{
      name: "validation-acme-widget",
      specName: "validation",
      version: 3,
    }],
    stored: [FAILING_VALIDATION],
  }));

  assertStringIncludes(result.markdown, "**FAIL**");
  assertStringIncludes(result.markdown, "2 error(s), 1 warning(s)");
  assertStringIncludes(result.markdown, "| `broken-link` |");
  assertStringIncludes(result.markdown, "| `placeholder` |");
  // Warnings are listed, but not in the errors table.
  assertStringIncludes(result.markdown, "### Warnings");
  assertEquals(
    (result.json.validation as Record<string, unknown>).ok,
    false,
  );
});

Deno.test("a failed method still reports its findings from stored data", async () => {
  // A method that throws returns no data handles even when it already wrote
  // its findings — which is exactly what the validation gate does.
  const result = await report.execute(testContext({
    executionStatus: "failed",
    errorMessage: "Documentation validation failed with 2 error(s)",
    handles: [],
    stored: [FAILING_VALIDATION],
  }));

  assertStringIncludes(result.markdown, "**Status**: failed");
  assertStringIncludes(result.markdown, "Documentation validation failed");
  assertStringIncludes(result.markdown, "**FAIL**");
  assertStringIncludes(result.markdown, "broken-link");
});

Deno.test("the newest instance of each spec wins when several are stored", async () => {
  const older = {
    ...FAILING_VALIDATION,
    name: "validation-old",
    createdAt: "2026-09-01T00:00:00.000Z",
    content: { ...FAILING_VALIDATION.content, errorCount: 99, pageCount: 1 },
  };
  const result = await report.execute(testContext({
    handles: [],
    stored: [older, FAILING_VALIDATION],
  }));

  assertStringIncludes(result.markdown, "2 error(s)");
  assertEquals(result.markdown.includes("99 error(s)"), false);
});

Deno.test("an authoring run renders cost, duration, and files written", async () => {
  const result = await report.execute(testContext({
    methodName: "author",
    handles: [{ name: "author-acme-widget", specName: "authorRun" }],
    stored: [{
      name: "author-acme-widget",
      tags: { specName: "authorRun" },
      content: {
        exitCode: 0,
        timedOut: false,
        durationMs: 92_000,
        model: "claude-opus-5",
        numTurns: 7,
        costUsd: 1.2345,
        permissionDenials: 0,
        filesChanged: 2,
        changedFiles: [
          { path: "docs/index.mdx", change: "added", bytes: 900 },
          { path: "docs/quickstart.mdx", change: "modified", bytes: 500 },
        ],
        summary: "Wrote the overview and quickstart.",
      },
    }],
  }));

  assertStringIncludes(result.markdown, "## Authoring run");
  assertStringIncludes(result.markdown, "1m 32s");
  assertStringIncludes(result.markdown, "$1.2345");
  assertStringIncludes(result.markdown, "| `docs/index.mdx` | added | 900 |");
  assertStringIncludes(result.markdown, "> Wrote the overview and quickstart.");
});

Deno.test("a timed-out run with unknown cost still renders", async () => {
  const result = await report.execute(testContext({
    methodName: "author",
    handles: [{ name: "a", specName: "authorRun" }],
    stored: [{
      name: "a",
      tags: { specName: "authorRun" },
      content: {
        exitCode: 124,
        timedOut: true,
        durationMs: 500,
        model: null,
        numTurns: null,
        costUsd: null,
        permissionDenials: 3,
        filesChanged: 0,
        changedFiles: [],
        summary: "",
      },
    }],
  }));

  assertStringIncludes(result.markdown, "(timed out)");
  assertStringIncludes(result.markdown, "Cost: unknown");
  assertStringIncludes(result.markdown, "Model: cli default");
  assertStringIncludes(result.markdown, "Permission denials: 3");
  assertStringIncludes(result.markdown, "500ms");
});

Deno.test("navigation renders groups, adopted pages, and planned gaps", async () => {
  const result = await report.execute(testContext({
    methodName: "ensureConfig",
    handles: [{ name: "c", specName: "docsConfig" }],
    stored: [{
      name: "c",
      tags: { specName: "docsConfig" },
      content: {
        configPath: "docs/docs.json",
        created: false,
        changed: true,
        pageCount: 3,
        groupCount: 2,
        orphansAdopted: ["guides/extra"],
        plannedMissing: ["reference/cli"],
        navigation: [
          { group: "Getting Started", pages: ["index", "quickstart"] },
          { group: "Guides", pages: ["guides/extra"] },
        ],
      },
    }],
  }));

  assertStringIncludes(result.markdown, "— updated, 3 page(s) in 2 group(s)");
  assertStringIncludes(result.markdown, "- **Getting Started**");
  assertStringIncludes(result.markdown, "  - `index`");
  assertStringIncludes(result.markdown, "Planned but never written");
  assertStringIncludes(result.markdown, "`reference/cli`");
  assertStringIncludes(result.markdown, "Unplanned pages adopted");
});

Deno.test("an execution that produced nothing says so rather than rendering blank", async () => {
  const result = await report.execute(testContext({ handles: [], stored: [] }));
  assertStringIncludes(result.markdown, "No documentation artefacts");
  assertEquals(result.json.method, "validate");
});

Deno.test("malformed stored content is skipped, not fatal", async () => {
  const result = await report.execute(testContext({
    handles: [{ name: "broken", specName: "validation" }],
    stored: [{
      name: "broken",
      tags: { specName: "validation" },
      content: "{not json",
    }],
  }));
  assertStringIncludes(result.markdown, "No documentation artefacts");
});

Deno.test("a datastore failure during fallback degrades gracefully", async () => {
  const result = await report.execute(testContext({
    executionStatus: "failed",
    errorMessage: "something broke",
    handles: [],
    stored: [FAILING_VALIDATION],
    findAllThrows: true,
  }));

  // The error is still surfaced even though no artefact could be recovered.
  assertStringIncludes(result.markdown, "something broke");
  assertStringIncludes(result.markdown, "No documentation artefacts");
});

Deno.test("a table cell containing a pipe does not break the markdown table", async () => {
  const result = await report.execute(testContext({
    handles: [{ name: "v", specName: "validation" }],
    stored: [{
      name: "v",
      tags: { specName: "validation" },
      content: {
        ...FAILING_VALIDATION.content,
        issues: [{
          severity: "error",
          kind: "schema",
          file: "docs/docs.json",
          message: "value must match a | b\nsecond line",
        }],
      },
    }],
  }));

  assertStringIncludes(result.markdown, "a \\| b second line");
});
