/**
 * Post-execution report for the Mintlify documentation factory.
 *
 * Renders whichever documentation artefact the method just produced — a
 * validation result, an authoring run, or a reconciled config — as readable
 * markdown plus machine-readable JSON. Reports run even when the method threw,
 * so a failing validation gate still surfaces its findings here.
 *
 * @module
 */

/** Minimal shape of the method-scope report context this report reads. */
interface ReportContext {
  readonly modelType: string;
  readonly modelId: string;
  readonly methodName: string;
  readonly executionStatus: string;
  readonly errorMessage?: string;
  readonly definition: { readonly name: string };
  readonly dataHandles: ReadonlyArray<
    {
      readonly name: string;
      readonly specName?: string;
      readonly version?: number;
    }
  >;
  readonly dataRepository: {
    getContent(
      modelType: string,
      modelId: string,
      dataName: string,
      version?: number,
    ): Promise<Uint8Array | null>;
    findAllForModel(
      modelType: string,
      modelId: string,
    ): Promise<
      ReadonlyArray<{
        name: string;
        version?: number;
        createdAt?: string | Date;
        tags?: Record<string, string>;
      }>
    >;
  };
}

interface Issue {
  severity: string;
  kind: string;
  file: string | null;
  message: string;
}

interface ChangedFile {
  path: string;
  change: string;
  bytes: number;
}

interface NavigationGroup {
  group: string;
  pages: string[];
}

interface PlannedGroup {
  group: string;
  pages: Array<{ path: string; title: string }>;
}

/** Documentation factory report — validation findings and authoring results. */
export const report = {
  name: "@usefulish/mintlify-docs",
  description:
    "Summarise a documentation factory run — validation findings, authoring cost, and navigation coverage",
  scope: "method",
  labels: ["docs", "mintlify", "quality"],

  execute: async (
    context: ReportContext,
  ): Promise<{ markdown: string; json: Record<string, unknown> }> => {
    const sections: string[] = [
      `# Documentation factory — \`${context.methodName}\``,
      "",
      `- **Model**: ${context.definition.name}`,
      `- **Status**: ${context.executionStatus}`,
      ...(context.errorMessage === undefined ? [] : [
        "",
        "```",
        context.errorMessage,
        "```",
      ]),
      "",
    ];
    const json: Record<string, unknown> = {
      model: context.definition.name,
      method: context.methodName,
      status: context.executionStatus,
    };

    const artefacts = await readArtefacts(context);

    if (artefacts.validation !== null) {
      const v = artefacts.validation;
      json.validation = v;
      sections.push(renderValidation(v));
    }

    if (artefacts.authorRun !== null) {
      const a = artefacts.authorRun;
      json.authorRun = a;
      sections.push(renderAuthorRun(a));
    }

    if (artefacts.docsConfig !== null) {
      const c = artefacts.docsConfig;
      json.docsConfig = c;
      sections.push(renderConfig(c));
    }

    if (artefacts.docsPlan !== null) {
      const p = artefacts.docsPlan;
      json.docsPlan = {
        pageCount: num(p, "pageCount"),
        rationale: str(p, "rationale"),
      };
      sections.push(renderPlan(p));
    }

    if (artefacts.repoProfile !== null) {
      const r = artefacts.repoProfile;
      json.repoProfile = {
        repo: str(r, "repo") || str(r, "name"),
        kind: str(r, "kind"),
        primaryLanguage: str(r, "primaryLanguage"),
        fileCount: num(r, "fileCount"),
      };
      sections.push(renderProfile(r));
    }

    if (sections.length === 4) {
      sections.push(
        "_No documentation artefacts were produced by this execution._",
      );
    }

    return { markdown: sections.join("\n"), json };
  },
};

/** A JSON-parsed artefact. Fields are read through the accessors below. */
type Artefact = Record<string, unknown>;

interface Artefacts {
  validation: Artefact | null;
  authorRun: Artefact | null;
  docsConfig: Artefact | null;
  docsPlan: Artefact | null;
  repoProfile: Artefact | null;
}

/** Read a string field, falling back when it is absent or the wrong type. */
function str(source: Artefact, key: string, fallback = ""): string {
  const value = source[key];
  return typeof value === "string" ? value : fallback;
}

