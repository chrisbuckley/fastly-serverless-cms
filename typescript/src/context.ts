export interface RequestContext {
  method: string;
  path: string;
  siteUrl: string;
  clientIp: string;
  trusted: boolean;
}

// A Compute instance serves exactly one request, so module state is safe here.
let current: RequestContext = {
  method: "",
  path: "/",
  siteUrl: "",
  clientIp: "",
  trusted: false,
};

export function setContext(ctx: RequestContext): void {
  current = ctx;
}

export function getContext(): RequestContext {
  return current;
}
