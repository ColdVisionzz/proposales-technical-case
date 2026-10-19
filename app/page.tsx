import { Suspense } from "react";
import { Dashboard } from "./components/Dashboard";

// The page itself is static. The dashboard polls its data in the browser; Suspense is required because it reads the URL (?id=).
export default function Home() {
  return (
    <Suspense fallback={<main className="mx-auto w-full max-w-6xl flex-1 px-4 pt-12 md:px-8" aria-busy="true" />}>
      <Dashboard />
    </Suspense>
  );
}
