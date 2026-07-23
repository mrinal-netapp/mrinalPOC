import { useContext } from "react";

import { AuthContext } from "../model/context";
import type { AuthContextValue } from "../model/auth.types";

function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (ctx == null) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return ctx;
}

export { useAuth };
