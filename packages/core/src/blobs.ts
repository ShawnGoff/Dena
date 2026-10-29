import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

/** Content-addressed storage for artifact bodies: <dir>/ab/abcdef...  Writes are idempotent. */
export class BlobStore {
  constructor(private readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }

  private pathFor(hash: string): string {
    return path.join(this.dir, hash.slice(0, 2), hash);
  }

  put(content: string | Buffer): { hash: string; size: number } {
    const buf = typeof content === "string" ? Buffer.from(content, "utf8") : content;
    const hash = sha256(buf);
    const p = this.pathFor(hash);
    if (!fs.existsSync(p)) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const tmp = `${p}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, p);
    }
    return { hash, size: buf.length };
  }

  get(hash: string): Buffer | null {
    const p = this.pathFor(hash);
    return fs.existsSync(p) ? fs.readFileSync(p) : null;
  }

  removeAll(): void {
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}