/** Read a numeric field, or null when absent or the wrong type. */
function num(source: Artefact, key: string): number | null {
  const value = source[key];
  return typeof value === "number" ? value : null;
}

/** Read a boolean field, defaulting to false. */
function bool(source: Artefact, key: string): boolean {
  return source[key] === true;
}

/** Read an array field as a typed list, or an empty list. */
function list<T>(source: Artefact, key: string): T[] {
  const value = source[key];
  return Array.isArray(value) ? value as T[] : [];
}

/**
 * Collect the documentation artefacts this execution produced.
 *
 * A method that throws returns no data handles even though it may already have
 * persisted its findings — the validation gate does exactly that. So when the
 * handles come up empty, the model's stored data is scanned directly and the
 * newest instance of each spec is used.
 */
async function readArtefacts(context: ReportContext): Promise<Artefacts> {
  const out: Artefacts = {
    validation: null,
    authorRun: null,
    docsConfig: null,
    docsPlan: null,
    repoProfile: null,
  };

  const load = async (
    spec: string,
    name: string,
    version?: number,
  ): Promise<void> => {
    if (!(spec in out)) return;
    const raw = await context.dataRepository.getContent(
      context.modelType,
      context.modelId,
      name,
      version,
    );
    if (raw === null) return;
    try {
      out[spec as keyof Artefacts] = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      // A malformed artefact is simply omitted from the report.
    }
  };

  for (const handle of context.dataHandles) {
    if (handle.specName === undefined) continue;
    await load(handle.specName, handle.name, handle.version);
  }

  const found = Object.values(out).some((value) => value !== null);
  if (found) return out;

  let stored: ReadonlyArray<{
    name: string;
    version?: number;
    createdAt?: string | Date;
    tags?: Record<string, string>;
  }>;
  try {
    stored = await context.dataRepository.findAllForModel(
      context.modelType,
      context.modelId,
    );
  } catch {
    return out;
  }

  const newestBySpec = new Map<string, typeof stored[number]>();
  for (const entry of stored) {
    const spec = entry.tags?.specName;
    if (spec === undefined || !(spec in out)) continue;
    const current = newestBySpec.get(spec);
    if (current === undefined || rank(entry) > rank(current)) {
      newestBySpec.set(spec, entry);
    }
  }

  for (const [spec, entry] of newestBySpec) {
    await load(spec, entry.name, entry.version);
  }
  return out;
}

/** Sort key for "most recent data", tolerant of missing metadata. */
function rank(
  entry: { version?: number; createdAt?: string | Date },
): number {
  const created = entry.createdAt === undefined
    ? 0
    : new Date(entry.createdAt).getTime();
  return Number.isFinite(created) && created > 0 ? created : entry.version ?? 0;
}

