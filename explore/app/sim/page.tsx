"use client";
import dynamic from "next/dynamic";

const SimView = dynamic(() => import("./SimView"), { ssr: false });

export default function Page() {
  return <SimView />;
}
