/**
 * Derives a documentation plan from a repository profile.
 *
 * The plan is fully deterministic — same profile in, same page set out — so the
 * authoring agent is given a fixed brief to fill rather than being asked to
 * invent an information architecture from scratch. The agent may add pages; the
 * config step reconciles navigation against whatever actually lands on disk.
 *
 * @module
 */

import { joinPath, slugify } from "./util.ts";
import type {
  DocsPlan,
  MarkdownDoc,
  PlannedGroup,
  PlannedPage,
  RepoProfile,
} from "./types.ts";

/** README sections that map to dedicated pages rather than a guide page. */
const INSTALL_PATTERN =
  /\b(install|installation|setup|getting started|quick ?start|usage)\b/i;
/** README sections that never become their own page. */
const SKIPPED_SECTION =
  /^(license|licence|contributing|contributors|credits|acknowledg|code of conduct|security|changelog|table of contents|contents|support|stars?|badges?)\b/i;

const MAX_GUIDE_PAGES = 8;
const MAX_REFERENCE_PAGES = 10;

/** Options accepted by {@linkcode buildDocsPlan}. */
export interface PlanOptions {
  readonly profile: RepoProfile;
  readonly siteName?: string | null;
  readonly theme: string;
  readonly colors: { primary: string; light: string; dark: string };
}

/**
 * Build the documentation plan for a profiled repository.
 *
 * @param opts The profile plus site-level presentation settings.
 * @returns The plan, including the page set and the reasoning behind it.
 */
export function buildDocsPlan(opts: PlanOptions): DocsPlan {
  const { profile, theme, colors } = opts;
  const docsDir = profile.docs.dir;
  const readme = profile.markdown.find((m) => /readme/i.test(m.path));

  const groups: PlannedGroup[] = [];
  const reasons: string[] = [];

  const gettingStarted = buildGettingStarted(profile, readme);
  groups.push(gettingStarted);
  reasons.push(
    `Getting Started: ${gettingStarted.pages.length} page(s) from README and manifests.`,
  );

  const guides = buildGuides(profile, readme, docsDir);
  if (guides.pages.length > 0) {
    groups.push(guides);
    reasons.push(
      `Guides: ${guides.pages.length} page(s) from top-level README sections.`,
    );
  }

  const reference = buildReference(profile, docsDir);
  if (reference.pages.length > 0) {
    groups.push(reference);
    reasons.push(
      `Reference: ${reference.pages.length} page(s) from entrypoints, scripts, and CI.`,
    );
  }

  const about = buildAbout(profile, docsDir);
  if (about.pages.length > 0) {
    groups.push(about);
    reasons.push(
      `About: ${about.pages.length} page(s) from repository metadata.`,
    );
  }

  const pageCount = groups.reduce((sum, g) => sum + g.pages.length, 0);

  return {
    slug: profile.slug,
    repo: profile.repo,
    siteName: opts.siteName ?? profile.name,
    theme,
    colors,
    docsDir,
    configPath: profile.docs.configPath,
    groups,
    pageCount,
    rationale: [
      `Classified as "${profile.kind}"${
        profile.primaryLanguage === null
          ? ""
          : ` (primary language ${profile.primaryLanguage})`
      }.`,
      ...reasons,
    ].join(" "),
    plannedAt: new Date().toISOString(),
  };
}

function buildGettingStarted(
  profile: RepoProfile,
  readme: MarkdownDoc | undefined,
): PlannedGroup {
  const readmePath = readme?.path ?? null;
  const sources = [readmePath, ...profile.manifests.map((m) => m.path)]
    .filter((p): p is string => p !== null);

  const pages: PlannedPage[] = [
    page({
      docsDir: profile.docs.dir,
      path: "index",
      title: "Overview",
      description: profile.description ??
        `What ${profile.name} is and when to reach for it.`,
      purpose:
        `Explain what ${profile.name} is, the problem it solves, who it is for, ` +
        `and what it explicitly does not do. State the scope and any platform or ` +
        `version constraints. Close with links to the other pages.`,
      sources,
    }),
  ];

  const hasInstallSection =
    readme?.headings.some((h) =>
      h.level === 2 && INSTALL_PATTERN.test(h.title)
    ) ?? false;

  if (
    hasInstallSection || profile.manifests.length > 0 ||
    profile.entrypoints.length > 0
  ) {
    pages.push(page({
      docsDir: profile.docs.dir,
      path: "quickstart",
      title: "Quickstart",
      description: `Install ${profile.name} and confirm it works.`,
      purpose:
        `Give the shortest path from nothing to a working setup: prerequisites, ` +
        `install or bootstrap commands copied faithfully from the repository, and ` +
        `a verification step that proves it worked. Every command must come from ` +
        `the repository — do not invent flags or package names.`,
      sources,
    }));
  }

  return { group: "Getting Started", pages };
}

