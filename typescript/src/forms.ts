export function safeDecode(input: string): string {
  const spaced = input.replace(/\+/g, " ");
  try {
    return decodeURIComponent(spaced);
  } catch {
    return spaced.replace(/(?:%[0-9a-fA-F]{2})+/g, (run) => {
      try {
        return decodeURIComponent(run);
      } catch {
        return run;
      }
    });
  }
}

export function parseFormBody(body: string): Record<string, string> {
  const params: Record<string, string> = Object.create(null);
  for (const pair of body.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const key = safeDecode(pair.slice(0, eq));
    params[key] = safeDecode(pair.slice(eq + 1));
  }
  return params;
}

export function parseQuery(search: string): Record<string, string> {
  return parseFormBody(search.startsWith("?") ? search.slice(1) : search);
}
