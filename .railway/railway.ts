// Railway Infrastructure as Code. Replaces the deprecated railway.json, which
// stops working on 2026-12-01.
//
// The build is not declared here: Railway uses the Dockerfile at the repository
// root when one is present, and the IaC DSL has no builder option to override
// that with. The restart policy is likewise Railway's own default (restart on
// failure), which is what the old config asked for anyway.
//
// Nothing needs configuring at deploy time. Energi Data Service is open data,
// so there are no secrets, and BASE_URL is detected from RAILWAY_PUBLIC_DOMAIN.
import { defineRailway, project, service } from "railway/iac";

export const partial = "energimcp";

export default defineRailway(() => {
  const energimcp = service("energimcp", {
    healthcheck: "/healthz",
    healthcheckTimeout: 60,
    replicas: 1,
  });
  return project("energimcp", {
    resources: [energimcp],
  });
});
