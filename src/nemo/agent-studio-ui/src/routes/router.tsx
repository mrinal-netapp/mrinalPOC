import { createBrowserRouter } from "react-router";
import { getRouterBasename } from "@/consts/app-base-path";
import { routes } from "./routes";

export const router = createBrowserRouter(routes, {
  basename: getRouterBasename(),
});
