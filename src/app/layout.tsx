import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Visual University Profile",
  description: "A visual research profile for a university.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
