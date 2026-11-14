import "leaflet/dist/leaflet.css";
import "./globals.css";

export const metadata = { title: "Roll Call Data Explorer", description: "Live map of the sponsor data layers" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
