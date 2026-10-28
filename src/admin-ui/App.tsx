import { Component, type ReactNode } from "react";
import { Alert, ConfirmProvider, Empty, Page, ToastProvider, useHashRoute } from "./ui.js";
import { Dashboard } from "./views/dashboard.js";
import { Sessions, Settlements } from "./views/payments.js";
import { Addresses } from "./views/addresses.js";
import { Domains } from "./views/domains.js";
import { Rails, Solvers } from "./views/routing.js";
import { Quotes } from "./views/quotes.js";
import { ApiKeys, Blacklist } from "./views/access.js";
import { Settings } from "./views/settings.js";

interface Route { path: string; label: string; group: string; view: (query: URLSearchParams) => ReactNode }

const ROUTES: Route[] = [
  { path: "/", label: "Dashboard", group: "", view: () => <Dashboard /> },
  { path: "/settlements", label: "Settlements", group: "Payments", view: (q) => <Settlements query={q} /> },
  { path: "/sessions", label: "Sessions", group: "Payments", view: () => <Sessions /> },
  { path: "/addresses", label: "Addresses", group: "Receivers", view: (q) => <Addresses query={q} /> },
  { path: "/domains", label: "Domains", group: "Receivers", view: (q) => <Domains query={q} /> },
  { path: "/rails", label: "Rails", group: "Routing", view: () => <Rails /> },
  { path: "/solvers", label: "Solvers", group: "Routing", view: () => <Solvers /> },
  { path: "/quotes", label: "Quotes", group: "Routing", view: () => <Quotes /> },
  { path: "/api-keys", label: "API keys", group: "Access", view: () => <ApiKeys /> },
  { path: "/blacklist", label: "Blacklist", group: "Access", view: () => <Blacklist /> },
  { path: "/settings", label: "Settings", group: "System", view: () => <Settings /> },
];
const GROUPS = [...new Set(ROUTES.map((r) => r.group))];

/** Keeps one broken page from blanking the whole admin; keyed by route, so moving on resets it. */
class PageBoundary extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <Alert tone="bad" title="This page hit an error" action={<button type="button" className="btn btn-sm" onClick={() => location.reload()}>Reload</button>}>
        <p>{this.state.error.message}</p>
      </Alert>
    );
  }
}

export function App() {
  const { path, query } = useHashRoute();
  const route = ROUTES.find((r) => r.path === path);
  return (
    <ToastProvider>
      <ConfirmProvider>
        <div className="app">
          <aside className="sidebar">
            <a className="brand" href="#/">lnurl admin</a>
            <nav aria-label="Admin sections">
              {GROUPS.map((group) => (
                <div key={group} className="nav-section">
                  {group && <p className="nav-group">{group}</p>}
                  {ROUTES.filter((r) => r.group === group).map((r) => (
                    <a key={r.path} className="nav-link" href={`#${r.path}`} aria-current={r === route ? "page" : undefined}>{r.label}</a>
                  ))}
                </div>
              ))}
            </nav>
            <a className="sidebar-foot" href="/admin/api/docs" target="_blank" rel="noreferrer">API reference ↗</a>
          </aside>
          <main className="main" key={path}>
            <PageBoundary>
              {route ? route.view(query) : (
                <Page title="Page not found">
                  <Empty title={`Nothing lives at #${path}`} action={<a className="btn" href="#/">Go to the dashboard</a>}>
                    The link may be old. Pick a page from the menu.
                  </Empty>
                </Page>
              )}
            </PageBoundary>
          </main>
        </div>
      </ConfirmProvider>
    </ToastProvider>
  );
}
