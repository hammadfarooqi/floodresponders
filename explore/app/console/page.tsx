"use client";
import dynamic from "next/dynamic";

const ConsoleView = dynamic(() => import("./ConsoleView"), { ssr: false });

export default function Page() {
  return <ConsoleView />;
}