function renderValidation(v: Artefact): string {
  const issues = list<Issue>(v, "issues");
  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  const configPath = str(v, "configPath", "docs.json");
  const schemaNote = str(v, "schemaNote");

  const lines = [
    "## Validation",
    "",
    `**${bool(v, "ok") ? "PASS" : "FAIL"}** — ${num(v, "errorCount") ?? 0} ` +
    `error(s), ${num(v, "warningCount") ?? 0} warning(s) across ` +
    `${num(v, "pageCount") ?? 0} page(s).`,
    "",
    `- Config: \`${configPath}\``,
    `- Schema source: ${str(v, "schemaOrigin", "unknown")}${
      schemaNote === "" ? "" : ` (${schemaNote})`
    }`,
    "",
  ];

  if (errors.length > 0) {
    lines.push("### Errors", "");
    lines.push("| Kind | File | Detail |", "| --- | --- | --- |");
    for (const issue of errors) {
      lines.push(
        `| \`${issue.kind}\` | \`${issue.file ?? configPath}\` | ${
          escapeCell(issue.message)
        } |`,
      );
    }
    lines.push("");
  }

  if (warnings.length > 0) {
    lines.push("### Warnings", "");
    for (const issue of warnings) {
      lines.push(
        `- \`${issue.kind}\` \`${
          issue.file ?? configPath
        }\` — ${issue.message}`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

function renderAuthorRun(a: Artefact): string {
  const cost = num(a, "costUsd");
  const turns = num(a, "numTurns");
  const lines = [
    "## Authoring run",
    "",
    `- Exit code: ${num(a, "exitCode") ?? "unknown"}${
      bool(a, "timedOut") ? " (timed out)" : ""
    }`,
    `- Duration: ${formatMs(num(a, "durationMs"))}`,
    `- Model: ${str(a, "model", "cli default")}`,
    `- Turns: ${turns ?? "unknown"}`,
    `- Cost: ${cost === null ? "unknown" : `$${cost.toFixed(4)}`}`,
    `- Permission denials: ${num(a, "permissionDenials") ?? 0}`,
    `- Files written: ${num(a, "filesChanged") ?? 0}`,
    "",
  ];

  const changed = list<ChangedFile>(a, "changedFiles");
  if (changed.length > 0) {
    lines.push("| File | Change | Bytes |", "| --- | --- | --- |");
    for (const file of changed) {
      lines.push(`| \`${file.path}\` | ${file.change} | ${file.bytes} |`);
    }
    lines.push("");
  }

  const summary = str(a, "summary").trim();
  if (summary !== "") {
    lines.push("> " + summary.split("\n").join("\n> "), "");
  }
  return lines.join("\n");
}

function renderConfig(c: Artefact): string {
  const nav = list<NavigationGroup>(c, "navigation");
  const state = bool(c, "created")
    ? "created"
    : bool(c, "changed")
    ? "updated"
    : "unchanged";

  const lines = [
    "## Navigation",
    "",
    `\`${str(c, "configPath", "docs.json")}\` — ${state}, ` +
    `${num(c, "pageCount") ?? 0} page(s) in ${
      num(c, "groupCount") ?? 0
    } group(s).`,
    "",
  ];
  for (const group of nav) {
    lines.push(`- **${group.group}**`);
    for (const page of group.pages) lines.push(`  - \`${page}\``);
  }
  lines.push("");

  const missing = list<string>(c, "plannedMissing");
  if (missing.length > 0) {
    lines.push(
      `Planned but never written (omitted from navigation): ${
        missing.map((m) => `\`${m}\``).join(", ")
      }`,
      "",
    );
  }
  const adopted = list<string>(c, "orphansAdopted");
  if (adopted.length > 0) {
    lines.push(
      `Unplanned pages adopted into navigation: ${
        adopted.map((m) => `\`${m}\``).join(", ")
      }`,
      "",
    );
  }
  return lines.join("\n");
}

function renderPlan(p: Artefact): string {
  const groups = list<PlannedGroup>(p, "groups");
  const lines = [
    "## Plan",
    "",
    `${num(p, "pageCount") ?? 0} page(s) for **${
      str(p, "siteName", "the site")
    }**.`,
    "",
    `_${str(p, "rationale")}_`,
    "",
  ];
  for (const group of groups) {
    lines.push(`- **${group.group}**`);
    for (const page of group.pages) {
      lines.push(`  - \`${page.path}\` — ${page.title}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

function renderProfile(r: Artefact): string {
  const languages = list<{ language: string; files: number }>(r, "languages");
  const docs = r.docs;
  const docPages = typeof docs === "object" && docs !== null
    ? list<string>(docs as Artefact, "pages").length
    : 0;

  return [
    "## Repository profile",
    "",
    `- Repository: ${str(r, "repo") || str(r, "name", "unknown")}`,
    `- Classified as: **${str(r, "kind", "unknown")}**`,
    `- Primary language: ${str(r, "primaryLanguage", "unknown")}`,
    `- Files: ${num(r, "fileCount") ?? 0}`,
    `- Languages: ${
      languages.slice(0, 6).map((l) => `${l.language} (${l.files})`)
        .join(", ") || "none detected"
    }`,
    `- Entrypoints: ${list<unknown>(r, "entrypoints").length}`,
    `- Existing docs pages: ${docPages}`,
    "",
  ].join("\n");
}

function formatMs(ms: number | null): string {
  if (ms === null) return "unknown";
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
