import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, resolve, sep } from "node:path";

const reloadPath = "/__reload";

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

// Reloads on a "reload" event, and also once the connection comes back after
// the server restarts (node --watch restarts it when build.mjs changes).
const reloadScript = `<script>
  (() => {
    let wasDisconnected = false;
    const events = new EventSource("${reloadPath}");

    events.addEventListener("reload", () => location.reload());
    events.addEventListener("error", () => (wasDisconnected = true));
    events.addEventListener("open", () => {
      if (wasDisconnected) location.reload();
    });
  })();
</script>`;

function injectReloadScript(html) {
  if (!html.includes("</body>")) return html + reloadScript;

  return html.replace("</body>", `${reloadScript}\n</body>`);
}

function sendText(response, statusCode, text) {
  response.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
  });

  response.end(text);
}

function openReloadStream(request, response, reloadClients) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });

  // Retry quickly while the server restarts.
  response.write("retry: 500\n\n");

  reloadClients.add(response);
  request.on("close", () => reloadClients.delete(response));
}

// Returns null for paths outside the root, so "/../" cannot escape it.
function resolveInsideRoot(rootPath, urlPath) {
  const filePath = resolve(rootPath, `.${urlPath}`);
  const isInsideRoot =
    filePath === rootPath || filePath.startsWith(rootPath + sep);

  return isInsideRoot ? filePath : null;
}

async function serveFile(request, response, rootPath) {
  const { pathname } = new URL(request.url, "http://localhost");

  let urlPath;

  try {
    urlPath = decodeURIComponent(pathname);
  } catch {
    return sendText(response, 400, "Bad request");
  }

  const requestedPath = resolveInsideRoot(rootPath, urlPath);

  if (!requestedPath) return sendText(response, 403, "Forbidden");

  const stats = await stat(requestedPath).catch(() => null);

  if (!stats) return sendText(response, 404, "Not found");

  // "/things" → "/things/", so relative links on that page resolve correctly.
  if (stats.isDirectory() && !pathname.endsWith("/")) {
    response.writeHead(301, { location: `${pathname}/` });
    return response.end();
  }

  const filePath = stats.isDirectory()
    ? join(requestedPath, "index.html")
    : requestedPath;

  const contents = await readFile(filePath).catch(() => null);

  if (!contents) return sendText(response, 404, "Not found");

  const extension = extname(filePath);
  const contentType = contentTypes[extension] ?? "application/octet-stream";

  const body =
    extension === ".html"
      ? injectReloadScript(contents.toString("utf8"))
      : contents;

  response.writeHead(200, {
    "content-type": contentType,
    "cache-control": "no-store",
  });

  response.end(body);
}

export function startDevServer({ rootDirectory, host, port }) {
  const rootPath = resolve(rootDirectory);
  const reloadClients = new Set();

  const server = createServer((request, response) => {
    if (request.url === reloadPath) {
      return openReloadStream(request, response, reloadClients);
    }

    serveFile(request, response, rootPath).catch((error) => {
      console.error(`serving ${request.url} failed: ${error.message}`);
      sendText(response, 500, "Internal server error");
    });
  });

  server.on("error", (error) => {
    if (error.code !== "EADDRINUSE") throw error;

    console.error(
      `port ${port} is in use; run with PORT=<number> to pick another`,
    );
    process.exit(1);
  });

  server.listen(port, host, () => {
    console.log(`serving ${rootDirectory} at http://${host}:${port}/`);
  });

  return {
    reload() {
      for (const client of reloadClients) {
        client.write("event: reload\ndata: \n\n");
      }
    },
  };
}
