import { Router } from "express";
import { adminOpenApiSpec } from "../../admin-openapi.js";

const ADMIN_DOCS_HTML = `<!DOCTYPE html>
<html>
<head>
  <title>LNURL Server - Admin API Docs</title>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>body { margin: 0; }</style>
</head>
<body>
  <div id="redoc-container"></div>
  <script src="https://cdn.redoc.ly/redoc/latest/bundles/redoc.standalone.js"></script>
  <script>
    Redoc.init(${JSON.stringify(adminOpenApiSpec)}, {
      scrollYOffset: 0,
      hideDownloadButton: true,
    }, document.getElementById('redoc-container'));
  </script>
</body>
</html>`;

/** Served under /admin/api so they sit behind the same auth proxy and don't
 *  collide with the SPA's catch-all (which serves index.html for non-/admin/api GETs). */
export function adminDocsRoutes(): Router {
  const r = Router();
  r.get("/openapi.json", (_req, res) => res.json(adminOpenApiSpec));
  r.get("/docs", (_req, res) => res.type("html").send(ADMIN_DOCS_HTML));
  return r;
}
