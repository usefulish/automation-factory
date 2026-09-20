/**
 * Builds the authoring brief handed to the coding agent.
 *
 * The brief is assembled from deterministic inputs only — the repository
 * profile and the documentation plan — so the same repository always produces
 * the same instructions. Nothing about any particular repository is hardcoded.
 *
 * @module
 */

import type { DocsPlan, RepoProfile } from "./types.ts";

/** Options accepted by {@linkcode buildAuthorPrompt}. */
export interface PromptOptions {
  readonly profile: RepoProfile;
  readonly plan: DocsPlan;
  /** Extra caller-supplied guidance appended verbatim. */
  readonly extraInstructions: string | null;
  /** Rewrite pages that already exist rather than leaving them alone. */
  readonly overwrite: boolean;
}

/**
 * Compose the full authoring prompt.
 *
 * @param opts Profile, plan, and per-run authoring switches.
 * @returns The prompt text to pass to the agent CLI.
 */
export function buildAuthorPrompt(opts: PromptOptions): string {
  const { profile, plan } = opts;

  const pageBriefs = plan.groups.flatMap((group) =>
    group.pages.map((page) =>
      [
        `### ${page.file}`,
        `- Navigation group: ${group.group}`,
        `- Frontmatter title: ${page.title}`,
        `- Suggested description: ${page.description}`,
        `- Must cover: ${page.purpose}`,
        `- Read first: ${page.sources.join(", ") || "(whole repository)"}`,
      ].join("\n")
    )
  ).join("\n\n");

  return [
    `You are writing the Mintlify documentation site for the repository checked`,
    `out at the current working directory. Write real, accurate documentation —`,
    `this is published, reader-facing material, not a scaffold.`,
    ``,
    `## Repository facts (machine-generated, trust these)`,
    ``,
    "```json",
    JSON.stringify(compactProfile(profile), null, 2),
    "```",
    ``,
    `## Pages to write`,
    ``,
    `Write exactly these files. ${
      opts.overwrite
        ? "Overwrite any that already exist."
        : "If a file already exists and is already accurate and complete, leave it alone."
    }`,
    `You may add further pages under \`${
      plan.docsDir === "." ? "" : `${plan.docsDir}/`
    }\` if the repository clearly warrants them — they will be picked up`,
    `automatically. Do not delete existing pages.`,
    ``,
    pageBriefs,
    ``,
    `## Rules`,
    ``,
    `1. **Ground every claim in the repository.** Read the files listed for each`,
    `   page before writing it. Never invent a flag, command, path, environment`,
    `   variable, API, or behaviour that you have not seen in the source. If`,
    `   something is genuinely unclear, describe what the code does rather than`,
    `   guessing at intent.`,
    `2. **Copy commands verbatim.** Install steps, CLI invocations, and config`,
    `   snippets must match the repository exactly, including flags and paths.`,
    `3. **Every file gets YAML frontmatter** as the first thing in the file:`,
    ``,
    "   ```",
    "   ---",
    '   title: "Short page title"',
    '   description: "One sentence, under 160 characters, describing the page."',
    "   ---",
    "   ```",
    ``,
    `4. **Write MDX.** You may use Mintlify components — \`<Note>\`, \`<Warning>\`,`,
    `   \`<Tip>\`, \`<Steps>\`/\`<Step>\`, \`<CodeGroup>\`, \`<Card>\`/\`<Columns>\`,`,
    `   \`<Accordion>\`, \`<Tabs>\`/\`<Tab>\`, \`<ParamField>\`, \`<ResponseField>\`.`,
    `   Use them where they genuinely help; plain prose and fenced code blocks`,
    `   are fine everywhere else. Close every tag. Escape stray \`<\` and \`{\` in`,
    `   prose — MDX parses them as JSX.`,
    `5. **Internal links use root-relative paths without a file extension**,`,
    `   e.g. \`[the quickstart](/quickstart)\`, \`[flags](/reference/commands)\`.`,
    `   Only link to pages that exist in this docs set.`,
    `6. **No placeholders.** Never write TODO, TBD, FIXME, "coming soon", or`,
    `   lorem ipsum. If you cannot document something accurately, omit it.`,
    `7. **No images or screenshots** — you cannot create them and broken asset`,
    `   references fail validation.`,
    `8. **Do not write \`docs.json\`** — the navigation config is generated`,
    `   separately from the files you create.`,
    `9. **Stay inside the checkout.** Only create or edit files under`,
    `   \`${
      plan.docsDir === "." ? "the repository root" : `${plan.docsDir}/`
    }\`.`,
    `   Do not modify source code, README, CI config, or anything else.`,
    ``,
    `## Voice`,
    ``,
    `Direct and concrete. Lead each page with what the reader can do and why it`,
    `matters, then the steps. Prefer short paragraphs and real examples over`,
    `abstraction. Be explicit about limits, caveats, and things the project does`,
    `not do — a reader who is misled by the docs is worse off than one who reads`,
    `nothing.`,
    ...(opts.extraInstructions === null ? [] : [
      ``,
      `## Additional instructions from the operator`,
      ``,
      opts.extraInstructions,
    ]),
    ``,
    `When every page is written, reply with a one-line summary of what you wrote.`,
  ].join("\n");
}

/**
 * Trim the profile to what actually helps the agent, keeping the prompt within
 * a sane size for large repositories.
 */
function compactProfile(profile: RepoProfile): Record<string, unknown> {
  return {
    repo: profile.repo,
    name: profile.name,
    description: profile.description,
    kind: profile.kind,
    primaryLanguage: profile.primaryLanguage,
    license: profile.license,
    branch: profile.branch,
    fileCount: profile.fileCount,
    topLevelEntries: profile.topLevelEntries,
    languages: profile.languages.map((l) => `${l.language} (${l.files} files)`),
    manifests: profile.manifests.map((m) => ({
      path: m.path,
      kind: m.kind,
      name: m.name,
      version: m.version,
      description: m.description,
      scripts: m.scripts,
      binaries: m.binaries,
    })),
    entrypoints: profile.entrypoints.map((e) => ({
      path: e.path,
      interpreter: e.interpreter,
      summary: e.summary,
    })),
    markdown: profile.markdown.map((m) => ({
      path: m.path,
      title: m.title,
      excerpt: m.excerpt,
      sections: m.headings
        .filter((h) => h.level <= 3)
        .map((h) => `${"#".repeat(h.level)} ${h.title}`),
    })),
    ci: profile.ci.map((c) => c.path),
    existingDocPages: profile.docs.pages,
  };
}
