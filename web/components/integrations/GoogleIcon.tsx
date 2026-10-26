import type { SVGProps } from "react";

/** Monochrome outline "G" drawn on the lucide grid so it matches the other header icons. */
export function GoogleIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M18.36 5.64A9 9 0 1 0 21 12h-9" />
    </svg>
  );
}
