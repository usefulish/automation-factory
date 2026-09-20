/**
 * Unit tests for the deterministic parts of the documentation factory:
 * repository parsing, markdown outlining, planning, navigation reconciliation,
 * link resolution, and validation.
 *
 * @module
 */

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { parseHeadings, parseRepoSlug } from "./_lib/inspect.ts";
import { buildDocsPlan } from "./_lib/plan.ts";
import { buildNavigation } from "./_lib/config.ts";
import {
  collectNavigationPages,
  internalLinks,
  localAssets,
  parseFrontmatter,
  resolveLink,
} from "./_lib/validate.ts";
import {
  buildAuthorInvocation,
  parseAgentJson,
  parseCodexAgentJsonl,
  resolveAuthorCliPath,
} from "./_lib/author.ts";
import { slugify, stripDocExtension } from "./_lib/util.ts";
import type { DocsPlan, RepoProfile } from "./_lib/types.ts";

Deno.test("parseRepoSlug handles every common remote spelling", () => {
  assertEquals(
    parseRepoSlug("https://github.com/usefulish/mac-dependency-safety.git"),
    "usefulish/mac-dependency-safety",
  );
  assertEquals(parseRepoSlug("git@github.com:owner/name.git"), "owner/name");
  assertEquals(parseRepoSlug("ssh://git@gitlab.com/group/proj"), "group/proj");
  assertEquals(
    parseRepoSlug("https://host/deep/nested/group/proj"),
    "group/proj",
  );
  assertEquals(parseRepoSlug("not-a-url"), null);
});

Deno.test("slugify produces filename-safe, stable slugs", () => {
  assertEquals(slugify("Layer 0 — Stop AI Agents"), "layer-0-stop-ai-agents");
  assertEquals(slugify("  ???  "), "untitled");
  assertEquals(slugify("Café Münster"), "cafe-munster");
});

Deno.test("stripDocExtension only strips markdown extensions", () => {
  assertEquals(stripDocExtension("guides/usage.mdx"), "guides/usage");
  assertEquals(stripDocExtension("guides/usage.md"), "guides/usage");
  assertEquals(stripDocExtension("assets/logo.png"), "assets/logo.png");
});

Deno.test("parseHeadings ignores headings inside fenced code blocks", () => {
  const markdown = [
    "# Title",
    "",
    "```sh",
    "# not a heading",
    "```",
    "",
    "## Real Section",
    "### Deeper `code` heading",
  ].join("\n");

  assertEquals(parseHeadings(markdown).map((h) => `${h.level}:${h.title}`), [
    "1:Title",
    "2:Real Section",
    "3:Deeper code heading",
  ]);
});

/** A minimal profile standing in for a shell-script tool repository. */
function profileFixture(overrides: Partial<RepoProfile> = {}): RepoProfile {
  return {
    repo: "acme/widget",
    slug: "acme-widget",
    repoPath: "/tmp/widget",
    remote: "https://github.com/acme/widget.git",
    headSha: "abc123",
    branch: "main",
    name: "widget",
    description: "Resizes widgets.",
    kind: "cli",
    primaryLanguage: "Shell",
    fileCount: 12,
    totalBytes: 4096,
    truncated: false,
    topLevelEntries: ["README.md", "install.sh", "config/"],
    languages: [{ language: "Shell", files: 3, bytes: 3000 }],
    manifests: [],
    entrypoints: [{
      path: "install.sh",
      interpreter: "/usr/bin/env bash",
      bytes: 900,
      summary: "Installs widget",
    }],
    markdown: [{
      path: "README.md",
      title: "widget",
      headings: [
        { level: 1, title: "widget", slug: "widget" },
        { level: 2, title: "Installation", slug: "installation" },
        { level: 2, title: "How it works", slug: "how-it-works" },
        { level: 2, title: "License", slug: "license" },
      ],
      bytes: 2000,
      truncated: false,
      excerpt: "Resizes widgets.",
    }],
    ci: [],
    docs: {
      dir: "docs",
      exists: false,
      configPath: "docs/docs.json",
      configPresent: false,
      legacyMintJson: false,
      pages: [],
    },
    license: null,
    inspectedAt: "2026-09-20T00:00:00.000Z",
    ...overrides,
  };
}

