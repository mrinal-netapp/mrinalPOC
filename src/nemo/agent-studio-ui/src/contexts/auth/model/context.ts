import { createContext, type Context } from "react";

import type { AuthContextValue } from "./auth.types";

const AuthContext: Context<AuthContextValue | null> = createContext<AuthContextValue | null>(null);

export { AuthContext };
