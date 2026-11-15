"use client";
import dynamic from "next/dynamic";

const RiskView = dynamic(() => import("./RiskView"), { ssr: false });

export default function Page() {
  return <RiskView />;
}