const COLORS = { primary: "#0D9373", light: "#07C983", dark: "#0D9373" };

Deno.test("buildDocsPlan derives pages from the profile, skipping boilerplate", () => {
  const plan = buildDocsPlan({
    profile: profileFixture(),
    siteName: null,
    theme: "mint",
    colors: COLORS,
  });

  const paths = plan.groups.flatMap((g) => g.pages.map((p) => p.path));
  assertEquals(paths.includes("index"), true);
  assertEquals(paths.includes("quickstart"), true);
  // "How it works" becomes a guide; "Installation" folds into the quickstart
  // and "License" is boilerplate.
  assertEquals(paths.includes("guides/how-it-works"), true);
  assertEquals(paths.includes("guides/license"), false);
  assertEquals(paths.includes("guides/installation"), false);
  assertEquals(paths.includes("reference/install"), true);
  assertEquals(plan.siteName, "widget");
  assertEquals(plan.pageCount, paths.length);
});

Deno.test("buildDocsPlan is deterministic for the same profile", () => {
  const args = {
    profile: profileFixture(),
    siteName: null,
    theme: "mint",
    colors: COLORS,
  };
  const a = buildDocsPlan(args);
  const b = buildDocsPlan(args);
  assertEquals(
    JSON.stringify(a.groups),
    JSON.stringify(b.groups),
  );
});

Deno.test("buildDocsPlan writes page files under the configured docs dir", () => {
  const plan = buildDocsPlan({
    profile: profileFixture({
      docs: {
        dir: ".",
        exists: true,
        configPath: "docs.json",
        configPresent: false,
        legacyMintJson: false,
        pages: [],
      },
    }),
    siteName: "Widget Docs",
    theme: "maple",
    colors: COLORS,
  });

  assertEquals(plan.groups[0].pages[0].file, "index.mdx");
  assertEquals(plan.siteName, "Widget Docs");
  assertEquals(plan.theme, "maple");
});

function planFixture(): DocsPlan {
  return {
    slug: "acme-widget",
    repo: "acme/widget",
    siteName: "widget",
    theme: "mint",
    colors: COLORS,
    docsDir: "docs",
    configPath: "docs/docs.json",
    groups: [
      {
        group: "Getting Started",
        pages: [
          page("index", "Overview"),
          page("quickstart", "Quickstart"),
        ],
      },
      { group: "Guides", pages: [page("guides/how-it-works", "How it works")] },
    ],
    pageCount: 3,
    rationale: "test",
    plannedAt: "2026-09-20T00:00:00.000Z",
  };

  function page(path: string, title: string) {
    return {
      path,
      file: `docs/${path}.mdx`,
      title,
      description: title,
      purpose: title,
      sources: [],
    };
  }
}

Deno.test("buildNavigation drops planned pages that were never written", () => {
  const { groups, plannedMissing } = buildNavigation(planFixture(), [
    "index",
    "quickstart",
  ]);

  assertEquals(plannedMissing, ["guides/how-it-works"]);
  assertEquals(groups.length, 1);
  assertEquals(groups[0].pages, ["index", "quickstart"]);
});

Deno.test("buildNavigation adopts unplanned pages so nothing is unreachable", () => {
  const { groups, orphansAdopted } = buildNavigation(planFixture(), [
    "index",
    "quickstart",
    "guides/how-it-works",
    "reference/flags",
  ]);

  assertEquals(orphansAdopted, ["reference/flags"]);
  const reference = groups.find((g) => g.group === "Reference");
  assertEquals(reference?.pages, ["reference/flags"]);
});

Deno.test("buildNavigation puts the index page first in the first group", () => {
  const plan = planFixture();
  const { groups } = buildNavigation(plan, [
    "guides/how-it-works",
    "quickstart",
    "index",
  ]);

  assertEquals(groups[0].group, "Getting Started");
  assertEquals(groups[0].pages[0], "index");
});

