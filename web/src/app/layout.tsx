import type { Metadata } from "next";
import type { ReactNode } from "react";
import "cesium/Build/Cesium/Widgets/widgets.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Roll Call",
  description: "Building evacuation priorities for fire and flood response.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