function buildGuides(
  profile: RepoProfile,
  readme: MarkdownDoc | undefined,
  docsDir: string,
): PlannedGroup {
  if (readme === undefined) return { group: "Guides", pages: [] };

  const sections = readme.headings
    .filter((h) => h.level === 2)
    .filter((h) => !SKIPPED_SECTION.test(h.title))
    .filter((h) => !INSTALL_PATTERN.test(h.title));

  const seen = new Set<string>();
  const pages: PlannedPage[] = [];

  for (const section of sections) {
    const slug = slugify(section.title);
    if (slug === "untitled" || seen.has(slug)) continue;
    seen.add(slug);
    pages.push(page({
      docsDir,
      path: `guides/${slug}`,
      title: section.title,
      description:
        `How ${section.title.toLowerCase()} works in ${profile.name}.`,
      purpose:
        `Expand the "${section.title}" section of ${readme.path} into a standalone ` +
        `page. Keep every concrete command, path, and setting; add the context a ` +
        `reader needs to act on it. Do not introduce behaviour the repository does ` +
        `not implement.`,
      sources: [readme.path],
    }));
    if (pages.length >= MAX_GUIDE_PAGES) break;
  }

  return { group: "Guides", pages };
}

function buildReference(
  profile: RepoProfile,
  docsDir: string,
): PlannedGroup {
  const pages: PlannedPage[] = [];
  const seen = new Set<string>();

  for (const entry of profile.entrypoints) {
    const slug = slugify(entry.path.replace(/\.[^.]+$/, ""));
    if (seen.has(slug)) continue;
    seen.add(slug);
    pages.push(page({
      docsDir,
      path: `reference/${slug}`,
      title: entry.path,
      description: entry.summary ?? `Reference for ${entry.path}.`,
      purpose:
        `Document ${entry.path}: what it does, how it is invoked, every flag, ` +
        `environment variable, and argument it reads, what it changes on the ` +
        `system, and how to undo it. Read the file — do not guess at behaviour.`,
      sources: [entry.path],
    }));
    if (pages.length >= MAX_REFERENCE_PAGES) break;
  }

  const scripted = profile.manifests.filter((m) => m.scripts.length > 0);
  if (scripted.length > 0 && pages.length < MAX_REFERENCE_PAGES) {
    pages.push(page({
      docsDir,
      path: "reference/commands",
      title: "Commands",
      description: `Every runnable task defined by ${profile.name}.`,
      purpose: `Tabulate every script defined in ${
        scripted.map((m) => m.path).join(", ")
      }: name, what it does, and when to run it.`,
      sources: scripted.map((m) => m.path),
    }));
  }

  const configFiles = profile.topLevelEntries.filter((e) => e.endsWith("/"));
  if (
    profile.kind === "configuration" && configFiles.length > 0 &&
    pages.length < MAX_REFERENCE_PAGES
  ) {
    pages.push(page({
      docsDir,
      path: "reference/configuration",
      title: "Configuration",
      description: `Every configuration file ${profile.name} ships.`,
      purpose:
        `Describe each configuration file or directory the repository ships ` +
        `(${
          configFiles.join(", ")
        }): where it is installed, what each setting ` +
        `does, and the effect of changing it.`,
      sources: configFiles,
    }));
  }

  return { group: "Reference", pages };
}

function buildAbout(profile: RepoProfile, docsDir: string): PlannedGroup {
  const pages: PlannedPage[] = [];
  const changelog = profile.markdown.find((m) => /changelog/i.test(m.path));

  if (changelog !== undefined) {
    pages.push(page({
      docsDir,
      path: "about/changelog",
      title: "Changelog",
      description: `Notable changes to ${profile.name}.`,
      purpose:
        `Summarise ${changelog.path} for readers: group by release, lead with ` +
        `behaviour changes and anything that requires action. Link to the full ` +
        `file rather than duplicating every line.`,
      sources: [changelog.path],
    }));
  }

  return { group: "About", pages };
}

function page(
  args: {
    docsDir: string;
    path: string;
    title: string;
    description: string;
    purpose: string;
    sources: string[];
  },
): PlannedPage {
  return {
    path: args.path,
    file: args.docsDir === "."
      ? `${args.path}.mdx`
      : joinPath(args.docsDir, `${args.path}.mdx`),
    title: args.title,
    description: args.description.slice(0, 160),
    purpose: args.purpose,
    sources: Array.from(new Set(args.sources)).slice(0, 10),
  };
}