Deno.test("collectNavigationPages walks nested navigation shapes", () => {
  const navigation = {
    tabs: [
      {
        tab: "Docs",
        groups: [
          {
            group: "Start",
            pages: ["index", { group: "Deep", pages: ["a/b"] }],
          },
        ],
      },
      { tab: "Blog", href: "https://example.com/blog" },
    ],
    anchors: [{ anchor: "API", pages: ["api/overview"] }],
  };

  assertEquals(collectNavigationPages(navigation).sort(), [
    "a/b",
    "api/overview",
    "index",
  ]);
});

Deno.test("collectNavigationPages ignores external links", () => {
  assertEquals(
    collectNavigationPages({
      groups: [{ group: "X", pages: [{ href: "https://e.com" }] }],
    }),
    [],
  );
});

Deno.test("parseFrontmatter reads scalar keys and strips quotes", () => {
  const text = `---\ntitle: "Overview"\ndescription: What it is\n---\n\nBody`;
  assertEquals(parseFrontmatter(text), {
    title: "Overview",
    description: "What it is",
  });
  assertEquals(parseFrontmatter("no frontmatter"), null);
});

Deno.test("internalLinks skips external and anchor-only hrefs", () => {
  const body = [
    "See [quickstart](/quickstart) and [site](https://example.com).",
    "Also [anchor](#section) and [relative](../reference/flags).",
    "And [mail](mailto:a@b.c).",
  ].join("\n");

  assertEquals(internalLinks(body).sort(), [
    "../reference/flags",
    "/quickstart",
  ]);
});

Deno.test("resolveLink resolves root-relative and relative page links", () => {
  assertEquals(resolveLink("/quickstart", "index"), "quickstart");
  assertEquals(
    resolveLink("../reference/flags", "guides/usage"),
    "reference/flags",
  );
  assertEquals(resolveLink("sibling", "guides/usage"), "guides/sibling");
  assertEquals(resolveLink("/guides/usage#step-2", "index"), "guides/usage");
  // Assets are validated separately, not as pages.
  assertEquals(resolveLink("/images/logo.png", "index"), null);
});

Deno.test("resolveLink treats the docs root as the index page", () => {
  // Mintlify serves "/" as the docs home, so a link to it is not broken.
  assertEquals(resolveLink("/", "quickstart"), "index");
  assertEquals(resolveLink("/#section", "quickstart"), "index");
  assertEquals(resolveLink("../..", "guides/deep/page"), "index");
});

Deno.test("localAssets collects markdown images and JSX src attributes", () => {
  const body =
    `![logo](/images/logo.png)\n<img src="./local.svg" />\n<img src="https://e.com/x.png" />`;
  assertEquals(localAssets(body).sort(), ["./local.svg", "/images/logo.png"]);
});

Deno.test("parseAgentJson extracts metadata and tolerates non-JSON output", () => {
  const meta = parseAgentJson(JSON.stringify({
    session_id: "s1",
    total_cost_usd: 0.25,
    num_turns: 3,
    result: "DONE",
    permission_denials: [{ tool: "Bash" }],
    modelUsage: { "claude-opus-5": {} },
  }));
  assertEquals(meta.sessionId, "s1");
  assertEquals(meta.costUsd, 0.25);
  assertEquals(meta.numTurns, 3);
  assertEquals(meta.summary, "DONE");
  assertEquals(meta.permissionDenials, 1);
  assertEquals(meta.model, "claude-opus-5");

  const empty = parseAgentJson("plain text output");
  assertEquals(empty.sessionId, null);
  assertEquals(empty.permissionDenials, 0);
});

Deno.test("author provider defaults and explicit CLI overrides are resolved", () => {
  assertEquals(resolveAuthorCliPath("claude", null), "claude");
  assertEquals(resolveAuthorCliPath("codex", ""), "codex");
  assertEquals(
    resolveAuthorCliPath("codex", "/opt/homebrew/bin/codex"),
    "/opt/homebrew/bin/codex",
  );
});

