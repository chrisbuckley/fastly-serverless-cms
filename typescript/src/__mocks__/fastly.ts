const kvData = new Map<string, string>();
const secretData = new Map<string, string>();
const configData = new Map<string, string>();
const envData = new Map<string, string>();
export const loggedLines: unknown[] = [];

export function resetMocks(): void {
  kvData.clear();
  secretData.clear();
  configData.clear();
  envData.clear();
  loggedLines.length = 0;
}

export function seedKv(key: string, value: string): void {
  kvData.set(key, value);
}
export function readKv(key: string): string | undefined {
  return kvData.get(key);
}
export function seedSecret(key: string, value: string): void {
  secretData.set(key, value);
}
export function seedConfig(key: string, value: string): void {
  configData.set(key, value);
}
export function seedEnv(key: string, value: string): void {
  envData.set(key, value);
}

class MockEntry {
  constructor(private readonly value: string) {}
  async text(): Promise<string> {
    return this.value;
  }
  async arrayBuffer(): Promise<ArrayBuffer> {
    return new TextEncoder().encode(this.value).buffer as ArrayBuffer;
  }
}

export class KVStore {
  constructor(_name: string) {}
  async get(key: string): Promise<MockEntry | null> {
    const v = kvData.get(key);
    return v === undefined ? null : new MockEntry(v);
  }
  async put(key: string, value: string): Promise<undefined> {
    kvData.set(key, String(value));
    return undefined;
  }
  async delete(key: string): Promise<undefined> {
    kvData.delete(key);
    return undefined;
  }
  async list(options?: {
    prefix?: string;
  }): Promise<{ list: string[]; cursor: string | undefined }> {
    const prefix = options?.prefix ?? "";
    return {
      list: [...kvData.keys()].filter((k) => k.startsWith(prefix)),
      cursor: undefined,
    };
  }
}

export class SecretStore {
  constructor(_name: string) {}
  async get(key: string): Promise<{ plaintext(): string } | null> {
    const v = secretData.get(key);
    return v === undefined ? null : { plaintext: () => v };
  }
}

export class ConfigStore {
  constructor(_name: string) {}
  get(key: string): string | null {
    return configData.get(key) ?? null;
  }
}

export function env(name: string): string {
  return envData.get(name) ?? "";
}

export function getGeolocationForIpAddress(_ip: string): { city: string } {
  return { city: "Testville" };
}

export class Logger {
  constructor(_name: string) {}
  log(message: unknown): void {
    loggedLines.push(message);
  }
}

export class RateCounter {
  constructor(_name: string) {}
}

export class PenaltyBox {
  private readonly entries = new Set<string>();
  constructor(_name: string) {}
  add(entry: string, _ttl: number): void {
    this.entries.add(entry);
  }
  has(entry: string): boolean {
    return this.entries.has(entry);
  }
}

export class EdgeRateLimiter {
  private readonly counts = new Map<string, number>();
  constructor(_rc: RateCounter, _pb: PenaltyBox) {}
  checkRate(entry: string, delta: number, _w: number, limit: number): boolean {
    const n = (this.counts.get(entry) ?? 0) + delta;
    this.counts.set(entry, n);
    return n > limit;
  }
}
