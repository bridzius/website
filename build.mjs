import { watch } from "node:fs";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { startDevServer } from "./serve.mjs";

const sourceDirectory = "src";
const postsDirectory = "posts";
const outputDirectory = "dist";
const feedPath = "feed.xml";
const sitemapPath = "sitemap.xml";
const robotsPath = "robots.txt";
const staticFiles = ["style.css", "favicon.svg"];

const siteName = "bridzius.lt";
const siteUrl = "https://bridzius.lt";
const siteTagline = "opinions are my own";
const siteDescription = "Personal ramblings of Jurgis.";
const authorName = "Jurgis Bridžius";
const firstPublishedYear = 2022;

const author = {
  "@type": "Person",
  name: authorName,
  url: `${siteUrl}/`,
};

const devServerHost = "127.0.0.1";
const devServerPort = Number(process.env.PORT ?? 8080);

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

function renderDate(isoDate) {
  return `<time datetime="${isoDate}">${isoDate}</time>`;
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

  return { slug, body, metadata: { ...metadata, author, url } };
}

async function loadPosts() {
  const fileNames = await readdir(join(sourceDirectory, postsDirectory));
  const postFileNames = fileNames.filter((fileName) =>
    fileName.endsWith(".html"),
  );

  const posts = await Promise.all(postFileNames.map(loadPost));

  return posts.sort((first, second) => {
    const byDate = second.metadata.datePublished.localeCompare(
      first.metadata.datePublished,
    );

    if (byDate !== 0) return byDate;

    return first.slug.localeCompare(second.slug);
  });
}

function renderPostListItem(post) {
  const { headline, datePublished } = post.metadata;

  return `<li>
  <a href="/#${post.slug}">${escapeHtml(headline)}</a>
  ${renderDate(datePublished)}
</li>`;
}

function renderPostArticle(post) {
  const { headline, datePublished } = post.metadata;

  return `<article id="${post.slug}">
${indent(renderJsonLd(post.metadata), 2)}
  <header>
    <h2><a href="#${post.slug}">${escapeHtml(headline)}</a></h2>
    <p>${renderDate(datePublished)}</p>
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
  const postArticles = posts.map(renderPostArticle).join("\n\n");

  return replaceMarker(body, "post-articles", postArticles);
}

function insertLastUpdated(body, metadata, sourcePath) {
  const marker = "<!-- last-updated -->";

  if (!body.includes(marker)) return body;

  requireFields(metadata, ["dateModified"], sourcePath);

  return body.replaceAll(marker, renderDate(metadata.dateModified));
}

function renderPostsNavigation(posts) {
  const postList = posts.map(renderPostListItem).join("\n");

  return `<nav aria-label="Posts" id="posts">
  <h2>Posts</h2>
  <ol reversed>
${indent(postList, 4)}
  </ol>
</nav>`;
}

function lastUpdatedDate(post) {
  return post.metadata.dateModified ?? post.metadata.datePublished;
}

// A tag URI stays the same wherever the post ends up living. The year is
// when the site's domain was first used, not when the post was written.
function feedEntryId(post) {
  const domain = new URL(siteUrl).hostname;

  return `tag:${domain},${firstPublishedYear}:${post.slug}`;
}

function renderFeedEntry(post) {
  const { headline, datePublished, description, url } = post.metadata;

  const summaryElement = description
    ? `\n  <summary>${escapeHtml(description)}</summary>`
    : "";

  return `<entry>
  <title>${escapeHtml(headline)}</title>
  <id>${feedEntryId(post)}</id>
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

function renderSitemapEntry(page) {
  const lastModifiedElement = page.lastModified
    ? `\n  <lastmod>${page.lastModified}</lastmod>`
    : "";

  return `<url>
  <loc>${page.url}</loc>${lastModifiedElement}
</url>`;
}

function renderSitemap(pages) {
  const entries = pages.map(renderSitemapEntry).join("\n");

  return `<?xml version="1.0" encoding="utf-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${indent(entries, 2)}
</urlset>
`;
}

function renderRobots() {
  return `User-agent: *
Allow: /

Sitemap: ${siteUrl}/${sitemapPath}
`;
}

// A page's own dateModified, or for the page listing posts, its newest post.
function findLastModified(metadata, body, posts) {
  if (metadata.dateModified) return metadata.dateModified;

  if (!body.includes("<!-- post-articles -->")) return undefined;

  return posts.map(lastUpdatedDate).sort().at(-1);
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
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
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
  <nav aria-label="Elsewhere">
    <address>
      <ul>
${indent(elsewhereItems, 8)}
      </ul>
    </address>
  </nav>
  <p>
    <small>
      © ${firstPublishedYear}–${currentYear} ${authorName}. Text licensed under
      <a rel="license" href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>.
    </small>
  </p>
</footer>`;
}

function renderPage({ metadata, body, urlPath, posts }) {
  return `<!doctype html>
<html lang="en-GB">
${indent(renderHead(metadata, urlPath), 2)}
  <body>
    <a class="skip-link" href="#main">Skip to content</a>
${indent(renderSiteHeader(urlPath), 4)}
${indent(renderPostsNavigation(posts), 4)}
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
  const url = siteUrl + urlPath;
  const pageMetadata = { ...metadata, author, url };
  const lastModified = findLastModified(metadata, body, posts);

  const bodyWithPosts = insertPosts(body, posts);
  const fullBody = insertLastUpdated(bodyWithPosts, metadata, sourcePath);

  const outputPath = join(outputDirectory, sourcePath);

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(
    outputPath,
    renderPage({ metadata: pageMetadata, body: fullBody, urlPath, posts }),
  );

  return { outputPath, url, lastModified };
}

function isPagePath(sourcePath) {
  const isHtml = sourcePath.endsWith(".html");
  const isPost = sourcePath.startsWith(`${postsDirectory}/`);

  return isHtml && !isPost;
}

async function build() {
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });

  const posts = await loadPosts();

  const sourceFiles = await readdir(sourceDirectory, { recursive: true });
  const pagePaths = sourceFiles.filter(isPagePath);

  const pages = [];

  for (const pagePath of pagePaths) {
    const page = await buildPage(pagePath, posts);

    pages.push(page);
    console.log(`built ${page.outputPath}`);
  }

  const generatedFiles = [
    [feedPath, renderFeed(posts)],
    [sitemapPath, renderSitemap(pages)],
    [robotsPath, renderRobots()],
  ];

  for (const [fileName, contents] of generatedFiles) {
    await writeFile(join(outputDirectory, fileName), contents);
    console.log(`built ${join(outputDirectory, fileName)}`);
  }

  for (const fileName of staticFiles) {
    await cp(fileName, join(outputDirectory, fileName));
  }
}

const rebuildDelayInMilliseconds = 100;

const directoryWatchers = new Map();

let devServer;

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
    devServer.reload();
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
  devServer = startDevServer({
    rootDirectory: outputDirectory,
    host: devServerHost,
    port: devServerPort,
  });

  await rebuild();

  watch(".", (_eventType, fileName) => {
    if (!staticFiles.includes(fileName)) return;

    scheduleRebuild();
  });

  console.log("watching for changes");
}

if (process.argv.includes("--watch")) {
  await watchForChanges();
} else {
  await build();
}
