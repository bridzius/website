import { watch } from "node:fs";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const sourceDirectory = "src";
const postsDirectory = "posts";
const outputDirectory = "dist";
const feedPath = "feed.xml";

const siteName = "bridzius.lt";
const siteUrl = "https://bridzius.lt";
const siteTagline = "opinions are my own";
const siteDescription = "Personal ramblings of Jurgis.";
const authorName = "Jurgis Bridžius";
const firstPublishedYear = 2022;

const navigationLinks = [
  { href: "/", label: "blog" },
  { href: "/things/", label: "things" },
];

const elsewhereLinks = [
  { href: "https://github.com/bridzius", label: "GitHub", rel: "me" },
  { href: "https://fosstodon.org/@bridzius", label: "Fosstodon", rel: "me" },
  {
    href: "https://www.linkedin.com/in/bridzius",
    label: "LinkedIn",
    rel: "me",
  },
  { href: `/${feedPath}`, label: "RSS" },
];

const jsonLdPattern =
  /<script type="application\/ld\+json">([\s\S]*?)<\/script>/;

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function indent(text, spaces) {
  const padding = " ".repeat(spaces);

  return text
    .split("\n")
    .map((line) => (line ? padding + line : line))
    .join("\n");
}

// src/things/index.html → "/things/"
function toUrlPath(sourcePath) {
  return "/" + sourcePath.replace(/index\.html$/, "");
}

function findActiveSection(urlPath) {
  const sections = navigationLinks.filter((link) => link.href !== "/");
  const match = sections.find((link) => urlPath.startsWith(link.href));

  return match ? match.href : "/";
}

function ariaCurrentFor(link, urlPath) {
  if (link.href === urlPath) return ` aria-current="page"`;

  if (link.href === findActiveSection(urlPath)) return ` aria-current="true"`;

  return "";
}

function extractMetadata(source, sourcePath) {
  const match = source.match(jsonLdPattern);

  if (!match) {
    throw new Error(`${sourcePath}: missing application/ld+json block`);
  }

  let metadata;

  try {
    metadata = JSON.parse(match[1]);
  } catch (error) {
    throw new Error(`${sourcePath}: invalid JSON-LD (${error.message})`);
  }

  const body = source.replace(match[0], "").trim();

  return { metadata, body };
}

function requireFields(metadata, fieldNames, sourcePath) {
  const missingFields = fieldNames.filter((fieldName) => !metadata[fieldName]);

  if (missingFields.length === 0) return;

  const quotedFields = missingFields.map((fieldName) => `"${fieldName}"`);

  throw new Error(
    `${sourcePath}: JSON-LD is missing ${quotedFields.join(", ")}`,
  );
}

// "2022-10-06" → "October 6th, 2022"
function formatLongDate(isoDate) {
  const date = new Date(isoDate);
  const day = date.getUTCDate();
  const month = date.toLocaleString("en-GB", {
    month: "long",
    timeZone: "UTC",
  });

  const isTeen = day >= 11 && day <= 13;
  const suffixes = { 1: "st", 2: "nd", 3: "rd" };
  const suffix = isTeen ? "th" : (suffixes[day % 10] ?? "th");

  return `${month} ${day}${suffix}, ${date.getUTCFullYear()}`;
}

// "2022-10-06" → "2022-10-06T00:00:00.000Z" (RFC 3339, as Atom requires)
function toAtomTimestamp(isoDate) {
  return new Date(isoDate).toISOString();
}

async function loadPost(fileName) {
  const sourcePath = join(postsDirectory, fileName);
  const source = await readFile(join(sourceDirectory, sourcePath), "utf8");
  const { metadata, body } = extractMetadata(source, sourcePath);

  requireFields(metadata, ["headline", "datePublished"], sourcePath);

  const slug = basename(fileName, ".html");
  const url = `${siteUrl}/#${slug}`;

  return { slug, body, metadata: { ...metadata, url } };
}

async function loadPosts() {
  const fileNames = await readdir(join(sourceDirectory, postsDirectory));
  const postFileNames = fileNames.filter((fileName) =>
    fileName.endsWith(".html"),
  );

  const posts = await Promise.all(postFileNames.map(loadPost));

  return posts.sort((first, second) =>
    second.metadata.datePublished.localeCompare(first.metadata.datePublished),
  );
}

function renderPostListItem(post) {
  const { headline, datePublished } = post.metadata;

  return `<li>
  <a href="#${post.slug}">${escapeHtml(headline)}</a>
  <time datetime="${datePublished}">${datePublished}</time>
</li>`;
}

