import { Router } from "express";
import { openApiSpec } from "../openapi.js";

const DOCS_HTML = `<!DOCTYPE html>
<html>
<head>
  <title>LNURL Server - API Docs</title>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>body { margin: 0; }</style>
</head>
<body>
  <div id="redoc-container"></div>
  <script src="https://cdn.redoc.ly/redoc/latest/bundles/redoc.standalone.js"></script>
  <script>
    Redoc.init(${JSON.stringify(openApiSpec)}, {
      scrollYOffset: 0,
      hideDownloadButton: true,
    }, document.getElementById('redoc-container'));
  </script>
</body>
</html>`;

/** Redocly API docs as the home page, plus the raw spec. */
export function docsRoutes(): Router {
  const r = Router();
  r.get("/", (_req, res) => { res.send(DOCS_HTML); });
  r.get("/openapi.json", (_req, res) => { res.json(openApiSpec); });
  return r;
}
