"use client";
import dynamic from "next/dynamic";

const Map3D = dynamic(() => import("./Map3D"), { ssr: false });

export default function Page() {
  return <Map3D />;
}
