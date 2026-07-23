import type { RootState } from "../store.types";
import rootSelector from "./root.selector";

const getLayoutSelector = rootSelector.layoutSelector;

export const layoutSelector = {
  isSidebarOpen(state: RootState): boolean {
    return getLayoutSelector(state).isSidebarOpen;
  },
};