function renderPostArticle(post) {
  const { headline, datePublished } = post.metadata;

  return `<article id="${post.slug}">
${indent(renderJsonLd(post.metadata), 2)}
  <header>
    <h2><a href="#${post.slug}">${escapeHtml(headline)}</a></h2>
    <p><time datetime="${datePublished}">${formatLongDate(datePublished)}</time></p>
  </header>
${indent(post.body, 2)}
  <footer><a href="#posts">Back to posts</a></footer>
</article>`;
}

// Replaces a marker comment, keeping the indentation of the line it sits on.
function replaceMarker(body, markerName, content) {
  const markerPattern = new RegExp(`^( *)<!-- ${markerName} -->$`, "m");

  return body.replace(markerPattern, (_line, padding) =>
    indent(content, padding.length),
  );
}

function insertPosts(body, posts) {
  const postList = posts.map(renderPostListItem).join("\n");
  const postArticles = posts.map(renderPostArticle).join("\n\n");

  const bodyWithList = replaceMarker(body, "post-list", postList);

  return replaceMarker(bodyWithList, "post-articles", postArticles);
}

function lastUpdatedDate(post) {
  return post.metadata.dateModified ?? post.metadata.datePublished;
}

function renderFeedEntry(post) {
  const { headline, datePublished, description, url } = post.metadata;

  const summaryElement = description
    ? `\n  <summary>${escapeHtml(description)}</summary>`
    : "";

  return `<entry>
  <title>${escapeHtml(headline)}</title>
  <id>${url}</id>
  <link href="${url}" />
  <published>${toAtomTimestamp(datePublished)}</published>
  <updated>${toAtomTimestamp(lastUpdatedDate(post))}</updated>${summaryElement}
  <content type="html">${escapeHtml(post.body)}</content>
</entry>`;
}

function renderFeed(posts) {
  const updatedDates = posts.map(lastUpdatedDate).sort();
  const feedUpdated = updatedDates.at(-1) ?? new Date().toISOString();

  const feedEntries = posts.map(renderFeedEntry).join("\n");

  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="en-GB" xml:base="${siteUrl}/">
  <title>${siteName}</title>
  <subtitle>${escapeHtml(siteDescription)}</subtitle>
  <id>${siteUrl}/</id>
  <link href="${siteUrl}/" />
  <link rel="self" type="application/atom+xml" href="${siteUrl}/${feedPath}" />
  <updated>${toAtomTimestamp(feedUpdated)}</updated>
  <author><name>${authorName}</name></author>
${indent(feedEntries, 2)}
</feed>
`;
}

function renderJsonLd(metadata) {
  const json = JSON.stringify(metadata, null, 2).replaceAll("</", "<\\/");

  return `<script type="application/ld+json">\n${indent(json, 2)}\n</script>`;
}

function renderHead(metadata, urlPath) {
  const isHomePage = urlPath === "/";
  const pageTitle = isHomePage ? siteName : `${siteName} - ${metadata.name}`;
  const description = escapeHtml(metadata.description ?? "");

  return `<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(pageTitle)}</title>
  <meta name="description" content="${description}" />
  <meta name="author" content="${authorName}" />
  <meta name="color-scheme" content="light dark" />
  <link rel="canonical" href="${metadata.url}" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="${siteName}" />
  <meta property="og:title" content="${escapeHtml(metadata.name)}" />
  <meta property="og:description" content="${description}" />
  <meta property="og:url" content="${metadata.url}" />
  <meta property="og:locale" content="en_GB" />
  <link rel="stylesheet" href="/style.css" />
  <link rel="alternate" type="application/atom+xml" title="Feed" href="/${feedPath}" />
${indent(renderJsonLd(metadata), 2)}
</head>`;
}

function renderSiteHeader(urlPath) {
  const navigationItems = navigationLinks
    .map((link) => {
      const ariaCurrent = ariaCurrentFor(link, urlPath);

      return `<li><a href="${link.href}"${ariaCurrent}>${link.label}</a></li>`;
    })
    .join("\n");

  return `<header>
  <hgroup>
    <h1><a href="/">${siteName}</a></h1>
    <p>${siteTagline}</p>
  </hgroup>
  <nav aria-label="Site">
    <ul>
${indent(navigationItems, 6)}
    </ul>
  </nav>