Deno.test("Claude author invocation preserves the existing restricted contract", () => {
  const invocation = buildAuthorInvocation({
    provider: "claude",
    cliPath: "/usr/local/bin/claude",
    model: "claude-opus-5",
    prompt: "Write docs",
    repoPath: "/tmp/widget",
  });

  assertEquals(invocation.cliPath, "/usr/local/bin/claude");
  assertEquals(invocation.args.slice(0, 4), [
    "--print",
    "Write docs",
    "--output-format",
    "json",
  ]);
  assertEquals(invocation.args.includes("--restricted"), true);
  assertEquals(invocation.args.includes("--allowedTools"), true);
  assertEquals(invocation.args.slice(-2), ["--model", "claude-opus-5"]);
});

Deno.test("Codex author invocation uses non-interactive workspace-write JSONL", () => {
  const invocation = buildAuthorInvocation({
    provider: "codex",
    cliPath: null,
    model: "test-model",
    prompt: "Write docs",
    repoPath: "/tmp/widget",
  });

  assertEquals(invocation.cliPath, "codex");
  assertEquals(invocation.args, [
    "exec",
    "--sandbox",
    "workspace-write",
    "--ephemeral",
    "--json",
    "--model",
    "test-model",
    "Write docs",
  ]);
});

Deno.test("parseCodexAgentJsonl extracts thread, final message, and turns", () => {
  const meta = parseCodexAgentJsonl([
    '{"type":"thread.started","thread_id":"thread-1"}',
    '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"Wrote five pages."}}',
    '{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":20}}',
    "not-json",
  ].join("\n"));

  assertEquals(meta.sessionId, "thread-1");
  assertEquals(meta.summary, "Wrote five pages.");
  assertEquals(meta.numTurns, 1);
  assertEquals(meta.costUsd, null);
});

Deno.test("the authoring prompt never asks the agent to write docs.json", async () => {
  const { buildAuthorPrompt } = await import("./_lib/prompt.ts");
  const prompt = buildAuthorPrompt({
    profile: profileFixture(),
    plan: planFixture(),
    extraInstructions: null,
    overwrite: false,
  });
  assertStringIncludes(prompt, "Do not write `docs.json`");
  assertStringIncludes(prompt, "docs/index.mdx");
  assertStringIncludes(prompt, "No placeholders");
});

// --- Schema validation against the real published Mintlify schema ----------
// These use the vendored copy so the suite stays offline and deterministic.

import { themeBranches } from "./_lib/validate.ts";
import { validateDocs } from "./_lib/validate.ts";
import { ensureDocsConfig, listDocPages } from "./_lib/config.ts";

const VENDORED_SCHEMA = JSON.parse(
  await Deno.readTextFile(
    new URL("./docs-schema.json", import.meta.url).pathname,
  ),
) as Record<string, unknown>;

Deno.test("themeBranches reads every theme from the published schema", () => {
  const themes = themeBranches(VENDORED_SCHEMA);
  assertEquals(themes.includes("mint"), true);
  assertEquals(themes.includes("maple"), true);
  assertEquals(themes.length >= 9, true);
});

