import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const secretPath = path.join(projectRoot, "secrets.local.json");

const page = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Codex Trades — Local token setup</title>
<style>
body{font:16px system-ui;max-width:680px;margin:60px auto;padding:0 24px;color:#1f2937}
main{border:1px solid #d1d5db;border-radius:14px;padding:28px;box-shadow:0 8px 30px #0001}
input,button{box-sizing:border-box;width:100%;padding:12px;margin-top:10px;font:inherit}
button{background:#111827;color:white;border:0;border-radius:8px;cursor:pointer}
small{color:#4b5563}
</style>
<main>
<h1>Save Deriv demo token locally</h1>
<p>This one-time page stores the PAT only in <code>secrets.local.json</code>, which is excluded from Git.</p>
<form method="post" action="/save">
<label>Trade-scoped PAT<input name="pat" type="password" autocomplete="off" required minlength="20" maxlength="512"></label>
<button type="submit">Save token locally</button>
</form>
<p><small>The bot still rejects real-money endpoints and execution remains disabled.</small></p>
</main>`;

const server = createServer(async (request, response) => {
  response.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'");
  response.setHeader("Cache-Control", "no-store");

  if (request.method === "GET" && request.url === "/") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(page);
    return;
  }

  if (request.method === "POST" && request.url === "/save") {
    let body = "";
    for await (const chunk of request) {
      body += chunk;
      if (body.length > 4096) {
        response.writeHead(413).end("Request too large");
        return;
      }
    }

    const pat = new URLSearchParams(body).get("pat")?.trim() ?? "";
    if (pat.length < 20 || pat.length > 512 || /\s/.test(pat)) {
      response.writeHead(400).end("Invalid token format");
      return;
    }

    await writeFile(secretPath, `${JSON.stringify({ pat }, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end("<h1>Saved locally</h1><p>You can close this tab.</p>");
    setTimeout(() => server.close(), 250);
    return;
  }

  response.writeHead(404).end("Not found");
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  console.log(`Local token setup: http://127.0.0.1:${address.port}/`);
});
