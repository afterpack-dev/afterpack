import { index, type RouteConfig, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("notes", "routes/notes.tsx"),
  route("reports", "routes/reports.tsx"),
] satisfies RouteConfig;