</header>`;
}

function renderSiteFooter() {
  const currentYear = new Date().getFullYear();

  const elsewhereItems = elsewhereLinks
    .map((link) => {
      const rel = link.rel ? ` rel="${link.rel}"` : "";

      return `<li><a${rel} href="${link.href}">${link.label}</a></li>`;
    })
    .join("\n");

  return `<footer>
  <address>
    <nav aria-label="Elsewhere">
      <ul>
${indent(elsewhereItems, 8)}
      </ul>
    </nav>
  </address>
  <p>
    <small>
      © ${firstPublishedYear}–${currentYear} ${authorName}. Text licensed under
      <a rel="license" href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>.
    </small>
  </p>
</footer>`;
}

function renderPage({ metadata, body, urlPath }) {
  return `<!doctype html>
<html lang="en-GB">
${indent(renderHead(metadata, urlPath), 2)}
  <body>
    <a class="skip-link" href="#main">Skip to content</a>
${indent(renderSiteHeader(urlPath), 4)}
${indent(body, 4)}
${indent(renderSiteFooter(), 4)}
  </body>
</html>
`;
}

async function buildPage(sourcePath, posts) {
  const source = await readFile(join(sourceDirectory, sourcePath), "utf8");
  const { metadata, body } = extractMetadata(source, sourcePath);

  requireFields(metadata, ["name"], sourcePath);

  const urlPath = toUrlPath(sourcePath);
  const pageMetadata = { ...metadata, url: siteUrl + urlPath };
  const bodyWithPosts = insertPosts(body, posts);

  const outputPath = join(outputDirectory, sourcePath);

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(
    outputPath,
    renderPage({ metadata: pageMetadata, body: bodyWithPosts, urlPath }),
  );

  return outputPath;
}

function isPagePath(sourcePath) {
  const isHtml = sourcePath.endsWith(".html");
  const isPost = sourcePath.startsWith(`${postsDirectory}/`);

  return isHtml && !isPost;
}

// Empties rather than deletes the directory, so live-server keeps watching it.
async function clearOutputDirectory() {
  await mkdir(outputDirectory, { recursive: true });

  const entries = await readdir(outputDirectory);
  const removals = entries.map((entry) =>
    rm(join(outputDirectory, entry), { recursive: true, force: true }),
  );

  await Promise.all(removals);
}

async function build() {
  await clearOutputDirectory();

  const posts = await loadPosts();

  const sourceFiles = await readdir(sourceDirectory, { recursive: true });
  const pagePaths = sourceFiles.filter(isPagePath);

  for (const pagePath of pagePaths) {
    const outputPath = await buildPage(pagePath, posts);
    console.log(`built ${outputPath}`);
  }

  const feedOutputPath = join(outputDirectory, feedPath);

  await writeFile(feedOutputPath, renderFeed(posts));
  console.log(`built ${feedOutputPath}`);

  await cp("style.css", join(outputDirectory, "style.css"));
}

const rebuildDelayInMilliseconds = 100;
const watchedRootFiles = ["style.css"];

const directoryWatchers = new Map();

let rebuildTimer;
let isBuilding = false;
let hasPendingChanges = false;

async function listSourceDirectories() {
  const entries = await readdir(sourceDirectory, {
    recursive: true,
    withFileTypes: true,
  });

  const subdirectories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(entry.parentPath, entry.name));

  return [sourceDirectory, ...subdirectories];
}

// Watches each directory on its own, because Node's recursive watcher on
// Linux stops noticing a file once an editor has saved it by replacing it.
async function watchSourceDirectories() {
  const directories = await listSourceDirectories();

  for (const directory of directories) {
    if (directoryWatchers.has(directory)) continue;

    const watcher = watch(directory, scheduleRebuild);

    watcher.on("error", () => {
      watcher.close();
      directoryWatchers.delete(directory);
    });

    directoryWatchers.set(directory, watcher);
  }
}

function scheduleRebuild() {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(rebuild, rebuildDelayInMilliseconds);
}

async function rebuild() {
  if (isBuilding) {
    hasPendingChanges = true;
    return;
  }

  isBuilding = true;

  try {
    await build();
  } catch (error) {
    console.error(`build failed: ${error.message}`);
  }

  // Picks up directories created since the last build.
  await watchSourceDirectories();

  isBuilding = false;

  if (!hasPendingChanges) return;

  hasPendingChanges = false;
  scheduleRebuild();
}

async function watchForChanges() {
  await rebuild();

  watch(".", (_eventType, fileName) => {
    if (!watchedRootFiles.includes(fileName)) return;

    scheduleRebuild();
  });

  console.log("watching for changes");
}

if (process.argv.includes("--watch")) {
  await watchForChanges();
} else {
  await build();
}
