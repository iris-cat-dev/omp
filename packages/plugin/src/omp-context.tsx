import type { OmpApi } from "@omp-desktop/client";
import { createContext, useContext, type ReactNode } from "react";

const OmpApiContext = createContext<OmpApi | null>(null);

export function OmpApiProvider({ children, omp }: { children: ReactNode; omp: OmpApi }) {
  return <OmpApiContext.Provider value={omp}>{children}</OmpApiContext.Provider>;
}

export function useOmp(): OmpApi {
  const omp = useContext(OmpApiContext);
  if (!omp) throw new Error("useOmp must run inside a contributed plugin surface");
  return omp;
}
