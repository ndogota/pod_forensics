import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "pod_forensics",
  description:
    "Experimental agentic root cause analysis for Kubernetes failures, with a reproducible eval harness.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
