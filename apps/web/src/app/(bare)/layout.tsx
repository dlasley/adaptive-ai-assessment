import type { Metadata } from "next";
import "../globals.css";
import { getCourse } from "@adaptive/shared/course";

export const metadata: Metadata = {
  title: getCourse().title,
  robots: { index: false, follow: false },
  description: "",
};

/** Root layout for pages served without the site header and navigation, such as /challenge. */
export default function BareLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
