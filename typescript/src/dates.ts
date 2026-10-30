const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const pad = (n: number): string => String(n).padStart(2, "0");

export function nowISO8601(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function rfc822(iso: string): string {
  let d = new Date(iso);
  if (isNaN(d.getTime())) d = new Date(0);
  return (
    `${DAYS[d.getUTCDay()]}, ${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ` +
    `${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:` +
    `${pad(d.getUTCSeconds())} +0000`
  );
}
