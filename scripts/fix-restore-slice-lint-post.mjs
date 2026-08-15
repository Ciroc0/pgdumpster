import { readFile, rm, writeFile } from "node:fs/promises";

const pathname = "tests/unit/vector-storage-restore.test.ts";
let text = await readFile(pathname, "utf8");
for (const [before, after] of [
  ["  listBuckets(): Promise<unknown> {", "  listBuckets() {"],
  ["  getBucket(bucketName: string): Promise<unknown> {", "  getBucket(bucketName: string) {"],
  ["  createBucket(bucketName: string): Promise<unknown> {", "  createBucket(bucketName: string) {"],
  ["  deleteBucket(bucketName: string): Promise<unknown> {", "  deleteBucket(bucketName: string) {"],
]) {
  if (!text.includes(before)) throw new Error(`Expected codemod output not found: ${before}`);
  text = text.replace(before, after);
}
await writeFile(pathname, text, "utf8");
await rm(new URL(import.meta.url));
