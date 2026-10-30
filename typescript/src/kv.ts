import { KVStore } from "fastly:kv-store";

import {
  Post,
  PostIndex,
  SidebarConfig,
  parseJsonSafe,
  rebuildIndex,
} from "./models.js";

const THIRTY_DAYS = 30 * 24 * 60 * 60;

const content = (): KVStore => new KVStore("content");

// Only a missing key is "absent". Every other failure (transport, parse)
// propagates so callers never derive state from a failed read.
async function readJson<T>(key: string): Promise<T | null> {
  const entry = await content().get(key);
  if (!entry) return null;
  const text = await entry.text();
  const parsed = parseJsonSafe(text);
  if (parsed === null) throw new Error(`corrupt JSON in KV key ${key}`);
  return parsed as T;
}

export async function readIndex(): Promise<PostIndex> {
  const idx = await readJson<PostIndex>("_index");
  return idx && Array.isArray(idx.posts) ? idx : { posts: [] };
}

export async function readSidebar(): Promise<SidebarConfig> {
  const sb = await readJson<SidebarConfig>("_sidebar");
  return sb && Array.isArray(sb.items) ? sb : { items: [] };
}

export function readPost(slug: string): Promise<Post | null> {
  return readJson<Post>(`post:${slug}`);
}

export async function postExists(slug: string): Promise<boolean> {
  return (await content().get(`post:${slug}`)) !== null;
}

export async function writePost(post: Post): Promise<void> {
  await content().put(`post:${post.slug}`, JSON.stringify(post));
}

export async function deletePostKey(slug: string): Promise<void> {
  await content().delete(`post:${slug}`);
}

// The SDK accepts `gen` for if-generation-match, but KVStoreEntry exposes no
// generation to read back, so a conditional write cannot be built. Plain insert.
export async function writeIndex(index: PostIndex): Promise<void> {
  await content().put("_index", JSON.stringify(index));
}

export async function writeSidebar(sidebar: SidebarConfig): Promise<void> {
  await content().put("_sidebar", JSON.stringify(sidebar));
}

export async function writeRevision(post: Post, unixTs: number): Promise<void> {
  await content().put(`rev:${post.slug}:${unixTs}`, JSON.stringify(post), {
    ttl: THIRTY_DAYS,
  });
}

export async function writeTrash(post: Post): Promise<void> {
  await content().put(`trash:${post.slug}`, JSON.stringify(post), {
    ttl: THIRTY_DAYS,
  });
}

export async function isSessionRevoked(nonce: string): Promise<boolean> {
  return (await content().get(`session-revoked:${nonce}`)) !== null;
}

export async function revokeSession(nonce: string, expires: number, now: number): Promise<void> {
  const ttl = Math.max(expires - now, 1);
  await content().put(`session-revoked:${nonce}`, String(expires), { ttl });
}

export async function rebuildIndexFromPosts(): Promise<PostIndex> {
  const store = content();
  const posts: Post[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.list({ prefix: "post:", cursor, noSync: false });
    for (const key of page.list) {
      const post = await readJson<Post>(key);
      if (post) posts.push(post);
    }
    cursor = page.cursor;
  } while (cursor);
  return rebuildIndex(posts);
}