/** Build a throwaway docs tree and validate it. */
async function withDocs(
  files: Record<string, string>,
  run: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "mintlify-test-" });
  try {
    for (const [rel, content] of Object.entries(files)) {
      const abs = `${dir}/${rel}`;
      const parent = abs.slice(0, abs.lastIndexOf("/"));
      await Deno.mkdir(parent, { recursive: true });
      await Deno.writeTextFile(abs, content);
    }
    await run(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

function validConfig(): string {
  return JSON.stringify({
    $schema: "https://mintlify.com/docs.json",
    theme: "mint",
    name: "Widget",
    colors: { primary: "#0D9373", light: "#07C983", dark: "#0D9373" },
    navigation: { groups: [{ group: "Start", pages: ["index"] }] },
  });
}

function goodPage(title: string): string {
  return [
    "---",
    `title: "${title}"`,
    `description: "A real description for ${title} that is long enough to matter."`,
    "---",
    "",
    `# ${title}`,
    "",
    "This page has enough real prose in it to clear the empty-page threshold,",
    "which exists so a stub can never pass validation unnoticed.",
    "",
  ].join("\n");
}

const baseOpts = {
  docsDir: "docs",
  configPath: "docs/docs.json",
  schema: VENDORED_SCHEMA,
  schemaOrigin: "bundled",
  strict: true,
};

Deno.test("a well-formed docs set passes with no schema-compile warning", async () => {
  await withDocs({
    "docs/docs.json": validConfig(),
    "docs/index.mdx": goodPage("Overview"),
  }, async (dir) => {
    const result = await validateDocs({ ...baseOpts, repoPath: dir });
    // A schema that fails to compile would silently skip conformance checking.
    assertEquals(
      result.issues.filter((i) => i.kind === "schema-unavailable"),
      [],
    );
    assertEquals(result.errorCount, 0);
    assertEquals(result.ok, true);
    assertEquals(result.pageCount, 1);
  });
});

Deno.test("schema violations are reported once, not once per theme branch", async () => {
  const broken = JSON.stringify({
    $schema: "https://mintlify.com/docs.json",
    theme: "mint",
    name: "Widget",
    colors: { primary: "green" },
    navigation: { groups: [{ group: "Start", pages: ["index"] }] },
  });

  await withDocs({
    "docs/docs.json": broken,
    "docs/index.mdx": goodPage("Overview"),
  }, async (dir) => {
    const result = await validateDocs({ ...baseOpts, repoPath: dir });
    const schemaIssues = result.issues.filter((i) => i.kind === "schema");
    assertEquals(result.ok, false);
    assertEquals(schemaIssues.length, 1);
    assertStringIncludes(schemaIssues[0].message, "/colors/primary");
  });
});

Deno.test("an unknown theme is reported as a theme error", async () => {
  const broken = validConfig().replace('"mint"', '"midnight"');
  await withDocs({
    "docs/docs.json": broken,
    "docs/index.mdx": goodPage("Overview"),
  }, async (dir) => {
    const result = await validateDocs({ ...baseOpts, repoPath: dir });
    assertEquals(result.ok, false);
    assertStringIncludes(result.issues[0].message, '"theme" must be one of');
  });
});

Deno.test("navigation pointing at a missing page is an error", async () => {
  const config = JSON.parse(validConfig());
  config.navigation.groups[0].pages = ["index", "ghost"];
  await withDocs({
    "docs/docs.json": JSON.stringify(config),
    "docs/index.mdx": goodPage("Overview"),
  }, async (dir) => {
    const result = await validateDocs({ ...baseOpts, repoPath: dir });
    assertEquals(result.ok, false);
    assertEquals(
      result.issues.some((i) => i.kind === "missing-page"),
      true,
    );
  });
});

Deno.test("placeholders, stubs, and broken links all fail validation", async () => {
  await withDocs({
    "docs/docs.json": validConfig(),
    "docs/index.mdx": [
      "---",
      'title: "Overview"',
      'description: "Real description here for the overview page."',
      "---",
      "",
      "TODO: write this properly later on when there is more time available.",
      "",
      "See [the guide](/guides/nowhere) and ![shot](/images/missing.png).",
    ].join("\n"),
  }, async (dir) => {
    const result = await validateDocs({ ...baseOpts, repoPath: dir });
    const kinds = new Set(result.issues.map((i) => i.kind));
    assertEquals(kinds.has("placeholder"), true);
    assertEquals(kinds.has("broken-link"), true);
    assertEquals(kinds.has("missing-asset"), true);
    assertEquals(result.ok, false);
  });
});

Deno.test("a page with no frontmatter fails validation", async () => {
  await withDocs({
    "docs/docs.json": validConfig(),
    "docs/index.mdx":
      "# Overview\n\nBody text that is long enough to not be an empty page at all.\n",
  }, async (dir) => {
    const result = await validateDocs({ ...baseOpts, repoPath: dir });
    assertEquals(
      result.issues.some((i) => i.kind === "missing-frontmatter"),
      true,
    );
  });
});

Deno.test("a missing docs.json is reported rather than crashing", async () => {
  await withDocs({ "docs/index.mdx": goodPage("Overview") }, async (dir) => {
    const result = await validateDocs({ ...baseOpts, repoPath: dir });
    assertEquals(result.ok, false);
    assertEquals(result.issues[0].kind, "missing-config");
  });
});

Deno.test("ensureConfig writes a config the published schema accepts", async () => {
  await withDocs({
    "docs/index.mdx": goodPage("Overview"),
    "docs/guides/usage.mdx": goodPage("Usage"),
  }, async (dir) => {
    const written = await ensureDocsConfig({
      repoPath: dir,
      plan: planFixture(),
      force: false,
      dryRun: false,
    });
    assertEquals(written.created, true);
    assertEquals(written.orphansAdopted, ["guides/usage"]);

    const result = await validateDocs({ ...baseOpts, repoPath: dir });
    assertEquals(result.issues.filter((i) => i.kind === "schema"), []);
    assertEquals(result.ok, true);
  });
});

Deno.test("ensureConfig preserves operator customisations and is idempotent", async () => {
  await withDocs({
    "docs/index.mdx": goodPage("Overview"),
    "docs/docs.json": JSON.stringify({
      $schema: "https://mintlify.com/docs.json",
      theme: "maple",
      name: "Custom Name",
      colors: { primary: "#112233" },
      favicon: "/favicon.svg",
      navigation: { groups: [] },
    }),
  }, async (dir) => {
    const first = await ensureDocsConfig({
      repoPath: dir,
      plan: planFixture(),
      force: false,
      dryRun: false,
    });
    assertEquals(first.config.theme, "maple");
    assertEquals(first.config.name, "Custom Name");
    assertEquals(first.config.favicon, "/favicon.svg");
    assertEquals(first.changed, true);

    const second = await ensureDocsConfig({
      repoPath: dir,
      plan: planFixture(),
      force: false,
      dryRun: false,
    });
    assertEquals(second.changed, false);
  });
});

Deno.test("ensureConfig dryRun leaves the file untouched", async () => {
  await withDocs({ "docs/index.mdx": goodPage("Overview") }, async (dir) => {
    const result = await ensureDocsConfig({
      repoPath: dir,
      plan: planFixture(),
      force: false,
      dryRun: true,
    });
    assertEquals(result.changed, true);
    let exists = true;
    try {
      await Deno.stat(`${dir}/docs/docs.json`);
    } catch {
      exists = false;
    }
    assertEquals(exists, false);
  });
});

Deno.test("ensureConfig refuses to overwrite an unparseable docs.json", async () => {
  await withDocs({
    "docs/index.mdx": goodPage("Overview"),
    "docs/docs.json": '{ "theme": "mint", }',
  }, async (dir) => {
    let message = "";
    try {
      await ensureDocsConfig({
        repoPath: dir,
        plan: planFixture(),
        force: false,
        dryRun: false,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assertStringIncludes(message, "not valid JSON");
    // The operator's file is still there, untouched.
    assertEquals(
      await Deno.readTextFile(`${dir}/docs/docs.json`),
      '{ "theme": "mint", }',
    );
  });
});

Deno.test("listDocPages reports both pages and whether the scan was capped", async () => {
  await withDocs({
    "docs/index.mdx": goodPage("Overview"),
    "docs/guides/usage.mdx": goodPage("Usage"),
    "docs/notes.txt": "not a page",
  }, async (dir) => {
    const { pages, truncated } = await listDocPages(dir, "docs");
    assertEquals(pages, ["guides/usage", "index"]);
    assertEquals(truncated, false);
  });
});

Deno.test("a link to the docs root and to a directory index both resolve", async () => {
  await withDocs({
    "docs/docs.json": (() => {
      const config = JSON.parse(validConfig());
      config.navigation.groups[0].pages = [
        "index",
        "quickstart",
        "guides/index",
      ];
      return JSON.stringify(config);
    })(),
    "docs/index.mdx": goodPage("Overview"),
    "docs/guides/index.mdx": goodPage("Guides"),
    "docs/quickstart.mdx": [
      "---",
      'title: "Quickstart"',
      'description: "Get going with the thing in a couple of minutes flat."',
      "---",
      "",
      "Back to the [overview](/) and on to the [guides](/guides).",
      "",
      "That is enough body text here to clear the empty-page threshold easily.",
    ].join("\n"),
  }, async (dir) => {
    const result = await validateDocs({ ...baseOpts, repoPath: dir });
    assertEquals(result.issues.filter((i) => i.kind === "broken-link"), []);
    assertEquals(result.ok, true);
  });
});
